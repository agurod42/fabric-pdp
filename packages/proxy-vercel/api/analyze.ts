export const config = { runtime: "edge" };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}

export default async function handler(req) {
  const t0 = Date.now();
  if (req.method === "OPTIONS") return jsonResponse({}, 204);
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);

  const { url, title, meta, html_excerpt, language } = await req.json().catch((e) => {
    console.error("[PDP][api] JSON parse error:", e);
    return {};
  });

  try {
    const sizes = {
      html_excerpt_len: typeof html_excerpt === "string" ? html_excerpt.length : 0,
      meta_keys: meta ? Object.keys(meta).length : 0,
    };
    console.debug("[PDP][api] request", { url, lang: language, sizes });
  } catch {}

  // Prepare streaming response to send an early byte and avoid initial-response timeout
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "POST, OPTIONS",
  } as Record<string, string>;

  // Begin writing asynchronously
  (async () => {
    try {
      // Send an initial whitespace byte so the platform receives a response within the limit
      await writer.write(encoder.encode(" "));

      // Server-side truncation and payload slimming
      const safe = (s: any) => (typeof s === "string" ? s : "");
      const payload = {
        url: safe(url).slice(0, 2048),
        title: safe(title).slice(0, 512),
        meta: meta ? Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, safe(v).slice(0, 512)])) : {},
        language: safe(language).slice(0, 16),
        html_excerpt: safe(html_excerpt),
      };

      const SYS_PROMPT = `You are a careful extractor. Output STRICT JSON only, matching the schema.
Rules:
- Determine if the page is a merchant Product Detail Page.
- If is_pdp=true, extract title/description/shipping/returns + selectors where found.
- Propose improved content: title <= 70 chars; description 120–200 words; shipping/returns 3–6 bullets each.
- Important: Fields like title/description/shipping/returns may appear multiple times in the HTML. When appropriate, include MULTIPLE patch steps for the SAME field, each targeting a different occurrence with its own selector.
- For each occurrence, choose the MOST SPECIFIC, STABLE selector that uniquely targets the exact element in the provided html_excerpt:
  - Prefer #id or a short descendant path like 'main h1#title' or '.product-main h1.product-title'.
  - Avoid generic tags alone ('h1', 'main', 'body') unless they are unique in the provided html.
  - Do NOT use grouped selectors with commas, wildcards '*', or overly broad containers.
  - Ensure each selector matches EXACTLY ONE element in the provided html_excerpt. If multiple elements match, refine it with classes/ids/ancestor.
  - Include selector diagnostics in output where possible (e.g., fields.title.selector_note: 'unique in excerpt').
  - If there are multiple occurrences, set fields.<key>.selector to the PRIMARY/CANONICAL element (e.g., main PDP area), and cover other duplicates via extra patch steps.
- Build a patch array with objects of the form { selector, op: "setText"|"setHTML", value: string }.
  - It is valid to have multiple patch steps for the same field (e.g., two different title locations) using the same value text.
  - Do NOT use valueRef. Always resolve the actual string to write and put it in 'value'.
- Do not include scripts or external links. Keep HTML minimal (<p>, <ul>, <li>, <strong>, <em>).`;

      const messages = [
        { role: "system", content: SYS_PROMPT },
        { role: "user", content: JSON.stringify(payload) }
      ];

      const maxTokensEnv = Number(process.env.LLM_MAX_TOKENS || "");
      const NUM_PREDICT = Number.isFinite(maxTokensEnv) && maxTokensEnv > 0 ? Math.min(Math.floor(maxTokensEnv), 32000) : 1024;
      const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "https://ai.thewisemonkey.co.uk/ollama";
      const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gpt-oss";
      const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "";

      if (!OLLAMA_API_KEY) {
        await writer.write(encoder.encode(JSON.stringify({ error: "Server misconfiguration: OLLAMA_API_KEY is required" })));
        await writer.close();
        return;
      }

      const resp = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${OLLAMA_API_KEY}`,
        },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages,
          stream: false,
          options: { temperature: 0, num_predict: NUM_PREDICT }
        })
      });
      if (!resp.ok) {
        let errTxt = "";
        try { errTxt = await resp.text(); } catch {}
        throw new Error(`Ollama error ${resp.status}: ${errTxt || resp.statusText || "no body"}`);
      }
      const ollama = await resp.json();
      const txt = (ollama?.message?.content ?? "").trim() || "{}";
      const start = txt.indexOf("{");
      const end = txt.lastIndexOf("}");
      const raw = txt.slice(start, end + 1);
      let obj: any;
      try { obj = JSON.parse(raw); } catch {}
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
        await writer.write(encoder.encode(enriched));
        await writer.close();
        return;
      }
      console.debug("[PDP][api] openai response parsed", {
        took_ms: Date.now() - t0,
        content_len: txt.length,
        raw_len: raw.length,
      });
      await writer.write(encoder.encode(raw));
      await writer.close();
    } catch (e: any) {
      console.error("[PDP][api] error", e);
      try {
        await writer.write(encoder.encode(JSON.stringify({ error: String(e?.message || e) })));
      } catch {}
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, { status: 200, headers });
}