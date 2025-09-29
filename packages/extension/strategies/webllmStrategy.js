// strategies/webllmStrategy.js — Run the PDP analysis with WebLLM locally (WebGPU)
// Notes:
// - Loads WebLLM in the active tab and executes the prompt client-side.
// - Falls back to backend call if WebGPU/WebLLM not available or errors occur.
(function(){
  const api = (typeof browser !== 'undefined') ? browser : chrome;
  const DEBUG = true;
  const log = (...args) => { if (DEBUG) console.debug("[PDP][webllm]", ...args); };

  // No dynamic injection needed when using content_scripts
  async function ensureWebLLM(/* tabId */){ return true; }

  // Build the same system prompt used by backend
  function buildSystemPrompt(){
    return `You are a meticulous PDP (Product Detail Page) extractor and rewriter. You MUST output STRICT JSON matching the exact schema below—no extra keys, no comments.
########################
# DECISION & SCOPE
########################
- Input is a JSON payload: { url, title, meta, language, html_excerpt, trace_id }.
- Determine if the page is a MERCHANT PRODUCT DETAIL PAGE (PDP): a page whose primary purpose is to sell a single product (clear product title + purchasable state). Heuristics:
  - Signals FOR PDP: single product title in main content; price/sku/availability; “add to cart/bag/buy” elements; shipping/returns details; product gallery; spec/description sections.
  - Signals AGAINST PDP: category/collection lists; blog/article; home/landing; multi-product comparison; checkout/cart; account pages; pure CMS.
- Output \`is_pdp\` plus a \`confidence\` in [0,1].
- If \`is_pdp\` = false → return the schema with empty field selectors, empty patches, and helpful \`warnings\`/\`diagnostics\`. DO NOT attempt patches.
########################
# LANGUAGE POLICY
########################
- Use \`language\` if provided and non-empty. Otherwise infer from content.
- All rewritten/proposed content MUST be in that language.
########################
# SELECTOR RULES
########################
Choose the MOST SPECIFIC and STABLE selector that uniquely matches EXACTLY ONE element **within the provided html_excerpt**:
- Prefer short paths with IDs and stable classes, e.g., \`main h1#product-title\`, \`.product-main h1.title\`.
- Avoid: generic tags alone (\`h1\`, \`main\`, \`body\`), grouped selectors (\`, \`), wildcards (\`*\`), :nth-child, :contains, attribute substrings with hashes/UUID-like classnames, script/style/meta/link tags.
- If a field has multiple occurrences in the excerpt, set the field’s primary \`selector\` to the canonical PDP element, then add additional patch steps to cover duplicates (same value).
- If no safe, content-bearing node exists, leave the field’s selector empty and omit patches for it.
########################
# CONTENT RULES
########################
- Extract the current (as-is) text/HTML for each field (when selector exists) into \`extracted\`.
- Create improved \`proposed\` content with constraints:
  - title.proposed: ≤ 70 chars, no branding/store name, attributes only if confident.
  - description.proposed: 120–200 words, factual, minimal HTML (<p>, <ul>, <li>, <strong>, <em>), no links.
  - shipping.proposed & returns.proposed: <ul><li>…</li></ul> with 3–6 bullets; generic if unclear.
- Safety: no scripts, no external resources.
########################
# PATCH RULES
########################
- Build \`patch\` as an array of { selector, op, value }.
- Use \`setText\` ONLY for title. Use \`setHTML\` for description, shipping, returns.
- Selecting meta tags is not allowed.
########################
# OUTPUT SCHEMA (STRICT)
########################
{ "is_pdp": boolean, "confidence": number, "language": string, "url": string, "trace_id": string,
  "fields": {
    "title": { "selector": string, "selector_note": string, "extracted": string, "proposed": string },
    "description": { "selector": string, "selector_note": string, "extracted": string, "proposed": string },
    "shipping": { "selector": string, "selector_note": string, "extracted": string, "proposed": string },
    "returns": { "selector": string, "selector_note": string, "extracted": string, "proposed": string }
  },
  "patch": [ { "selector": string, "op": "setText" | "setHTML", "value": string } ],
  "diagnostics": { "pdp_signals": string[], "anti_pdp_signals": string[], "duplicates_covered": string[] },
  "warnings": string[] }\n# VALIDATION\n- JSON must be valid and match the schema exactly. No comments.`;
  }

  // Ask the content script (where webllm is preloaded) to run the analysis
  async function runWebLLMInPage(tabId, payload){
    try {
      log("send RUN_WEBLLM_ANALYZE", { tabId, url: payload?.url, len: typeof payload?.html_excerpt === 'string' ? payload.html_excerpt.length : 0 });
      const resp = await api.tabs.sendMessage(tabId, { type: 'RUN_WEBLLM_ANALYZE', payload });
      log("recv RUN_WEBLLM_ANALYZE", { ok: !!resp?.ok, has_obj: !!resp?.obj, err: resp?.error ? String(resp.error).slice(0, 160) : null });
      if (resp && resp.ok && resp.obj) return resp.obj;
      if (resp && !resp.ok) return { __webllm_error: resp.error || 'WebLLM content error' };
      return { __webllm_error: 'No response from content script' };
    } catch (e) {
      log("RUN_WEBLLM_ANALYZE error", String(e?.message || e));
      return { __webllm_error: String(e?.message || e) };
    }
  }

  async function webllmStrategy(payload, ctx){
    const tabId = ctx?.tabId;
    try {
      log("webllmStrategy start", { tabId, url: payload?.url, lang: payload?.language, html_len: typeof payload?.html_excerpt === 'string' ? payload.html_excerpt.length : 0 });
      if (tabId == null) throw new Error("Missing tabId for WebLLM strategy");
      const ok = await ensureWebLLM(tabId);
      log("ensureWebLLM done", { ok });
      if (!ok) throw new Error("WebLLM load failed");
      const obj = await runWebLLMInPage(tabId, payload);
      log("webllm content result", { has_obj: !!obj, has_err: !!obj?.__webllm_error });
      if (!obj || obj.__webllm_error) throw new Error(obj?.__webllm_error || "WebLLM execution failed");
      // Normalize minimal fields similar to backend validation
      const deny = /(?:<script|javascript:|on\w+=|<iframe|<object|fetch\(|XMLHttpRequest|WebSocket|eval|Function|import\(|window\.|document\.write|chrome\.|browser\.)/i;
      obj.patch = Array.isArray(obj.patch) ? obj.patch.filter(st => st && typeof st.selector === "string" && ["setText","setHTML"].includes(st.op)) : [];
      for (const k of ["title","description","shipping","returns"]) {
        const f = obj.fields && obj.fields[k];
        if (f && typeof f.proposed === "string" && deny.test(f.proposed)) f.proposed = "";
      }
      if (typeof obj.is_pdp !== 'boolean') obj.is_pdp = false;
      try { log("webllmStrategy ok", { is_pdp: obj.is_pdp, patch: Array.isArray(obj.patch) ? obj.patch.length : 0 }); } catch {}
      return obj;
    } catch (e) {
      log("fallback to backend", String(e?.message || e));
      if (typeof self.callLLM === 'function') return await self.callLLM(payload);
      // If backend helper is not exposed, just bubble the error
      throw e;
    }
  }

  self.webllmStrategy = webllmStrategy;
})();


