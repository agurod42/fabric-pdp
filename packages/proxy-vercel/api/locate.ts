export const config = { runtime: "edge" };
import { jsonResponse, createStream, buildOpenAIEnv, buildOpenAIHeaders } from "./_utils";

export default async function handler(req: Request) {
  if (req.method === "OPTIONS") return jsonResponse({}, 204);
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);

  const body = await req.json().catch(() => ({} as any));
  const { url, language, image_data_url, image_pixel_width, image_pixel_height, device_pixel_ratio, page_width_css, page_height_css, trace_id } = body as any;
  const traceId = (typeof trace_id === "string" && trace_id) ? trace_id : "";

  const { readable, writer, encoder, headers } = createStream();
  (async () => {
    try {
      await writer.write(encoder.encode(" "));

      const { base: OPENAI_BASE, model: OPENAI_MODEL, apiKey: OPENAI_API_KEY } = buildOpenAIEnv();
      if (!OPENAI_API_KEY) {
        await writer.write(encoder.encode(JSON.stringify({ error: "Server misconfiguration: OPENAI_API_KEY is required" })));
        await writer.close();
        return;
      }

      if (typeof image_data_url !== 'string' || !image_data_url.startsWith('data:image/')) {
        await writer.write(encoder.encode(JSON.stringify({ error: "image_data_url required (data URL)" })));
        await writer.close();
        return;
      }

      const prompt = {
        instructions: `You are an OCR + layout understanding assistant for PDPs. Analyze the provided image and extract all occurrences of product title, description, shipping, and returns.

        Requirements for bounding boxes:
        - Coordinates are in IMAGE PIXELS of the provided image (not CSS units)
        - bbox fields MUST be INTEGERS
        - x in [0, W-1], y in [0, H-1]
        - width >= 1, height >= 1
        - Boxes MUST be clipped to image bounds (x + width <= W, y + height <= H)

        For each detection, include a short extracted text and a safe proposed value. Proposed values:
        - title: <= 70 chars
        - description: minimal HTML (<p>, <ul>, <li>, <strong>, <em>)
        - shipping/returns: <ul><li>…</li></ul> bullets

        Output STRICT JSON with key \"detections\": array of { id, type in [title|description|shipping|returns], bbox: { x,y,width,height }, extracted: string, proposed: string } only.`,
        url: typeof url === 'string' ? url : '',
        language: typeof language === 'string' ? language : '',
        image_meta: {
          image_pixel_width: Number(image_pixel_width) || 0,
          image_pixel_height: Number(image_pixel_height) || 0,
          device_pixel_ratio: Number(device_pixel_ratio) || 1,
          page_width_css: Number(page_width_css) || 0,
          page_height_css: Number(page_height_css) || 0,
        }
      };

      // OpenAI vision-style input: use content array with an image_url part
      const messages = [
        { role: "system", content: "Return STRICT JSON." },
        { role: "user", content: [
          { type: "text", text: JSON.stringify(prompt) },
          { type: "image_url", image_url: { url: image_data_url } }
        ] as any }
      ];

      const headersInit: Record<string, string> = buildOpenAIHeaders(OPENAI_API_KEY, traceId);
      const resp = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: headersInit,
        body: JSON.stringify({ model: OPENAI_MODEL, messages, temperature: 0, response_format: { type: "json_object" } })
      });
      if (!resp.ok) {
        let errTxt = ""; try { errTxt = await resp.text(); } catch {}
        throw new Error(`OpenAI error ${resp.status}: ${errTxt || resp.statusText || "no body"}`);
      }
      const openai = await resp.json();
      const txt = (openai?.choices?.[0]?.message?.content ?? "").trim() || "{}";
      const start = txt.indexOf("{");
      const end = txt.lastIndexOf("}");
      const raw = txt.slice(start, end + 1);
      let obj: any = {};
      try { obj = JSON.parse(raw); } catch {}

      const W = Number(image_pixel_width) || 0;
      const H = Number(image_pixel_height) || 0;
      const out = { detections: [] as any[] };
      if (obj && Array.isArray(obj.detections)) {
        for (const d of obj.detections) {
          const type = (d?.type === 'title' || d?.type === 'description' || d?.type === 'shipping' || d?.type === 'returns') ? d.type : null;
          const b = d?.bbox || {};
          let x = Number(b?.x), y = Number(b?.y), w = Number(b?.width), h = Number(b?.height);
          if (!type || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
          if (w < 0) { x = x + w; w = Math.abs(w); }
          if (h < 0) { y = y + h; h = Math.abs(h); }
          if (W > 0) x = Math.max(0, Math.min(x, W - 1));
          if (H > 0) y = Math.max(0, Math.min(y, H - 1));
          if (W > 0) w = Math.min(Math.max(1, w), W - x);
          if (H > 0) h = Math.min(Math.max(1, h), H - y);
          x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
          if (w < 1 || h < 1) continue;
          out.detections.push({
            id: typeof d?.id === 'string' ? d.id : `${type}:${x},${y}`,
            type,
            bbox: { x, y, width: w, height: h },
            extracted: typeof d?.extracted === 'string' ? d.extracted : '',
            proposed: typeof d?.proposed === 'string' ? d.proposed : '',
          });
        }
      }

      await writer.write(encoder.encode(JSON.stringify(out)));
      await writer.close();
    } catch (e: any) {
      try { await writer.write(encoder.encode(JSON.stringify({ error: String(e?.message || e) }))); } catch {}
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, { status: 200, headers });
}


