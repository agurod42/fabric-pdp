// strategies/webllmStrategy.js — Run the PDP analysis with WebLLM locally (WebGPU)
// Notes:
// - Loads WebLLM in the active tab and executes the prompt client-side.
// - Falls back to backend call if WebGPU/WebLLM not available or errors occur.
(function(){
  const api = (typeof browser !== 'undefined') ? browser : chrome;
  const DEBUG = true;
  const log = (...args) => { if (DEBUG) console.debug("[PDP][webllm]", ...args); };

  // Ensure WebLLM is available in the page by injecting from CDN if missing
  async function ensureWebLLM(tabId){
    try {
      // First, quick check in the MAIN world (page context)
      const probe = await api.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => Boolean(window.WebLLM || window.webllm)
      });
      const present = Array.isArray(probe) ? !!probe[0]?.result : false;
      if (present) return true;

      // Load ESM module from jsDelivr in the MAIN world so page CSP applies
      const results = await api.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async () => {
          try {
            if (window.WebLLM || window.webllm) return 'present';
            const mod = await import('https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm');
            // Some CDNs expose API on default; unwrap to get the actual API surface
            const api = (mod && (mod.default || mod));
            // Expose to page globals for later detection
            console.log('!@#!@#!@#!@# WebLLM module loaded', { keys: Object.keys(api || {}), rawKeys: Object.keys(mod || {}) });
            window.webllm = api;
            const hasLegacyCreate = !!(api && (api.createChat || (api.ChatModule && api.ChatModule.createChat)));
            const hasEngine = !!(api && typeof api.CreateMLCEngine === 'function');
            return (hasLegacyCreate || hasEngine) ? 'loaded' : 'loaded_no_factory';
          } catch (e) {
            console.log('!@#!@#!@#!@# WebLLM module load error', e);
            return `error:${String(e && e.message || e)}`;
          }
        }
      });
      console.log('!@#!@#!@#!@# WebLLM module load results', results);
      const status = Array.isArray(results) ? String(results[0]?.result || '') : '';
      if (status.startsWith('error:')) { log('ensureWebLLM load error', status); return false; }

      // Verify availability again (either name) in MAIN world
      const verify = await api.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const g = (window.WebLLM || window.webllm);
          const hasLegacyCreate = !!(g && (g.createChat || (g.ChatModule && g.ChatModule.createChat)));
          const hasEngine = !!(g && typeof g.CreateMLCEngine === 'function');
          const hasOpenAICompat = !!(g && g?.initProgressCallback /* heuristic key present in examples */);
          const hasCreate = hasLegacyCreate || hasEngine;
          return { hasGlobal: !!g, hasCreate, hasLegacyCreate, hasEngine, hasOpenAICompat };
        }
      });
      console.log('!@#!@#!@#!@# WebLLM module verify', verify);
      const v = Array.isArray(verify) ? (verify[0]?.result || {}) : {};
      return !!v.hasGlobal && !!v.hasCreate;
    } catch (e) {
      log('ensureWebLLM fatal', String(e && e.message || e));
      return false;
    }
  }

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

 Field-specific guidance for shipping and returns:
 - Target the CONTENT CONTAINER that holds policy details (sentences, bullet lists, or a table), not the heading/label/button.
 - If a heading/label/trigger (e.g., button, summary, tab, link) controls or precedes a panel/section (via proximity or aria-controls), select the associated panel/section that contains the detailed text.
 - Prefer elements whose text includes policy-like signals:
   - Shipping: time frames (e.g., "business days"), methods (standard/express), regions, carriers, costs/fees, thresholds (e.g., "free over $X").
   - Returns: return window (e.g., "30 days"), refund/exchange instructions, eligibility/condition checks, restocking fees, exceptions, RMA instructions.
 - Avoid selecting global navigation/footer/help-center blocks or standalone policy links. Stay within the product details area when possible.
 - When both a trigger and a panel exist, DO NOT select the trigger; select the panel with substantive text (typically ≥ 80 characters) or a bullet list.
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

  // Run the analysis directly in the page's MAIN world so it can access window.webllm
  async function runWebLLMInPage(tabId, payload){
    try {
      // Keep full HTML; we'll process in chunks in the page MAIN world
      const html = typeof payload?.html_excerpt === 'string' ? payload.html_excerpt : '';
      const reduced = {
        url: payload?.url || '',
        title: payload?.title || '',
        meta: payload?.meta || {},
        language: payload?.language || 'en',
        html_excerpt: html,
      };
      log("send RUN_WEBLLM_ANALYZE", { tabId, url: reduced.url, html_len: reduced.html_excerpt.length });
      const systemPrompt = buildSystemPrompt();
      const results = await api.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (payload, systemPrompt) => {
          try {
            const g = (window.WebLLM || window.webllm);
            if (!g) return { ok: false, error: 'WebLLM not loaded' };
            // Single fast model similar in spirit to 4o-mini
            const MODEL = 'Llama-3.2-1B-Instruct-q4f32_1-MLC';
            // Helper: get text from reply which can be string or array parts
            const getText = (reply) => (typeof reply?.content === 'string'
              ? reply.content
              : (Array.isArray(reply?.content) ? reply.content.map(p => p.text || '').join('') : '')).trim();

            // Helper: run a single prompt and get text using either legacy or engine API
            async function runMessages(messages){
              const legacyCreate = (g.createChat ? g.createChat : (g.ChatModule && g.ChatModule.createChat ? g.ChatModule.createChat : null));
              if (legacyCreate) {
                const chat = await legacyCreate({ model: MODEL });
                await chat.reset();
                for (const m of messages) { await chat.addMessage(m); }
                const reply = await chat.generate();
                return getText(reply);
              }
              if (typeof g.CreateMLCEngine === 'function') {
                const engine = await g.CreateMLCEngine(MODEL, {});
                // Prefer simpler generate() API to avoid WASM binding vector type issues
                if (engine && typeof engine.generate === 'function') {
                  const merged = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
                  const txt = await engine.generate(merged);
                  return String(txt || '').trim();
                }
                if (engine && engine.chat && engine.chat.completions && typeof engine.chat.completions.create === 'function') {
                  try {
                    const comp = await engine.chat.completions.create({ messages, stream: false });
                    return String(comp?.choices?.[0]?.message?.content || '').trim();
                  } catch (e) {
                    const msg = String(e && e.message || e);
                    if (/Vector(Int|String)/i.test(msg) || /instance of/i.test(msg)) {
                      // Fallback to generate if the bindings complain about typed vectors
                      const merged = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
                      const txt = await engine.generate(merged);
                      return String(txt || '').trim();
                    }
                    throw e;
                  }
                }
              }
              throw new Error('No WebLLM chat factory found');
            }

            // Split HTML into manageable chunks
            const html = String(payload?.html_excerpt || '');
            const CHUNK_SIZE = 8000; // chars
            const chunks = [];
            for (let i = 0; i < html.length; i += CHUNK_SIZE) {
              chunks.push(html.slice(i, i + CHUNK_SIZE));
            }

            // Per-chunk extraction prompt that yields compact JSON
            const CHUNK_SYS = 'You analyze a fragment of sanitized HTML from a product page. Output STRICT JSON with keys: { "pdp_signals": string[], "anti_pdp_signals": string[], "candidates": { "title": Array<{selector:string, text:string}>, "description": Array<{selector:string, html:string}>, "shipping": Array<{selector:string, html:string}>, "returns": Array<{selector:string, html:string}> } }. For shipping/returns candidates, include only CONTENT containers (policy text, bullet lists, or tables) and avoid headings/labels/triggers; if a trigger controls a panel, select the panel content. Choose precise selectors that uniquely match within the provided fragment only. If none, use empty arrays. No comments.';

            function buildChunkUser(i, total, htmlFrag){
              return `Chunk ${i+1}/${total} HTML:\n` + htmlFrag;
            }

            // Concurrency-limited parallel processing of chunks
            async function mapWithConcurrency(items, limit, fn){
              const out = new Array(items.length);
              let idx = 0;
              async function worker(){
                while (true){
                  const i = idx; idx++; if (i >= items.length) return;
                  out[i] = await fn(items[i], i);
                }
              }
              const n = Math.max(1, Math.min(limit, items.length));
              await Promise.all(Array.from({ length: n }, () => worker()));
              return out;
            }

            const summaries = await mapWithConcurrency(chunks, 3, async (frag, i) => {
              const txt = await runMessages([
                { role: 'system', content: CHUNK_SYS },
                { role: 'user', content: buildChunkUser(i, chunks.length, frag) }
              ]);
              const start = txt.indexOf('{');
              const end = txt.lastIndexOf('}');
              const raw = txt.slice(start, end + 1) || '{}';
              try { return JSON.parse(raw); } catch { return {}; }
            });

            // Merge summaries into aggregate candidates and signals
            const agg = {
              pdp_signals: [],
              anti_pdp_signals: [],
              candidates: { title: [], description: [], shipping: [], returns: [] }
            };
            for (const s of summaries) {
              if (Array.isArray(s?.pdp_signals)) agg.pdp_signals.push(...s.pdp_signals);
              if (Array.isArray(s?.anti_pdp_signals)) agg.anti_pdp_signals.push(...s.anti_pdp_signals);
              const c = s?.candidates || {};
              for (const k of ['title','description','shipping','returns']) {
                if (Array.isArray(c[k])) agg.candidates[k].push(...c[k]);
              }
            }
            // Deduplicate signals
            agg.pdp_signals = Array.from(new Set(agg.pdp_signals)).slice(0, 24);
            agg.anti_pdp_signals = Array.from(new Set(agg.anti_pdp_signals)).slice(0, 24);
            // Limit candidates per field to top N to keep prompt small
            for (const k of ['title','description','shipping','returns']) {
              agg.candidates[k] = (Array.isArray(agg.candidates[k]) ? agg.candidates[k] : []).slice(0, 6);
            }

            // Final prompt: supply page context + aggregated candidates, ask for strict PDP schema JSON
            const FINAL_SYS = systemPrompt;
            const finalUser = JSON.stringify({
              url: payload?.url || '',
              title: payload?.title || '',
              meta: payload?.meta || {},
              language: payload?.language || 'en',
              aggregated: agg
            });
            const finalTxt = await runMessages([
              { role: 'system', content: FINAL_SYS },
              { role: 'user', content: finalUser }
            ]);
            const fStart = finalTxt.indexOf('{');
            const fEnd = finalTxt.lastIndexOf('}');
            const fRaw = finalTxt.slice(fStart, fEnd + 1) || '{}';
            let obj = {};
            try { obj = JSON.parse(fRaw); } catch {}
            return { ok: true, obj };
          } catch (e) {
            return { ok: false, error: String(e?.message || e) };
          }
        },
        args: [reduced, systemPrompt]
      });
      const res = Array.isArray(results) ? (results[0]?.result ?? null) : null;
      log("recv RUN_WEBLLM_ANALYZE", { ok: !!res?.ok, has_obj: !!res?.obj, err: res?.error ? String(res.error).slice(0, 160) : null });
      if (res && res.ok && res.obj) return res.obj;
      if (res && !res.ok) return { __webllm_error: res.error || 'WebLLM page error' };
      return { __webllm_error: 'No response from page MAIN world' };
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
      if (typeof self.callLLM === 'function') {
        const plan = await self.callLLM(payload);
        try {
          plan.meta = plan.meta && typeof plan.meta === 'object' ? { ...plan.meta } : {};
          plan.meta.strategy_fallback = true;
          plan.meta.strategy_fallback_reason = String(e?.message || e);
        } catch {}
        return plan;
      }
      // If backend helper is not exposed, just bubble the error
      throw e;
    }
  }

  self.webllmStrategy = webllmStrategy;
})();


