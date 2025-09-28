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

      const messages = [
        { role: "system", content: SYS_PROMPT },
        { role: "user", content: JSON.stringify(payload) }
      ];

      try {
        const sys = typeof messages[0]?.content === "string" ? messages[0].content : "";
        const usr = typeof messages[1]?.content === "string" ? messages[1].content : "";
        console.debug("[PDP][api] llm prompt", {
          traceId,
          sys_len: sys.length,
          usr_len: usr.length,
          sys,
          usr,
        });
      } catch {}

      const { base: OPENAI_BASE, model: OPENAI_MODEL, apiKey: OPENAI_API_KEY } = buildOpenAIEnv();

      try {
        console.debug("[PDP][api] llm config", {
          traceId,
          base: OPENAI_BASE,
          model: OPENAI_MODEL,
          api_key_present: !!OPENAI_API_KEY,
          msg_lens: messages.map(m => (typeof m?.content === "string" ? m.content.length : 0)),
        });
      } catch {}

      if (!OPENAI_API_KEY) {
        await writer.write(encoder.encode(JSON.stringify({ error: "Server misconfiguration: OPENAI_API_KEY is required" })));
        await writer.close();
        return;
      }

      const tFetchStart = Date.now();
      const headersInit: Record<string, string> = buildOpenAIHeaders(OPENAI_API_KEY, traceId);
      const resp = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: headersInit,
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages,
          temperature: 0,
          stream: false,
          response_format: { type: "json_object" },
        })
      });
      try {
        console.debug("[PDP][api] llm fetch", {
          traceId,
          status: resp.status,
          ok: resp.ok,
          took_ms: Date.now() - tFetchStart,
          content_length: resp.headers.get("content-length") || null,
        });
      } catch {}
      if (!resp.ok) {
        let errTxt = "";
        try { errTxt = await resp.text(); } catch {}
        throw new Error(`OpenAI error ${resp.status}: ${errTxt || resp.statusText || "no body"}`);
      }
      const openai = await resp.json();
      const txt = (openai?.choices?.[0]?.message?.content ?? "").trim() || "{}";
      try {
        console.debug("[PDP][api] llm raw response", {
          traceId,
          model: OPENAI_MODEL,
          message_len: typeof (openai?.choices?.[0]?.message?.content) === "string" ? openai.choices[0].message.content.length : 0,
          preview: typeof (openai?.choices?.[0]?.message?.content) === "string" ? openai.choices[0].message.content : "",
        });
      } catch {}
      const start = txt.indexOf("{");
      const end = txt.lastIndexOf("}");
      const raw = txt.slice(start, end + 1);
      let obj: any;
      try { obj = JSON.parse(raw); } catch (parseErr) {
        try {
          console.warn("[PDP][api] llm parse error", { traceId, msg_len: txt.length, raw_len: raw.length, error: String((parseErr as any)?.message || parseErr) });
        } catch {}
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