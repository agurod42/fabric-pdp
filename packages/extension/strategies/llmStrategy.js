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
    try {
      // Normal path
      plan = JSON.parse(text);
    } catch (e) {
      // Fallback: attempt to extract first JSON object from noisy payload
      try {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) {
          const obj = text.slice(start, end + 1);
          plan = JSON.parse(obj);
        } else {
          throw e;
        }
      } catch (e2) {
        const snippet = text.slice(0, 320);
        throw new Error(`Invalid JSON from proxy (traceId=${traceId}): ${String(e2 && e2.message || e2)}\n---\n${snippet}`);
      }
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
  // Pre-check PDP likelihood using shared evaluator; skip LLM if unlikely
  try {
    if (typeof self.evaluatePdpSignals === 'function') {
      const { score, strong_product } = self.evaluatePdpSignals(payload) || { score: 0, strong_product: false };
      let threshold = 10;
      try {
        const api = (typeof browser !== 'undefined') ? browser : chrome;
        const cfg = await api.storage.local.get(["pdpSettings"]);
        const p = cfg?.pdpSettings;
        if (p && typeof p.minScoreToContinue === 'number') threshold = p.minScoreToContinue;
      } catch {}
      try { console.debug('[PDP][llm] evaluatePdpSignals score', score, { url: payload?.url, strong_product }); } catch {}
      const gate = (typeof score === 'number' && score > threshold) || !!strong_product;
      if (!gate) {
        return {
          is_pdp: false,
          confidence: 0,
          language: String(payload?.language || ''),
          url: String(payload?.url || ''),
          trace_id: '',
          fields: { title: { selector: '', selector_note: '', extracted: '', proposed: '' }, description: { selector: '', selector_note: '', extracted: '', proposed: '' }, shipping: { selector: '', selector_note: '', extracted: '', proposed: '' }, returns: { selector: '', selector_note: '', extracted: '', proposed: '' } },
          patch: [],
          diagnostics: { pdp_signals: [], anti_pdp_signals: [], duplicates_covered: [] },
          warnings: ["Skipped LLM: below threshold and not strong product"]
        };
      }
    }
  } catch {}
  return await callLLM(payload);
}

self.llmStrategy = llmStrategy;
})();
