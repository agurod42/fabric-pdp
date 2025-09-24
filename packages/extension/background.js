
// background.js
const api = (typeof browser !== 'undefined') ? browser : chrome;
const PROXY_URL = "https://fabric-pdp.vercel.app/api/analyze"; // set your deployed URL

const sessionCache = new Map();

api.runtime.onInstalled.addListener(() => {
  api.storage.local.get(["whitelist"]).then(cfg => {
    if (!cfg || !Array.isArray(cfg.whitelist)) api.storage.local.set({ whitelist: [] });
  });
  api.action.setBadgeBackgroundColor({ color: "#00A86B" });
});

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "LLM_ANALYZE") {
        const plan = await callLLM(msg.payload);
        const key = `${sender.tab?.id}|${msg.payload.url}`;
        sessionCache.set(key, plan);
        sendResponse({ plan }); return;
      }
      if (msg.type === "SET_BADGE") {
        const tabId = sender.tab?.id;
        if (tabId != null) {
          await api.action.setBadgeText({ text: msg.text, tabId });
          await api.action.setBadgeBackgroundColor({ color: msg.text === "PDP" ? "#00A86B" : (msg.text === "ERR" ? "#D14343" : "#999999"), tabId });
        }
        sendResponse({ ok: true }); return;
      }
      if (msg.type === "CACHE_PLAN") {
        const key = `${sender.tab?.id}|${msg.url}`;
        sessionCache.set(key, msg.plan);
        sendResponse({ ok: true }); return;
      }
      if (msg.type === "GET_PLAN") {
        const key = `${sender.tab?.id}|${msg.url}`;
        sendResponse({ plan: sessionCache.get(key) }); return;
      }
      if (msg.type === "APPLY_PATCH") {
        await api.scripting.executeScript({ target: { tabId: sender.tab.id }, func: applyPatchInPage, args: [msg.plan] });
        sendResponse({ ok: true }); return;
      }
      if (msg.type === "SHOULD_RUN") {
        const cfg = await api.storage.local.get(["whitelist"]);
        const wl = cfg?.whitelist || [];
        const ok = shouldRun(msg.url, wl);
        sendResponse({ ok }); return;
      }
    } catch (e) { console.error(e); sendResponse({ error: String(e) }); }
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
  const resp = await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const txt = await resp.text();
  let plan; try { plan = JSON.parse(txt) } catch { throw new Error("LLM returned non-JSON"); }
  if (!plan || typeof plan.is_pdp !== "boolean") throw new Error("Invalid plan schema");

  const deny = /(?:<script|javascript:|on\w+=|<iframe|<object|fetch\(|XMLHttpRequest|WebSocket|eval|Function|import\(|window\.|document\.write|chrome\.|browser\.)/i;
  plan.patch = Array.isArray(plan.patch) ? plan.patch.filter(st => st && typeof st.selector === "string" && ["setText","setHTML"].includes(st.op) && typeof st.valueRef === "string") : [];
  for (const k of ["title","description","shipping","returns"]) {
    const f = plan.fields?.[k];
    if (f && typeof f.proposed === "string" && deny.test(f.proposed)) f.proposed = "";
  }
  return plan;
}

function applyPatchInPage(plan) {
  function get(path){ return path.split(".").reduce((a,k)=>a?.[k], plan); }
  const deny = /(?:<script|javascript:|on\w+=|<iframe|<object)/i;
  for (const step of (plan.patch || [])) {
    try {
      const node = document.querySelector(step.selector);
      if (!node) continue;
      const val = get(step.valueRef);
      if (typeof val !== "string") continue;
      if (deny.test(val)) continue;
      if (step.op === "setText") node.textContent = val;
      if (step.op === "setHTML") node.innerHTML = val;
    } catch(e){}
  }
}
