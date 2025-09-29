export const config = { runtime: "edge" };
import { jsonResponse, createStream, safeString, buildOpenAIEnv, buildOpenAIHeaders } from "./_utils";

export default async function handler(req) {
  const t0 = Date.now();
  if (req.method === "OPTIONS") return jsonResponse({}, 204);
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);

  const { url, title, meta, html_excerpt, language, trace_id } = await req.json().catch((e) => {
    console.error("[PDP][api] JSON parse error:", e);
    return {};
  });
  const traceId = (typeof trace_id === "string" && trace_id) ? trace_id : "";

  try {
    const sizes = {
      html_excerpt_len: typeof html_excerpt === "string" ? html_excerpt.length : 0,
      title_len: typeof title === "string" ? title.length : 0,
      meta_keys: meta ? Object.keys(meta).length : 0,
    };
    console.debug("[PDP][api] request", { traceId, url, lang: language, sizes });
  } catch {}

  // Prepare streaming response to send an early byte and avoid initial-response timeout
  const { readable, writer, encoder, headers } = createStream();

  // Begin writing asynchronously
  (async () => {
    try {
      // Send an initial whitespace byte so the platform receives a response within the limit
      await writer.write(encoder.encode(" "));

      // Server-side truncation and payload slimming
      const safe = (s: any) => (typeof s === "string" ? s : "");
      const payload = {
        url: safe(url),
        title: safe(title),
        meta: meta ? Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, safe(v)])) : {},
        language: safe(language),
        html_excerpt: safe(html_excerpt),
        trace_id: traceId,
      };

      const SYS_PROMPT = `
        You are a meticulous PDP (Product Detail Page) extractor and rewriter. You MUST output STRICT JSON matching the exact schema below—no extra keys, no comments.

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
        - Prefer short paths with IDs and stable classes, e.g. \`main h1#product-title\`, \`.product-main h1.title\`.
        - Avoid: generic tags alone (\`h1\`, \`main\`, \`body\`), grouped selectors (\`, \`), wildcards (\`*\`), :nth-child, :contains, attribute substrings with hashes/UUID-like classnames, script/style/meta/link tags.
        - If a field has multiple occurrences in the excerpt, set the field’s primary \`selector\` to the canonical PDP element, then add **additional** patch steps to cover duplicates (same value).
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
        - Create improved \`proposed\` content with the following constraints:
          - **title.proposed**: ≤ 70 characters, no branding, no store name, include main attribute(s) (e.g., color/capacity) only if confidently present, no clickbait.
          - **description.proposed**: 120–200 words, factual, concise, no unverifiable claims, highlight key specs/benefits that are visible in the excerpt; neutral tone; no external links; formatted as minimal HTML (<p>, <ul>, <li>, <strong>, <em> only).
          - **shipping.proposed** and **returns.proposed**: 3–6 bullet points each (<ul><li>…</li></ul>), neutral and generic if details are unclear; DO NOT contradict visible policy text. If no info is present, write safe, generic bullets (e.g., “Standard delivery options may apply…”), clearly marked as generic.
        - Safety: no medical/financial claims, no scripts, no external resources.

        ########################
        # PATCH RULES
        ########################
        - Build \`patch\` as an array of \`{ selector, op, value }\`.
        - Use \`setText\` ONLY for \`title\`. Use \`setHTML\` for \`description\`, \`shipping\`, and \`returns\`.
        - It is allowed to include multiple patch steps for the SAME field when the page shows duplicates; use the same \`value\`.
        - Do NOT use \`valueRef\`. Always place the final string in \`value\`.

        ########################
        # OUTPUT SCHEMA (STRICT)
        ########################
        {
          "is_pdp": boolean,
          "confidence": number,            // 0..1
          "language": string,              // resolved language code/name
          "url": string,
          "trace_id": string,

          "fields": {
            "title": {
              "selector": string,          // "" if none
              "selector_note": string,     // why this is stable & unique
              "extracted": string,         // current text (trimmed), "" if none
              "proposed": string           // <=70 chars, or "" if is_pdp=false
            },
            "description": {
              "selector": string,
              "selector_note": string,
              "extracted": string,         // current innerHTML (sanitized minimal); "" if none
              "proposed": string           // 120–200 words in minimal HTML, or ""
            },
            "shipping": {
              "selector": string,
              "selector_note": string,
              "extracted": string,         // current innerHTML; "" if none
              "proposed": string           // <ul><li>…</li></ul> 3–6 bullets, or ""
            },
            "returns": {
              "selector": string,
              "selector_note": string,
              "extracted": string,
              "proposed": string
            }
          },

          "patch": [
            {
              "selector": string,
              "op": "setText" | "setHTML",
              "value": string
            }
            // 0..N steps; empty if is_pdp=false
          ],

          "diagnostics": {
            "pdp_signals": string[],       // short list of cues found
            "anti_pdp_signals": string[],  // short list of cues found
            "duplicates_covered": string[] // which fields had duplicate patches (e.g., ["title","shipping"])
          },

          "warnings": string[]            // any uncertainties, e.g., “no returns section in excerpt”
        }

        ########################
        # VALIDATION
        ########################
        - Ensure JSON is valid and matches the schema exactly.
        - Ensure each non-empty selector is unique in the excerpt (best-effort reasoning); if unsure, refine the path or leave selector empty.
        - Respect length limits and HTML tag whitelist.
        - If \`is_pdp\` = false: leave all \`proposed\` as "" and \`patch\` empty; populate \`warnings\` with reasons.
      `;

      const { base: OPENAI_BASE, model: OPENAI_MODEL, apiKey: OPENAI_API_KEY } = buildOpenAIEnv();

      try {
        console.debug("[PDP][api] llm config", {
          traceId,
          base: OPENAI_BASE,
          model: OPENAI_MODEL,
          api_key_present: !!OPENAI_API_KEY,
        });
      } catch {}

      if (!OPENAI_API_KEY) {
        await writer.write(encoder.encode(JSON.stringify({ error: "Server misconfiguration: OPENAI_API_KEY is required" })));
        await writer.close();
        return;
      }

      // Helper: call OpenAI Chat Completions
      async function chat(messages: Array<{ role: string; content: string }>, responseFormatJson = true): Promise<string> {
        const headersInit: Record<string, string> = buildOpenAIHeaders(OPENAI_API_KEY as string, traceId);
        const body: any = { model: OPENAI_MODEL, messages, temperature: 0, stream: false };
        if (responseFormatJson) body.response_format = { type: "json_object" } as any;
        const t0f = Date.now();
        const resp = await fetch(`${OPENAI_BASE}/chat/completions`, { method: "POST", headers: headersInit, body: JSON.stringify(body) });
        try {
          console.debug("[PDP][api] llm fetch", { traceId, status: resp.status, ok: resp.ok, took_ms: Date.now() - t0f });
        } catch {}
        if (!resp.ok) {
          let errTxt = ""; try { errTxt = await resp.text(); } catch {}
          throw new Error(`OpenAI error ${resp.status}: ${errTxt || resp.statusText || "no body"}`);
        }
        const json = await resp.json();
        return (json?.choices?.[0]?.message?.content ?? "").trim();
      }

      // Helper: limited concurrency map
      async function mapWithConcurrency<I, O>(items: I[], limit: number, fn: (item: I, index: number) => Promise<O>): Promise<O[]> {
        const out: O[] = new Array(items.length);
        let i = 0;
        const runners: Promise<void>[] = [];
        async function run() {
          while (true) {
            const idx = i; i++; if (idx >= items.length) return;
            out[idx] = await fn(items[idx], idx);
          }
        }
        const n = Math.max(1, Math.min(limit, items.length));
        for (let k = 0; k < n; k++) runners.push(run());
        await Promise.all(runners);
        return out;
      }

      // 1) Chunk the HTML and summarize each in parallel
      const html = String(payload.html_excerpt || "");
      const CHUNK_SIZE = 8000; // chars
      const chunks: string[] = [];
      for (let i = 0; i < html.length; i += CHUNK_SIZE) chunks.push(html.slice(i, i + CHUNK_SIZE));

      const CHUNK_SYS = 'You analyze a fragment of sanitized HTML from a product page. Output STRICT JSON with keys: { "pdp_signals": string[], "anti_pdp_signals": string[], "candidates": { "title": Array<{selector:string, text:string}>, "description": Array<{selector:string, html:string}>, "shipping": Array<{selector:string, html:string}>, "returns": Array<{selector:string, html:string}> } }. For shipping/returns candidates, include only CONTENT containers (policy text, bullet lists, or tables) and avoid headings/labels/triggers; if a trigger controls a panel, select the panel content. Choose precise selectors that uniquely match within the provided fragment only. If none, use empty arrays. No comments.';
      const buildChunkUser = (i: number, total: number, frag: string) => `Chunk ${i+1}/${total} HTML:\n` + frag;

      let agg: any = null;
      try {
        const summariesTxt = await mapWithConcurrency(chunks, 4, async (frag, idx) => {
          const msgs = [ { role: "system", content: CHUNK_SYS }, { role: "user", content: buildChunkUser(idx, chunks.length, frag) } ];
          return await chat(msgs, true);
        });
        const summaries = summariesTxt.map((txt, i) => {
          const s = txt || '{}';
          const a = s.indexOf('{'); const b = s.lastIndexOf('}');
          const raw = s.slice(a, b + 1) || '{}';
          try { return JSON.parse(raw); } catch { return {}; }
        });
        // Merge
        agg = { pdp_signals: [] as string[], anti_pdp_signals: [] as string[], candidates: { title: [] as any[], description: [] as any[], shipping: [] as any[], returns: [] as any[] } };
        for (const s of summaries) {
          if (Array.isArray(s?.pdp_signals)) agg.pdp_signals.push(...s.pdp_signals);
          if (Array.isArray(s?.anti_pdp_signals)) agg.anti_pdp_signals.push(...s.anti_pdp_signals);
          const c = s?.candidates || {};
          for (const k of ["title","description","shipping","returns"]) if (Array.isArray(c[k])) (agg.candidates as any)[k].push(...c[k]);
        }
        agg.pdp_signals = Array.from(new Set(agg.pdp_signals)).slice(0, 24);
        agg.anti_pdp_signals = Array.from(new Set(agg.anti_pdp_signals)).slice(0, 24);
        for (const k of ["title","description","shipping","returns"]) (agg.candidates as any)[k] = (agg.candidates as any)[k].slice(0, 8);
      } catch (chunkErr) {
        console.warn("[PDP][api] chunking failed, falling back", { traceId, error: String((chunkErr as any)?.message || chunkErr) });
      }

      // 2) Final pass: either with aggregated summary or fallback to single-shot html
      const finalPayload = agg ? { url: payload.url, title: payload.title, meta: payload.meta, language: payload.language, trace_id: traceId, aggregated: agg, html_excerpt: "" } : payload;
      const messages = [ { role: "system", content: SYS_PROMPT }, { role: "user", content: JSON.stringify(finalPayload) } ];
      try {
        const sys = typeof messages[0]?.content === "string" ? messages[0].content : "";
        const usr = typeof messages[1]?.content === "string" ? messages[1].content : "";
        console.debug("[PDP][api] llm final prompt", { traceId, sys_len: sys.length, usr_len: usr.length });
      } catch {}

      const txt = await chat(messages, true);
      const start = txt.indexOf("{");
      const end = txt.lastIndexOf("}");
      const raw = txt.slice(start, end + 1);
      let obj: any;
      try { obj = JSON.parse(raw); } catch (parseErr) {
        try { console.warn("[PDP][api] llm parse error", { traceId, msg_len: txt.length, raw_len: raw.length, error: String((parseErr as any)?.message || parseErr) }); } catch {}
      }
      if (obj && typeof obj === 'object') {
        if (!Array.isArray(obj.warnings)) obj.warnings = [];
        type PatchStep = { selector: string; op: "setText" | "setHTML"; value?: string };
        const normalizePatch = (arr: any): PatchStep[] => {
          if (!Array.isArray(arr)) return [];
          const normalized: PatchStep[] = [];
          for (const st of arr as any[]) {
            if (!st || typeof st.selector !== "string") continue;
            const op = st.op || (st.setText ? "setText" : (st.setHTML ? "setHTML" : undefined));
            if (op !== "setText" && op !== "setHTML") continue;
            // Filter out selectors we don't support mutating (e.g., meta tags)
            const sel = String(st.selector).trim();
            if (/^meta(\{|\[|\.|\s|$)/i.test(sel)) continue;
            let value: string | undefined;
            let valueRef: string | undefined;
            if (typeof st.value === "string") {
              value = st.value;
            } else if (typeof st.valueRef === "string") {
              if (st.valueRef.includes(".") || /^fields\./.test(st.valueRef)) valueRef = st.valueRef;
              else value = st.valueRef;
            }
            const out: PatchStep = { selector: st.selector, op };
            // Only keep steps that have a concrete value or a valueRef that resolves inside the object
            if (typeof value === "string") {
              out.value = value;
              normalized.push(out);
              continue;
            }
            if (typeof valueRef === "string" && valueRef.length > 0) {
              const get = (path: string) => path.split(".").reduce((a: any, k: string) => (a == null ? a : a[k]), obj);
              let resolved = get(valueRef);
              if (typeof resolved === "string") {
                out.value = resolved;
                normalized.push(out);
                continue;
              }
              // Compatibility: if ref like fields.key.proposed, allow fallback to top-level key
              const m = /^fields\.(title|description|shipping|returns)\.proposed$/.exec(valueRef);
              if (m && typeof (obj as any)?.[m[1]] === "string") {
                out.value = (obj as any)[m[1]];
                normalized.push(out);
                continue;
              }
              // Unresolved valueRef -> drop this step server-side
              continue;
            }
            // If neither value nor valueRef usable, skip
            continue;
          }
          return normalized;
        };
        obj.patch = normalizePatch(obj.patch);
        const enriched = JSON.stringify(obj);
        try {
          console.debug("[PDP][api] llm parsed ok", {
            traceId,
            took_ms: Date.now() - t0,
            is_pdp: !!obj?.is_pdp,
            patch: Array.isArray(obj?.patch) ? obj.patch.length : 0,
          });
        } catch {}
        await writer.write(encoder.encode(enriched));
        await writer.close();
        return;
      }
      console.debug("[PDP][api] llm raw passthrough", {
        traceId,
        took_ms: Date.now() - t0,
        content_len: txt.length,
        raw_len: raw.length,
      });
      await writer.write(encoder.encode(raw));
      await writer.close();
    } catch (e: any) {
      console.error("[PDP][api] error", { traceId, error: e });
      try {
        await writer.write(encoder.encode(JSON.stringify({ error: String(e?.message || e) })));
      } catch {}
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, { status: 200, headers });
}