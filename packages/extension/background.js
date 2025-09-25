
// background.js
const api = (typeof browser !== 'undefined') ? browser : chrome;
const PROXY_URL = "https://fabric-pdp.vercel.app/api/analyze"; // set your deployed URL
const DEBUG = true;
const log = (...args) => { if (DEBUG) console.debug("[PDP][bg]", ...args); };

const sessionCache = new Map();

api.runtime.onInstalled.addListener(() => {
  log("onInstalled");
  api.storage.local.get(["whitelist"]).then(cfg => {
    if (!cfg || !Array.isArray(cfg.whitelist)) api.storage.local.set({ whitelist: [] });
  });
  api.action.setBadgeBackgroundColor({ color: "#00A86B" });
});

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  log("message", { type: msg?.type, tabId: sender?.tab?.id });
  (async () => {
    try {
      if (msg.type === "LLM_ANALYZE") {
        log("LLM_ANALYZE start", { url: msg?.payload?.url });
        const plan = await callLLM(msg.payload);
        const key = `${sender.tab?.id}|${msg.payload.url}`;
        sessionCache.set(key, plan);
        log("LLM_ANALYZE done", { is_pdp: !!plan?.is_pdp, patch: plan?.patch?.length || 0 });
        sendResponse({ plan }); return;
      }
      if (msg.type === "SET_BADGE") {
        const tabId = sender.tab?.id;
        if (tabId != null) {
          await api.action.setBadgeText({ text: msg.text, tabId });
          await api.action.setBadgeBackgroundColor({ color: msg.text === "PDP" ? "#00A86B" : (msg.text === "ERR" ? "#D14343" : "#999999"), tabId });
        }
        log("SET_BADGE", { tabId, text: msg.text });
        sendResponse({ ok: true }); return;
      }
      if (msg.type === "CACHE_PLAN") {
        const key = `${sender.tab?.id}|${msg.url}`;
        sessionCache.set(key, msg.plan);
        log("CACHE_PLAN", { key });
        sendResponse({ ok: true }); return;
      }
      if (msg.type === "GET_PLAN") {
        const key = `${sender.tab?.id}|${msg.url}`;
        const plan = sessionCache.get(key);
        log("GET_PLAN", { key, found: !!plan });
        sendResponse({ plan }); return;
      }
      if (msg.type === "APPLY_PATCH") {
        log("APPLY_PATCH start", { tabId: sender?.tab?.id, steps: msg?.plan?.patch?.length || 0 });
        await api.scripting.executeScript({ target: { tabId: sender.tab.id }, func: applyPatchInPage, args: [msg.plan] });
        log("APPLY_PATCH done");
        sendResponse({ ok: true }); return;
      }
      if (msg.type === "SHOULD_RUN") {
        const cfg = await api.storage.local.get(["whitelist"]);
        const wl = cfg?.whitelist || [];
        const ok = shouldRun(msg.url, wl);
        log("SHOULD_RUN", { url: msg.url, whitelistCount: wl.length, ok });
        sendResponse({ ok }); return;
      }
    } catch (e) { console.error("[PDP][bg] handler error", e); sendResponse({ error: String(e) }); }
  })();
  return true;
});

function shouldRun(urlStr, wl) {
  if (!Array.isArray(wl) || wl.length === 0) return true;
  try {
    const host = new URL(urlStr).hostname;
    return wl.some(p => new RegExp(patternToRegex(p)).test(host));
  } catch { return false; }
}
function patternToRegex(pattern) {
  return "^" + pattern.replace(/\./g,"\\.").replace(/\*/g,".*") + "$";
}

async function callLLM(payload) {
  const t0 = Date.now();
  try {
    const approx = {
      html_excerpt_len: typeof payload?.html_excerpt === "string" ? payload.html_excerpt.length : 0,
    };
    log("callLLM → fetch", { url: payload?.url, approx });
    const resp = await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    log("callLLM ← response", { status: resp.status, took_ms: Date.now() - t0 });
    const txt = await resp.text();
    let plan; try { plan = JSON.parse(txt) } catch (e) {
      log("callLLM parse error", { took_ms: Date.now() - t0, text_len: txt.length, snippet: txt });
      throw new Error("LLM returned non-JSON");
    }
    if (!plan || typeof plan.is_pdp !== "boolean") {
      log("callLLM schema invalid", { keys: Object.keys(plan || {}) });
      throw new Error("Invalid plan schema");
    }
    const deny = /(?:<script|javascript:|on\w+=|<iframe|<object|fetch\(|XMLHttpRequest|WebSocket|eval|Function|import\(|window\.|document\.write|chrome\.|browser\.)/i;
    plan.patch = Array.isArray(plan.patch) ? plan.patch.filter(st => st && typeof st.selector === "string" && ["setText","setHTML"].includes(st.op) && typeof st.valueRef === "string") : [];
    for (const k of ["title","description","shipping","returns"]) {
      const f = plan.fields?.[k];
      if (f && typeof f.proposed === "string" && deny.test(f.proposed)) f.proposed = "";
    }
    log("callLLM parsed", { is_pdp: plan.is_pdp, patch: plan.patch.length, took_ms: Date.now() - t0 });
    return plan;
  } catch (e) {
    console.error("[PDP][bg] callLLM error", e);
    throw e;
  }
}

function applyPatchInPage(plan) {
  const log = (...args) => { try { console.debug("[PDP][apply]", ...args); } catch(_){} };
  function get(path){ return path.split(".").reduce((a,k)=>a?.[k], plan); }
  const deny = /(?:<script|javascript:|on\w+=|<iframe|<object)/i;
  log("apply start", { steps: (plan.patch || []).length });
  for (const step of (plan.patch || [])) {
    try {
      const node = document.querySelector(step.selector);
      if (!node) { log("selector not found", step.selector); continue; }
      const val = get(step.valueRef);
      if (typeof val !== "string") { log("value not string", step.valueRef); continue; }
      if (deny.test(val)) { log("value denied", step.valueRef); continue; }
      if (step.op === "setText") { node.textContent = val; log("setText", step.selector); }
      if (step.op === "setHTML") { node.innerHTML = val; log("setHTML", step.selector); }
    } catch(e){}
  }
  log("apply end");
}
