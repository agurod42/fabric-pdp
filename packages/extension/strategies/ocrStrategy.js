// OCR-based strategy: capture full-page screenshot, send to backend for vision LLM, map pixel boxes to selectors

async function resolveViaOCR(payload, ctx) {
  const planBase = { source: "ocrStrategy", url: payload?.url };
  const tabId = ctx?.tabId;
  if (typeof tabId !== 'number') {
    return { ...planBase, is_pdp: false, patch: [], fields: {}, warnings: ["No tabId for OCR"] };
  }

  let capture = null;
  try {
    capture = await captureFullPage(tabId);
  } catch (e) {
    log("ocrStrategy capture error", String(e?.message || e));
    return { ...planBase, is_pdp: false, patch: [], fields: {}, warnings: ["Screenshot capture failed"] };
  }
  if (!capture || typeof capture.dataUrl !== 'string' || !capture.dataUrl) {
    return { ...planBase, is_pdp: false, patch: [], fields: {}, warnings: ["Empty screenshot"] };
  }

  let detections = [];
  let imageMeta = capture.meta || {};
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
    const resp = await fetch(PROXY_OCR_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-trace-id': traceId }, body });
    const text = await resp.text();
    const obj = JSON.parse(text);
    if (obj && Array.isArray(obj.detections)) {
      detections = obj.detections;
    } else {
      throw new Error(String(obj?.error || 'Invalid OCR response'));
    }
  } catch (e) {
    log("ocrStrategy backend error", String(e?.message || e));
    return { ...planBase, is_pdp: false, patch: [], fields: {}, warnings: ["OCR backend error"] };
  }

  // Map detections (image pixel boxes) to DOM selectors inside the page
  let selectorMap = {};
  try {
    const results = await api.scripting.executeScript({ target: { tabId }, func: selectorsFromDetections, args: [detections, imageMeta] });
    selectorMap = Array.isArray(results) ? (results[0]?.result || {}) : {};
  } catch (e) {
    log("ocrStrategy selector mapping error", String(e?.message || e));
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
  return { ...planBase, is_pdp: hasAny, patch, fields };
}

async function captureFullPage(tabId) {
  // Measure page metrics in the tab
  const [{ result: metrics } = { result: null }] = await api.scripting.executeScript({ target: { tabId }, func: () => {
    const dpr = window.devicePixelRatio || 1;
    const doc = document.scrollingElement || document.documentElement || document.body;
    const w = Math.max(doc.clientWidth, window.innerWidth || 0);
    const h = Math.max(doc.scrollHeight, doc.clientHeight, window.innerHeight || 0);
    const vh = window.innerHeight || doc.clientHeight || 0;
    return { dpr, pageWidth: w, pageHeight: h, viewportHeight: vh };
  }});
  if (!metrics) throw new Error('Failed to read page metrics');

  const { dpr, pageWidth, pageHeight, viewportHeight } = metrics;
  const steps = [];
  let y = 0;
  while (y < pageHeight - 1) {
    steps.push(y);
    y += Math.max(64, viewportHeight - 16); // small overlap
  }
  const images = [];
  for (const top of steps) {
    await api.scripting.executeScript({ target: { tabId }, func: (t) => { window.scrollTo(0, t); }, args: [top] });
    await new Promise(r => setTimeout(r, 150));
    const url = await api.tabs.captureVisibleTab(undefined, { format: 'png' });
    images.push({ y: top, url });
  }

  // Stitch images using OffscreenCanvas
  const first = images[0];
  const firstBitmap = await createImageBitmap(await (await fetch(first.url)).blob());
  const imgWidth = firstBitmap.width; // already in device pixels
  const totalHeightPx = Math.round(pageHeight * dpr);
  const canvas = new OffscreenCanvas(imgWidth, totalHeightPx);
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) throw new Error('No 2D context');
  for (const im of images) {
    const bmp = await createImageBitmap(await (await fetch(im.url)).blob());
    const destY = Math.round(im.y * dpr);
    ctx2d.drawImage(bmp, 0, destY);
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const dataUrl = await blobToDataURL(blob);
  return {
    dataUrl,
    meta: {
      image_pixel_width: imgWidth,
      image_pixel_height: totalHeightPx,
      device_pixel_ratio: dpr,
      page_width_css: pageWidth,
      page_height_css: pageHeight,
    }
  };
}

async function blobToDataURL(blob) {
  return await new Promise((resolve, reject) => {
    try {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    } catch (e) { reject(e); }
  });
}

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
  const scale = (meta && meta.image_pixel_width && meta.page_width_css) ? (meta.image_pixel_width / meta.page_width_css) : (window.devicePixelRatio || 1);

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


