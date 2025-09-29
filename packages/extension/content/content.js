
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

    // Strip all attributes except id and class
    const nodes = [body, ...body.querySelectorAll('*')];
    nodes.forEach((el) => {
      Array.from(el.attributes || []).forEach(attr => {
        const name = attr.name.toLowerCase();
        if (name !== 'id' && name !== 'class') {
          el.removeAttribute(attr.name);
        }
      });
    });

    // Remove empty elements (no text content and no element children), bottom-up
    const all = Array.from(body.querySelectorAll('*'));
    for (let i = all.length - 1; i >= 0; i--) {
      const el = all[i];
      const hasElementChildren = el.children && el.children.length > 0;
      const text = (el.textContent || '').replace(/\s+/g, '');
      if (!hasElementChildren && text.length === 0) {
        el.remove();
      }
    }

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
  if (msg.type === 'RUN_WEBLLM_ANALYZE') {
    (async () => {
      try {
        const t0 = Date.now();
        const payload = msg.payload || {};
        log('RUN_WEBLLM_ANALYZE start', { url: payload?.url, html_len: typeof payload?.html_excerpt === 'string' ? payload.html_excerpt.length : 0 });
        const glb = (window.WebLLM || window.webllm);
        if (!glb) throw new Error('WebLLM not loaded');
        const createChat = (glb.createChat ? glb.createChat : (glb.ChatModule && glb.ChatModule.createChat ? glb.ChatModule.createChat : null));
        if (!createChat) throw new Error('WebLLM createChat not available');
        const model = 'Llama-3-8B-Instruct-q4f32_1-MLC';
        const chat = await createChat({ model });
        log('WebLLM chat created', { model });
        await chat.reset();
        const SYS_PROMPT = `You are a meticulous PDP (Product Detail Page) extractor and rewriter. You MUST output STRICT JSON matching the schema. Output only JSON.`;
        const usr = JSON.stringify(payload);
        await chat.addMessage({ role: 'system', content: SYS_PROMPT });
        await chat.addMessage({ role: 'user', content: usr });
        log('WebLLM prompt sent', { sys_len: SYS_PROMPT.length, usr_len: usr.length });
        const reply = await chat.generate();
        const txt = (typeof reply?.content === 'string' ? reply.content : (Array.isArray(reply?.content) ? reply.content.map(p => p.text || '').join('') : '')).trim();
        log('WebLLM reply', { len: txt.length, took_ms: Date.now() - t0 });
        const start = txt.indexOf('{');
        const end = txt.lastIndexOf('}');
        const raw = txt.slice(start, end + 1) || '{}';
        let obj = {};
        try { obj = JSON.parse(raw); } catch {}
        log('WebLLM parsed', { keys: Object.keys(obj || {}) });
        sendResponse({ ok: true, obj });
      } catch (e) {
        log('RUN_WEBLLM_ANALYZE error', String(e?.message || e));
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
});
