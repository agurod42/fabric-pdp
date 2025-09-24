
export const config = { runtime: "edge" };
import OpenAI from "openai";

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
  if (req.method === "OPTIONS") return jsonResponse({}, 204);
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);

  const { url, title, meta, heuristics, html_excerpt, language } = await req.json().catch(() => ({}));

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    const isPdp = heuristics?.hasPrice && heuristics?.hasAddToCart;
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
    const oai = new OpenAI({ apiKey: openaiKey });
    const SYS_PROMPT = `You are a careful extractor. Output STRICT JSON only, matching the schema.
Rules:
- Determine if the page is a merchant Product Detail Page.
- If is_pdp=true, extract title/description/shipping/returns + selectors where found.
- Propose improved content: title <= 70 chars; description 120–200 words; shipping/returns 3–6 bullets each.
- Build a patch array with selectors + setText/setHTML + valueRef to proposed values.
- Do not include scripts or external links. Keep HTML minimal (<p>, <ul>, <li>, <strong>, <em>).`;

    const messages = [
      { role: "system", content: SYS_PROMPT },
      { role: "user", content: JSON.stringify({ url, title, meta, heuristics, language, html_excerpt }) }
    ];

    const resp = await oai.chat.completions.create({
      model: "gpt-4o",
      messages,
      temperature: 0.2,
      max_tokens: 900
    });

    const txt = resp.choices?.[0]?.message?.content?.trim() || "{}";
    const start = txt.indexOf("{");
    const end = txt.lastIndexOf("}");
    const raw = txt.slice(start, end + 1);
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
    return jsonResponse({ error: String(e?.message || e) }, 500);
  }
}
