export const config = { runtime: "edge" };

function jsonResponse(body: any, status = 200) {
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

export default async function handler(req: Request) {
  const t0 = Date.now();
  if (req.method === "OPTIONS") return jsonResponse({}, 204);
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);

  const body = await req.json().catch((e) => {
    console.error("[PDP][api][generate] JSON parse error:", e);
    return {} as any;
  });
  const { url, language, title, description, shipping, returns, trace_id } = body as any;
  const traceId = (typeof trace_id === "string" && trace_id) ? trace_id : "";

  // Prepare streaming response
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

  (async () => {
    try {
      await writer.write(encoder.encode(" "));

      const OPENAI_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
      const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
      const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
      if (!OPENAI_API_KEY) {
        await writer.write(encoder.encode(JSON.stringify({ error: "Server misconfiguration: OPENAI_API_KEY is required" })));
        await writer.close();
        return;
      }

      const safe = (s: any) => (typeof s === "string" ? s : "");
      const input = {
        url: safe(url),
        language: safe(language),
        title: safe(title),
        description: safe(description),
        shipping: safe(shipping),
        returns: safe(returns),
        trace_id: traceId,
      };

      const SYS_PROMPT = `
        You generate concise, safe PDP copy. Output STRICT JSON only with keys: { "title": string, "description": string, "shipping": string, "returns": string }.

        Rules:
        - Use the provided language when non-empty; otherwise infer from inputs.
        - title: <= 70 chars, remove branding/store name, avoid clickbait, reflect product succinctly.
        - description: 120–200 words in minimal HTML (<p>, <ul>, <li>, <strong>, <em> only), factual and derived from inputs.
        - shipping and returns: each 3–6 bullet points in <ul><li>…</li></ul>. If inputs lack details, produce generic, safe bullets clearly worded.
        - No scripts, external resources, or links. Sanitized HTML only.
      `;

      const messages = [
        { role: "system", content: SYS_PROMPT },
        { role: "user", content: JSON.stringify(input) }
      ];

      const headersInit: Record<string, string> = {
        "content-type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      };
      if (traceId) headersInit["x-trace-id"] = traceId;

      const tFetchStart = Date.now();
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
      if (!resp.ok) {
        let errTxt = "";
        try { errTxt = await resp.text(); } catch {}
        throw new Error(`OpenAI error ${resp.status}: ${errTxt || resp.statusText || "no body"}`);
      }
      const openai = await resp.json();
      const txt = (openai?.choices?.[0]?.message?.content ?? "").trim() || "{}";
      const start = txt.indexOf("{");
      const end = txt.lastIndexOf("}");
      const raw = txt.slice(start, end + 1);
      let obj: any = {};
      try { obj = JSON.parse(raw); } catch {}

      const out = {
        title: typeof obj.title === 'string' ? obj.title : '',
        description: typeof obj.description === 'string' ? obj.description : '',
        shipping: typeof obj.shipping === 'string' ? obj.shipping : '',
        returns: typeof obj.returns === 'string' ? obj.returns : '',
      };

      await writer.write(encoder.encode(JSON.stringify(out)));
      await writer.close();
    } catch (e: any) {
      console.error("[PDP][api][generate] error", { traceId, error: e });
      try {
        await writer.write(encoder.encode(JSON.stringify({ error: String(e?.message || e) })));
      } catch {}
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, { status: 200, headers });
}


