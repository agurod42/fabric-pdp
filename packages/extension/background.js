
// background.js
const api = (typeof browser !== 'undefined') ? browser : chrome;
const PROXY_URL = "https://fabric-pdp.vercel.app/api/analyze"; // set your deployed URL
const DEBUG = true;
const log = (...args) => { if (DEBUG) console.debug("[PDP][bg]", ...args); };

const sessionCache = new Map();
const storageArea = (api?.storage && api.storage.session) ? api.storage.session : api.storage.local;
async function cacheSet(key, value) {
  try { await storageArea.set({ [key]: value }); } catch(e) { log("cacheSet error", e?.message || e); }
}
async function cacheGet(key) {
  try { const obj = await storageArea.get([key]); return obj?.[key]; } catch(e) { log("cacheGet error", e?.message || e); return undefined; }
}

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
        const tabId = sender.tab?.id;
        const errKey = (tabId != null) ? `error:${tabId}` : undefined;
        try {
          const plan = await callLLM(msg.payload);
          if (tabId != null) {
            const key = `plan:${tabId}`;
            sessionCache.set(key, plan);
            try { await cacheSet(key, plan); } catch {}
            // clear any previous error for this tab
            try { if (errKey) { sessionCache.set(errKey, ""); await cacheSet(errKey, ""); } } catch {}
          }
          log("LLM_ANALYZE done", { is_pdp: !!plan?.is_pdp, patch: plan?.patch?.length || 0 });
          sendResponse({ plan }); return;
        } catch (e) {
          const msgStr = String(e?.message || e);
          try { if (errKey) { sessionCache.set(errKey, msgStr); await cacheSet(errKey, msgStr); } } catch {}
          log("LLM_ANALYZE error", { error: msgStr });
          sendResponse({ error: msgStr }); return;
        }
      }
      if (msg.type === "SET_BADGE") {
        const tabId = (typeof msg.tabId === 'number') ? msg.tabId : sender.tab?.id;
        if (tabId != null) {
          await api.action.setBadgeText({ text: msg.text, tabId });
          const color = (msg.text === "PDP") ? "#00A86B"
            : (msg.text === "ERR") ? "#D14343"
            : (msg.text === "…") ? "#2B6CB0" // analyzing
            : (msg.text === "AP") ? "#F0B429" // applying
            : "#999999";
          await api.action.setBadgeBackgroundColor({ color, tabId });
        }
        log("SET_BADGE", { tabId, text: msg.text });
        sendResponse({ ok: true }); return;
      }
      if (msg.type === "CACHE_PLAN") {
        const tabId = (typeof msg.tabId === 'number') ? msg.tabId : sender.tab?.id;
        if (tabId != null) {
          const key = `plan:${tabId}`;
          sessionCache.set(key, msg.plan);
          try { await cacheSet(key, msg.plan); } catch {}
          log("CACHE_PLAN", { key });
        }
        sendResponse({ ok: true }); return;
      }
      if (msg.type === "GET_PLAN") {
        const tabId = (typeof msg.tabId === 'number') ? msg.tabId : sender.tab?.id;
        const key = (tabId != null) ? `plan:${tabId}` : undefined;
        let plan = key ? sessionCache.get(key) : undefined;
        if (!plan && key) {
          plan = await cacheGet(key);
          if (plan) sessionCache.set(key, plan);
        }
        log("GET_PLAN", { key, found: !!plan });
        sendResponse({ plan }); return;
      }
      if (msg.type === "APPLY_PATCH") {
        const tabId = (typeof msg.tabId === 'number') ? msg.tabId : sender?.tab?.id;
        const steps = msg?.plan?.patch?.length || 0;
        const t0 = Date.now();
        log("APPLY_PATCH start", { tabId, steps });
        try {
          if (tabId != null) {
            try { await api.action.setBadgeText({ text: "AP", tabId }); await api.action.setBadgeBackgroundColor({ color: "#F0B429", tabId }); } catch {}
          }
          const results = await api.scripting.executeScript({ target: { tabId }, func: applyPatchInPage, args: [msg.plan] });
          const summary = Array.isArray(results) ? (results[0]?.result ?? null) : null;
          log("APPLY_PATCH done", { took_ms: Date.now() - t0, summary });
          try {
            const key = (tabId != null) ? `summary:${tabId}` : undefined;
            if (key) {
              sessionCache.set(key, summary);
              try { await cacheSet(key, summary); } catch {}
              log("APPLY_PATCH cached summary", { key });
            }
          } catch {}
          sendResponse({ ok: true, summary }); return;
        } catch (e) {
          console.error("[PDP][bg] APPLY_PATCH error", e);
          try {
            const errKey = (tabId != null) ? `error:${tabId}` : undefined;
            const msgStr = String(e?.message || e);
            if (errKey) { sessionCache.set(errKey, msgStr); try { await cacheSet(errKey, msgStr); } catch {} }
          } catch {}
          sendResponse({ error: String(e) }); return;
        }
      }
      if (msg.type === "GET_APPLY_SUMMARY") {
        const tabId = (typeof msg.tabId === 'number') ? msg.tabId : sender.tab?.id;
        const key = (tabId != null) ? `summary:${tabId}` : undefined;
        let summary = key ? sessionCache.get(key) : undefined;
        if (!summary && key) {
          summary = await cacheGet(key);
          if (summary) sessionCache.set(key, summary);
        }
        log("GET_APPLY_SUMMARY", { key, found: !!summary });
        sendResponse({ summary }); return;
      }
      if (msg.type === "GET_LAST_ERROR") {
        const tabId = (typeof msg.tabId === 'number') ? msg.tabId : sender.tab?.id;
        const key = (tabId != null) ? `error:${tabId}` : undefined;
        let err = key ? sessionCache.get(key) : undefined;
        if (!err && key) {
          err = await cacheGet(key);
          if (err) sessionCache.set(key, err);
        }
        const has = typeof err === 'string' && err.trim().length > 0;
        log("GET_LAST_ERROR", { key, has });
        sendResponse({ error: has ? err : null }); return;
      }
      if (msg.type === "SET_LAST_ERROR") {
        const tabId = (typeof msg.tabId === 'number') ? msg.tabId : sender.tab?.id;
        const key = (tabId != null) ? `error:${tabId}` : undefined;
        const val = String(msg.error || msg.message || "");
        if (key) {
          sessionCache.set(key, val);
          try { await cacheSet(key, val); } catch {}
          log("SET_LAST_ERROR", { key, len: val.length });
        }
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

function makeTraceId() {
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
  const t0 = Date.now();
  const traceId = makeTraceId();
  try {
    const approx = {
      html_excerpt_len: typeof payload?.html_excerpt === "string" ? payload.html_excerpt.length : 0,
    };
    log("callLLM → fetch", { traceId, url: payload?.url, approx });
    const body = JSON.stringify({ ...payload, trace_id: traceId });
    const resp = await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "x-trace-id": traceId }, body });
    const text = await resp.text();
    let plan;
    try { plan = JSON.parse(text); } catch(e) {
      log("callLLM parse error", { traceId, error: String(e?.message || e), text_len: text?.length || 0 });
      throw e;
    }
    log("callLLM ← response", { traceId, status: resp.status, took_ms: Date.now() - t0, bytes: text?.length || 0, keys: Object.keys(plan || {}) });
    if (!plan || typeof plan.is_pdp !== "boolean") {
      log("callLLM schema invalid", { traceId, keys: Object.keys(plan || {}) });
      throw new Error("Invalid plan schema");
    }
    const deny = /(?:<script|javascript:|on\w+=|<iframe|<object|fetch\(|XMLHttpRequest|WebSocket|eval|Function|import\(|window\.|document\.write|chrome\.|browser\.)/i;
    // Minimal validation: ensure array and allowed ops
    plan.patch = Array.isArray(plan.patch) ? plan.patch.filter(st => st && typeof st.selector === "string" && ["setText","setHTML"].includes(st.op)) : [];
    for (const k of ["title","description","shipping","returns"]) {
      const f = plan.fields?.[k];
      if (f && typeof f.proposed === "string" && deny.test(f.proposed)) f.proposed = "";
    }
    log("callLLM parsed", { traceId, is_pdp: plan.is_pdp, patch: plan.patch.length, took_ms: Date.now() - t0 });
    return plan;
  } catch (e) {
    console.error("[PDP][bg] callLLM error", { traceId, error: e });
    throw e;
  }
}

function applyPatchInPage(plan) {
  const log = (...args) => { try { console.debug("[PDP][apply]", ...args); } catch(_){} };
  const deny = /(?:<script|javascript:|on\w+=|<iframe|<object)/i;
  const PREFIX = "[PDP] ";
  const ensurePrefixed = (s) => (typeof s === "string" && !s.startsWith(PREFIX)) ? (PREFIX + s) : s;
  const t0 = Date.now();
  const steps = Array.isArray(plan.patch) ? plan.patch : [];
  const results = [];
  log("apply start", { steps: steps.length });
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const entry = { index: i, selector: step.selector, op: step.op, status: "pending", note: "" };
    try {
      const node = document.querySelector(step.selector);
      if (!node) { entry.status = "skipped"; entry.note = "selector not found"; log("selector not found", step.selector); results.push(entry); continue; }
      let val = "";
      const allowEmpty = !!step.allowEmpty;
      const noPrefix = !!step.noPrefix;
      if (typeof step.value === "string") {
        val = step.value;
      }
      if (typeof val !== "string") { entry.status = "skipped"; entry.note = "value not string"; log("value not string", step.selector); results.push(entry); continue; }
      if (val.length === 0 && !allowEmpty) { entry.status = "skipped"; entry.note = "empty value"; log("empty value", step.selector); results.push(entry); continue; }
      if (deny.test(val)) { entry.status = "skipped"; entry.note = "value denied by policy"; log("value denied", step.selector); results.push(entry); continue; }
      const outVal = noPrefix ? val : ensurePrefixed(val);
      if (step.op === "setText") {
        entry.prev = String(node.textContent ?? "");
        node.textContent = outVal; entry.status = "applied"; entry.value = outVal; log("setText", step.selector);
      }
      else if (step.op === "setHTML") {
        entry.prev = String(node.innerHTML ?? "");
        node.innerHTML = outVal; entry.status = "applied"; entry.value = outVal; log("setHTML", step.selector);
      }
      else { entry.status = "skipped"; entry.note = "unknown op"; log("unknown op", step.op); }
    } catch(e){ entry.status = "error"; entry.note = String(e); }
    results.push(entry);
  }
  const took_ms = Date.now() - t0;
  const summary = {
    steps_total: steps.length,
    steps_applied: results.filter(r => r.status === "applied").length,
    steps_skipped: results.filter(r => r.status === "skipped").length,
    steps_error: results.filter(r => r.status === "error").length,
    took_ms,
    results,
  };
  log("apply end", summary);
  return summary;
}
