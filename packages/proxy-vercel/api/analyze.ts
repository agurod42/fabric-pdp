
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
        description: { selector: ".product-description, main", original: "", proposed: "<p>This is a mock rewrite. Add OPENAI_API_KEY in Vercel to enable real output.</p>", html: true },
        shipping: { selector: ".shipping, .policy-shipping", original: "", proposed: "<ul><li>Free shipping over $50</li><li>2–5 business days</li></ul>", html: true },
        returns: { selector: ".returns, .policy-returns", original: "", proposed: "<ul><li>30-day returns</li><li>Prepaid label</li></ul>", html: true }
      } : {},
      patch: isPdp ? [
        { selector: "h1", op: "setText", valueRef: "fields.title.proposed" },
        { selector: ".product-description, main", op: "setHTML", valueRef: "fields.description.proposed" }
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
- Build a patch array with selectors + setText/setHTML + valueRef to proposed values.
- Do not include scripts or external links. Keep HTML minimal (<p>, <ul>, <li>, <strong>, <em>).`;

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYS_PROMPT },
      { role: "user", content: JSON.stringify(payload) }
    ];

    const resp = await oai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.2,
      max_tokens: 500,
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
