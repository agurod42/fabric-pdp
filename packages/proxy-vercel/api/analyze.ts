
export const config = { runtime: "edge" };
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

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

  const { url, title, meta, html_excerpt, html_truncated, language } = await req.json().catch((e) => {
    console.error("[PDP][api] JSON parse error:", e);
    return {};
  });

  try {
    const sizes = {
      html_excerpt_len: typeof html_excerpt === "string" ? html_excerpt.length : 0,
      meta_keys: meta ? Object.keys(meta).length : 0,
    };
    console.debug("[PDP][api] request", { url, lang: language, sizes, html_truncated: !!html_truncated });
  } catch {}

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.warn("[PDP][api] OPENAI_API_KEY not set; returning mock response");
    // Simple fallback mock: classify as PDP only if title contains product-like words
    const isPdp = /buy|cart|add to cart|product|sku|variant/i.test(String(title || ""));
    return jsonResponse({
      is_pdp: !!isPdp,
      evidence: ["vercel-mock (no OPENAI_API_KEY)"],
      fields: isPdp ? {
        title: { selector: "h1", original: title || "", proposed: "Premium Product — Reinvented", html: false },
        description: { selector: ".product-description", original: "", proposed: "<p>This is a mock rewrite. Add OPENAI_API_KEY in Vercel to enable real output.</p>", html: true },
        shipping: { selector: ".shipping, .policy-shipping", original: "", proposed: "<ul><li>Free shipping over $50</li><li>2–5 business days</li></ul>", html: true },
        returns: { selector: ".returns, .policy-returns", original: "", proposed: "<ul><li>30-day returns</li><li>Prepaid label</li></ul>", html: true }
      } : {},
      patch: isPdp ? [
        { selector: "h1", op: "setText", valueRef: "fields.title.proposed" },
        { selector: ".product-description", op: "setHTML", valueRef: "fields.description.proposed" }
      ] : []
    });
  }

  try {
    // Server-side truncation and payload slimming
    const BUDGET = 200000; // allow larger sanitized HTML
    const safe = (s) => (typeof s === "string" ? s : "");
    const payload = {
      url: safe(url).slice(0, 2048),
      title: safe(title).slice(0, 512),
      meta: meta ? Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, safe(v).slice(0, 512)])) : {},
      language: safe(language).slice(0, 16),
      html_excerpt: safe(html_excerpt).slice(0, BUDGET),
      html_truncated: !!html_truncated,
    };

    const oai = new OpenAI({ apiKey: openaiKey });
    const SYS_PROMPT = `You are a careful extractor. Output STRICT JSON only, matching the schema.
Rules:
- Determine if the page is a merchant Product Detail Page.
- If is_pdp=true, extract title/description/shipping/returns + selectors where found.
- Propose improved content: title <= 70 chars; description 120–200 words; shipping/returns 3–6 bullets each.
- For each field, choose the MOST SPECIFIC, STABLE selector that uniquely targets the exact element in the provided html_excerpt:
  - Prefer #id or a short descendant path like 'main h1#title' or '.product-main h1.product-title'.
  - Avoid generic tags alone ('h1', 'main', 'body') unless they are unique in the provided html.
  - Do NOT use grouped selectors with commas, wildcards '*', or overly broad containers.
  - Ensure the selector would match EXACTLY ONE element in the provided html_excerpt. If multiple elements match, refine it with classes/ids/ancestor.
  - Include selector diagnostics in output where possible (e.g., fields.title.selector_note: 'unique in excerpt').
- Build a patch array with objects of the form { selector, op: "setText"|"setHTML", valueRef?: string, value?: string }. Prefer valueRef pointing to proposed fields (e.g., "fields.title.proposed"). Use value only if you cannot reference a field.
- Do not include scripts or external links. Keep HTML minimal (<p>, <ul>, <li>, <strong>, <em>).`;

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYS_PROMPT },
      { role: "user", content: JSON.stringify(payload) }
    ];

    const maxTokensEnv = Number(process.env.LLM_MAX_TOKENS || "");
    const MAX_TOKENS = Number.isFinite(maxTokensEnv) && maxTokensEnv > 0 ? Math.min(Math.floor(maxTokensEnv), 32000) : 5000;
    const resp = await oai.chat.completions.create({
      model: process.env.LLM_MODEL || "gpt-4o",
      messages,
      temperature: 0.2,
      max_tokens: MAX_TOKENS,
      response_format: { type: "json_object" }
    });

    const txt = resp.choices?.[0]?.message?.content?.trim() || "{}";
    const start = txt.indexOf("{");
    const end = txt.lastIndexOf("}");
    const raw = txt.slice(start, end + 1);
    let obj;
    try { obj = JSON.parse(raw); } catch {}
    if (obj && typeof obj === 'object') {
      if (!Array.isArray(obj.warnings)) obj.warnings = [];
      if (payload.html_truncated) obj.warnings.push("Input HTML was truncated before analysis; results may be incomplete.");
      // Normalize patch to always use { selector, op, value|valueRef }
      type PatchStep = { selector: string; op: "setText" | "setHTML"; valueRef?: string; value?: string };
      const looksLikeRef = (s: string): boolean => {
        return typeof s === 'string' && /^fields\.(title|description|shipping|returns)\.(proposed|original)$/.test(s.trim());
      };
      const normalizePatch = (arr: any): PatchStep[] => {
        if (!Array.isArray(arr)) return [];
        const normalized: PatchStep[] = [];
        for (const st of arr as any[]) {
          if (!st || typeof st.selector !== "string") continue;
          const op = st.op || (st.setText ? "setText" : (st.setHTML ? "setHTML" : undefined));
          if (op !== "setText" && op !== "setHTML") continue;
          let value;
          let valueRef;
          if (typeof st.value === "string") {
            value = st.value;
          } else if (typeof st.valueRef === "string") {
            // Treat as ref only for known safe ref patterns; otherwise it's a literal value
            if (looksLikeRef(st.valueRef)) valueRef = st.valueRef.trim();
            else value = st.valueRef;
          }
          const out: PatchStep = { selector: st.selector, op };
          if (typeof valueRef === "string" && valueRef.length > 0) out.valueRef = valueRef;
          else if (typeof value === "string") out.value = value;
          else continue;
          normalized.push(out);
        }
        return normalized;
      };
      obj.patch = normalizePatch(obj.patch);
      // Ensure fields.*.proposed strings exist for references; fallback to empty strings
      const ensure = (k: string) => {
        const f = obj.fields?.[k];
        if (!obj.fields) obj.fields = {};
        if (!f || typeof f !== 'object') obj.fields[k] = { selector: '', original: '', proposed: '', html: (k !== 'title') };
        else {
          if (typeof f.proposed !== 'string') f.proposed = '';
          if (typeof f.original !== 'string') f.original = '';
          if (typeof f.selector !== 'string') f.selector = '';
          if (typeof f.html !== 'boolean') f.html = (k !== 'title');
        }
      };
      ensure('title'); ensure('description'); ensure('shipping'); ensure('returns');
      // Re-serialize enriched object
      const enriched = JSON.stringify(obj);
      return new Response(enriched, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "POST, OPTIONS",
        },
      });
    }
    console.debug("[PDP][api] openai response parsed", {
      took_ms: Date.now() - t0,
      content_len: txt.length,
      raw_len: raw.length,
    });
    return new Response(raw, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "POST, OPTIONS",
      },
    });
  } catch (e) {
    console.error("[PDP][api] error", e);
    return jsonResponse({ error: String(e?.message || e) }, 500);
  }
}
