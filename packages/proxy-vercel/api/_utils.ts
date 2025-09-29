export const COMMON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "POST, OPTIONS",
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: COMMON_HEADERS });
}

export function createStream() {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const headers: Record<string, string> = { ...COMMON_HEADERS };
  return { readable, writer, encoder, headers };
}

// (removed) readJsonSafe and safeString are unused

export function buildOpenAIEnv() {
  const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const apiKey = process.env.OPENAI_API_KEY || "";
  return { base, model, apiKey };
}

export function buildOpenAIHeaders(apiKey: string, traceId?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (traceId) headers["x-trace-id"] = traceId;
  return headers;
}


