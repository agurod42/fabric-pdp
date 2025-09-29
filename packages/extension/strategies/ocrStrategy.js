// strategies/ocrStrategy.js — OCR-based strategy
// Flow:
// 1) Capture full-page screenshot via html2canvas
// 2) Send image and page metrics to backend OCR endpoint
// 3) Map detection bounding boxes back to DOM selectors
// 4) Build fields and patch with safe operations

/** Resolve a plan via OCR + detection-to-selector mapping. */
async function resolveViaOCR(payload, ctx) {
  const planBase = { source: "ocrStrategy", url: payload?.url };
  const tabId = ctx?.tabId;
  if (typeof tabId !== 'number') {
    return { ...planBase, is_pdp: false, patch: [], fields: {}, warnings: ["No tabId for OCR"] };
  }

  const t0 = Date.now();
  try { log("[OCR] start", { url: payload?.url, tabId }); } catch {}
  let capture = null;
  try {
    capture = await captureFullPage(tabId);
  } catch (e) {
    log("[OCR] capture error", String(e?.message || e));
    return { ...planBase, is_pdp: false, patch: [], fields: {}, warnings: ["Screenshot capture failed"] };
  }
  if (!capture || typeof capture.dataUrl !== 'string' || !capture.dataUrl) {
    return { ...planBase, is_pdp: false, patch: [], fields: {}, warnings: ["Empty screenshot"] };
  }

  let detections = [];
  let imageMeta = capture.meta || {};
  // Do not download the captured image; only log metadata for debugging
  try {
    const len = capture.dataUrl.length;
    log("[OCR] capture ok", {
      took_ms: Date.now() - t0,
      data_len: len,
      meta: {
        w: imageMeta?.image_pixel_width,
        h: imageMeta?.image_pixel_height,
        dpr: imageMeta?.device_pixel_ratio,
        page_w_css: imageMeta?.page_width_css,
        page_h_css: imageMeta?.page_height_css,
      }
    });
  } catch {}
  try {
    const traceId = makeTraceId ? makeTraceId() : `pdp-${Date.now().toString(16)}`;
    const body = JSON.stringify({
      url: payload?.url || "",
      language: payload?.language || "",
      trace_id: traceId,
      image_data_url: capture.dataUrl,
      image_pixel_width: imageMeta.image_pixel_width,
      image_pixel_height: imageMeta.image_pixel_height,
      device_pixel_ratio: imageMeta.device_pixel_ratio,
      page_width_css: imageMeta.page_width_css,
      page_height_css: imageMeta.page_height_css,
    });
    log("[OCR] backend fetch →", { traceId, bytes: body.length });
    const resp = await fetch(PROXY_OCR_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-trace-id': traceId }, body });
    const text = await resp.text();
    log("[OCR] backend ←", { status: resp.status, ok: resp.ok, bytes: text.length });
    const obj = JSON.parse(text);
    if (obj && Array.isArray(obj.detections)) {
      detections = obj.detections;
    } else {
      throw new Error(String(obj?.error || 'Invalid OCR response'));
    }
  } catch (e) {
    log("[OCR] backend error", String(e?.message || e));
    return { ...planBase, is_pdp: false, patch: [], fields: {}, warnings: ["OCR backend error"] };
  }

  // Map detections (image pixel boxes) to DOM selectors inside the page
  let selectorMap = {};
  try {
    const results = await api.scripting.executeScript({ target: { tabId }, func: selectorsFromDetections, args: [detections, imageMeta] });
    selectorMap = Array.isArray(results) ? (results[0]?.result || {}) : {};
    try { log("[OCR] selector mapping", { detections: detections.length, mapped: Object.keys(selectorMap || {}).length }); } catch {}
  } catch (e) {
    log("[OCR] selector mapping error", String(e?.message || e));
  }

  // Aggregate proposed values per type from detections
  const proposedByType = {};
  for (const d of detections) {
    const t = d?.type;
    if (!t || typeof t !== 'string') continue;
    const p = typeof d?.proposed === 'string' ? d.proposed : '';
    // Keep the longest non-empty proposal for html fields; shortest for title
    if (!proposedByType[t]) proposedByType[t] = p;
    else if ((t === 'title' && p && p.length < (proposedByType[t]?.length || Infinity)) || (t !== 'title' && p && p.length > (proposedByType[t]?.length || 0))) {
      proposedByType[t] = p;
    }
  }

  const fields = {};
  const patch = [];
  const isHtml = (k) => (k === 'description' || k === 'shipping' || k === 'returns');

  // Choose a primary selector per type (largest bbox area) and also add duplicate patches
  const byType = new Map();
  for (const d of detections) {
    const t = d?.type; if (!t) continue;
    const sel = selectorMap?.[d?.id || `${t}:${d?.bbox?.x},${d?.bbox?.y}`]?.selector || selectorMap?.[t]?.selector || '';
    if (!sel) continue;
    const area = Math.max(1, (d?.bbox?.width || 0) * (d?.bbox?.height || 0));
    const current = byType.get(t);
    if (!current || area > current.area) byType.set(t, { selector: sel, area });
  }

  for (const type of ['title','description','shipping','returns']) {
    const primary = byType.get(type);
    const proposed = proposedByType[type] || '';
    if (primary && proposed) {
      fields[type] = { selector: primary.selector, html: isHtml(type), proposed };
    }
  }

  // Add patch steps for every matched detection occurrence to cover duplicates
  for (const d of detections) {
    const t = d?.type; if (!t) continue;
    const sel = selectorMap?.[d?.id || `${t}:${d?.bbox?.x},${d?.bbox?.y}`]?.selector || selectorMap?.[t]?.selector || '';
    const proposed = proposedByType[t] || '';
    if (!sel || !proposed) continue;
    patch.push({ selector: sel, op: isHtml(t) ? 'setHTML' : 'setText', value: proposed });
  }

  const hasAny = Object.keys(fields).length > 0;
  try { log("[OCR] done", { is_pdp: hasAny, fields: Object.keys(fields), patch_steps: patch.length, took_ms: Date.now() - t0 }); } catch {}
  return { ...planBase, is_pdp: hasAny, patch, fields };
}

/** Capture a full-page image using html2canvas injected in the tab. */
async function captureFullPage(tabId) {
  const viaH2C = await captureViaHtml2Canvas(tabId);
  if (!viaH2C || typeof viaH2C.dataUrl !== 'string' || !viaH2C.dataUrl.startsWith('data:image/')) {
    throw new Error('html2canvas capture failed');
  }
  return viaH2C;
}

/** Inject vendor html2canvas and capture DOM → data URL with metadata. */
async function captureViaHtml2Canvas(tabId) {
  // Inject bundled html2canvas script into the tab's isolated world (bypasses page CSP)
  try { await api.scripting.executeScript({ target: { tabId }, files: ["vendor/html2canvas.min.js"] }); log("[OCR] injected html2canvas vendor script"); } catch (e) { log("[OCR] inject vendor failed", String(e?.message || e)); }
  const [{ result } = { result: null }] = await api.scripting.executeScript({ target: { tabId }, func: async () => {
    const html = document.documentElement; const body = document.body;
    const prevHtml = html.style.scrollBehavior; const prevBody = body.style.scrollBehavior;
    html.style.scrollBehavior = 'auto'; body.style.scrollBehavior = 'auto';
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, window.innerWidth || 0);
    const h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, window.innerHeight || 0);
    try {
      // Ensure the page is fully loaded before capture
      async function waitForLoad(timeoutMs = 6000){
        if (document.readyState !== 'complete') {
          await new Promise((resolve) => {
            const to = setTimeout(resolve, timeoutMs);
            window.addEventListener('load', () => { clearTimeout(to); resolve(undefined); }, { once: true });
          });
        }
        // Wait for fonts
        try {
          var fonts = (document && document.fonts && typeof document.fonts.ready === 'object' && typeof document.fonts.ready.then === 'function') ? document.fonts.ready : Promise.resolve();
          await Promise.race([fonts, new Promise(function(r){ setTimeout(r, 1500); })]);
        } catch {}
        // Try decoding images best-effort with a cap
        try {
          const imgs = Array.from(document.images || []);
          const pending = imgs.filter(img => !(img.complete && img.naturalWidth > 0));
          const tasks = pending.slice(0, 200).map(function(img){
            var p = (typeof img.decode === 'function') ? img.decode() : new Promise(function(res){ img.addEventListener('load', res, { once: true }); img.addEventListener('error', res, { once: true }); });
            return Promise.race([p, new Promise(function(r){ setTimeout(r, 1200); })]);
          });
          await Promise.race([Promise.all(tasks), new Promise(function(r){ setTimeout(r, 2000); })]);
        } catch {}
        // Settle layout
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))));
      }
      await waitForLoad();
      const h2c = (window && (window).html2canvas) ? (window).html2canvas : null;
      if (!h2c || typeof h2c !== 'function') throw new Error('html2canvas not available: ensure vendor/html2canvas.min.js is packaged');
      window.scrollTo(0, 0);
      // Clamp the capture scale to match what we actually use for rendering
      const usedScale = Math.max(1, Math.min(2, dpr));
      const canvas = await h2c(document.documentElement, {
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff',
        scale: usedScale,
        windowWidth: w,
        windowHeight: h,
        scrollX: 0,
        scrollY: 0,
        logging: false,
      });
      const dataUrl = canvas.toDataURL('image/png');
      return {
        dataUrl,
        meta: {
          image_pixel_width: canvas.width,
          image_pixel_height: canvas.height,
          // Report the actual scale used for capture (not raw window DPR) for consistency
          device_pixel_ratio: usedScale,
          page_width_css: w,
          page_height_css: h,
        }
      };
    } finally {
      html.style.scrollBehavior = prevHtml || '';
      body.style.scrollBehavior = prevBody || '';
    }
  }});
  if (!result) throw new Error('html2canvas result missing');
  try { log("[OCR] html2canvas produced image", { w: result?.meta?.image_pixel_width, h: result?.meta?.image_pixel_height, len: (result?.dataUrl || '').length }); } catch {}
  return result;
}

//

/**
 * Execute in page context: map detections (image pixel bboxes) to CSS selectors
 * by maximizing IoU against visible text containers.
 */
function selectorsFromDetections(detections, meta) {
  function normalize(s){
    try { return String(s || '').replace(/\s+/g,' ').trim().toLowerCase(); } catch { return ''; }
  }
  function cssPath(el){
    if (!(el instanceof Element)) return '';
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 5){
      let selector = el.nodeName.toLowerCase();
      if (el.classList && el.classList.length && el.classList.length <= 3){
        selector += '.' + Array.from(el.classList).slice(0,3).map(c=>CSS.escape(c)).join('.');
      }
      const parent = el.parentElement;
      if (parent){
        const siblings = Array.from(parent.children).filter(n=>n.nodeName === el.nodeName);
        if (siblings.length > 1){
          const index = siblings.indexOf(el) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }
      parts.unshift(selector);
      el = parent;
    }
    return parts.join(' > ');
  }
  function isVisible(el){
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return true;
  }
  const pageW = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
  // Prefer precise scale computed from canvas/page sizes; else use provided DPR; else fallback
  const scale = (meta && meta.image_pixel_width && meta.page_width_css)
    ? (meta.image_pixel_width / meta.page_width_css)
    : (typeof (meta && meta.device_pixel_ratio) === 'number' && meta.device_pixel_ratio > 0
        ? meta.device_pixel_ratio
        : (window.devicePixelRatio || 1));

  const candidates = Array.from(document.querySelectorAll('h1,h2,h3,p,div,span,li,dd,dt,strong,em,section,article,td,th'))
    .filter(el => isVisible(el));

  function toCssRect(bbox){
    const x = (bbox?.x || 0) / scale;
    const y = (bbox?.y || 0) / scale;
    const w = (bbox?.width || 0) / scale;
    const h = (bbox?.height || 0) / scale;
    return { x, y, w, h };
  }
  function rectOfEl(el){
    const r = el.getBoundingClientRect();
    const x = r.left + window.scrollX;
    const y = r.top + window.scrollY;
    return { x, y, w: r.width, h: r.height };
  }
  function iou(a,b){
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const iw = Math.max(0, x2 - x1), ih = Math.max(0, y2 - y1);
    const inter = iw * ih;
    const union = a.w * a.h + b.w * b.h - inter;
    return union > 0 ? (inter / union) : 0;
  }

  const out = {};
  for (const d of (detections || [])){
    try {
      const key = d?.id || `${d?.type}:${d?.bbox?.x},${d?.bbox?.y}`;
      const rCss = toCssRect(d?.bbox || {});
      let best = { score: 0, el: null };
      for (const el of candidates){
        const er = rectOfEl(el);
        const s = iou(er, rCss);
        if (s > best.score) best = { score: s, el };
      }
      if (best.el && best.score > 0) out[key] = { selector: cssPath(best.el), score: best.score };
      else if (d?.type && !out[d.type]) out[d.type] = { selector: '', score: 0 };
    } catch {}
  }
  return out;
}

self.resolveViaOCR = resolveViaOCR;
