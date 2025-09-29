// strategies/llmStrategy.js — LLM strategy and network call implementation
(function(){
const PROXY_URL = "https://fabric-pdp.vercel.app/api/analyze";

function localMakeTraceId(){
  try {
    const arr = new Uint8Array(8);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    const hex = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
    return `pdp-${hex}`;
  } catch {
    return `pdp-${Date.now().toString(16)}`;
  }
}

async function callLLM(payload) {
  const traceId = (typeof self.makeTraceId === 'function') ? self.makeTraceId() : localMakeTraceId();
  try {
    const body = JSON.stringify({ ...payload, trace_id: traceId });
    const resp = await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "x-trace-id": traceId }, body });
    const text = await resp.text();
    let plan;
    try { plan = JSON.parse(text); } catch(e) {
      throw e;
    }
    if (plan && typeof plan.error === 'string' && plan.error.trim().length > 0) {
      throw new Error(String(plan.error));
    }
    if (!plan || typeof plan.is_pdp !== "boolean") {
      throw new Error("Invalid plan schema");
    }
    const deny = /(?:<script|javascript:|on\w+=|<iframe|<object|fetch\(|XMLHttpRequest|WebSocket|eval|Function|import\(|window\.|document\.write|chrome\.|browser\.)/i;
    plan.patch = Array.isArray(plan.patch) ? plan.patch.filter(st => st && typeof st.selector === "string" && ["setText","setHTML"].includes(st.op)) : [];
    for (const k of ["title","description","shipping","returns"]) {
      const f = plan.fields?.[k];
      if (f && typeof f.proposed === "string" && deny.test(f.proposed)) f.proposed = "";
    }
    return plan;
  } catch (e) {
    try { console.error("[PDP][llm] call error", { traceId, error: e }); } catch {}
    throw e;
  }
}

async function llmStrategy(payload /*, ctx */) {
  return await callLLM(payload);
}

self.llmStrategy = llmStrategy;
})();
