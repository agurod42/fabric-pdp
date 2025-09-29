
// content/content.js — Injected script that collects context and triggers plan
// resolution. Applies no heuristics; delegates decision-making to the backend.
const api = (typeof browser !== 'undefined') ? browser : chrome;
const DEBUG = true;
const log = (...args) => { if (DEBUG) console.debug("[PDP][content]", ...args); };

// Deprecated truncation flags removed

// Frontend no longer computes heuristics; LLM decides PDP.

/** Collect a minimal set of meta tags for context. */
function getMeta() {
  const g = (n) => document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.getAttribute("content") || null;
  return {
    ogTitle: g("og:title"), ogDescription: g("og:description"),
    twTitle: g("twitter:title"), twDescription: g("twitter:description")
  };
}

/** Extract and parse JSON-LD blocks from the page (best-effort). */
function extractJsonLd(){
  try {
    const blocks = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    const out = [];
    for (const s of blocks){
      let text = s.textContent || '';
      if (!text) continue;
      try {
        // Some sites embed multiple JSON-LD objects in one script tag
        const json = JSON.parse(text);
        out.push(json);
      } catch (e) {
        // Attempt to recover by wrapping as array or stripping invalid trailing commas
        try {
          const fixed = text.replace(/,\s*([}\]])/g, '$1');
          const json = JSON.parse(fixed);
          out.push(json);
        } catch {}
      }
    }
    return out;
  } catch { return []; }
}

/**
 * Build a reduced, safe HTML from DOM for analysis.
 * Strips scripts/styles/iframes and most attributes.
 */
function sanitizeHtmlFromDom() {
  try {
    const doc = document.cloneNode(true);
    const body = doc.body || doc.documentElement;
    const forbidden = ['script','style','noscript','template','iframe','object','embed','svg','canvas','picture','source'];
    forbidden.forEach(tag => Array.from(body.querySelectorAll(tag)).forEach(n => n.remove()));

    // Remove comments
    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT, null);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach(c => c.parentNode && c.parentNode.removeChild(c));

    // Strip dangerous attributes and unwanted attrs; keep only safe structural ones like class/id
    const nodes = body.querySelectorAll('*');
    nodes.forEach((el) => {
      // Remove inline event handlers and inline style
      const isImg = (el.tagName || '').toLowerCase() === 'img';
      Array.from(el.attributes).forEach(attr => {
        const name = attr.name.toLowerCase();
        const value = attr.value || '';
        if (name.startsWith('on') || name === 'style') { el.removeAttribute(attr.name); return; }
        // Remove all hrefs entirely
        if (name === 'href') { el.removeAttribute('href'); return; }
        // Remove all data-* attributes
        if (name.startsWith('data-')) { el.removeAttribute(attr.name); return; }
        // Remove img src and srcset
        if (isImg && (name === 'src' || name === 'srcset')) { el.removeAttribute(attr.name); return; }
        // Extra safety: drop javascript: in any src-like attributes
        if ((name === 'src' || name === 'xlink:href') && /^\s*javascript:/i.test(value)) { el.removeAttribute(attr.name); return; }
      });
    });

    // Serialize and minify whitespace
    let html = (body.outerHTML || '').replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ');
    return html;
  } catch {
    // Fallback to raw body HTML
    const raw = (document.body?.outerHTML || document.documentElement.outerHTML || '');
    return raw;
  }
}

/** Main entry: gather payload, request plan, cache and optionally apply. */
async function main() {
  try {
    const url = location.href;
    const t0 = Date.now();
    log("start", { url });
    const { ok } = await api.runtime.sendMessage({ type: "SHOULD_RUN", url });
    if (!ok) return;

    const payload = {
      url,
      title: document.title,
      meta: getMeta(),
      html_excerpt: sanitizeHtmlFromDom(),
    language: document.documentElement.getAttribute("lang") || navigator.language || "en",
    jsonld: extractJsonLd()
    };

    const approx = {
      html_excerpt_len: typeof payload.html_excerpt === "string" ? payload.html_excerpt.length : 0,
      // heuristics removed
    };
  log("send RESOLVE_PLAN", approx);
  try { await api.runtime.sendMessage({ type: "SET_BADGE", text: "…" }); } catch {}
  const res = await api.runtime.sendMessage({ type: "RESOLVE_PLAN", payload });
    let plan = res?.plan;
    if (!plan) {
      const backendError = (typeof res?.error === 'string' && res.error.trim().length > 0) ? res.error : "No plan";
      // Propagate real backend error to background so popup can display it
      try { await api.runtime.sendMessage({ type: "SET_LAST_ERROR", error: String(backendError) }); } catch {}
      throw new Error(String(backendError));
    }

    // Enrich plan with DOM originals if missing, to improve popup and revert accuracy
    try {
      const keys = ["title","description","shipping","returns"];
      plan.fields = plan.fields || {};
      for (const key of keys) {
        const f = plan.fields[key];
        if (!f || !f.selector) continue;
        const node = document.querySelector(f.selector);
        if (!node) continue;
        if (typeof f.original !== 'string' || f.original.length === 0) {
          const value = f.html ? String(node.innerHTML ?? '') : String(node.textContent ?? '');
          plan.fields[key] = { ...f, original: value };
        }
      }
    } catch {}

    await api.runtime.sendMessage({ type: "CACHE_PLAN", url, plan });
    log("cached plan", { is_pdp: !!plan?.is_pdp, took_ms: Date.now() - t0 });
  await api.runtime.sendMessage({ type: "SET_BADGE", text: plan.is_pdp ? "PDP" : "—" });

    if (plan.is_pdp) {
      log("apply patch", { steps: plan?.patch?.length || 0 });
    try { await api.runtime.sendMessage({ type: "SET_BADGE", text: "AP" }); } catch {}
    const resp = await api.runtime.sendMessage({ type: "APPLY_PATCH", plan, url });
    log("apply summary", resp?.summary || {});
    try { await api.runtime.sendMessage({ type: "SET_BADGE", text: "PDP" }); } catch {}
    }
  } catch (e) {
    console.error("[PDP][content] error", e);
    try { await api.runtime.sendMessage({ type: "SET_BADGE", text: "ERR" }); } catch {}
    try { await api.runtime.sendMessage({ type: "SET_LAST_ERROR", error: String(e?.message || e) }); } catch {}
  }
}

window.addEventListener("load", () => { log("window load"); setTimeout(main, 600); });

// Expose sanitized HTML to popup/background for debugging downloads
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'GET_REDUCED_HTML') {
    try {
      const html = sanitizeHtmlFromDom();
      sendResponse({ html });
    } catch (e) {
      sendResponse({ error: String(e?.message || e) });
    }
    return true;
  }
});
