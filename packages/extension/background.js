
// background.js
const api = (typeof browser !== 'undefined') ? browser : chrome;
const PROXY_URL = "https://fabric-pdp.vercel.app/api/analyze"; // set your deployed URL
const PROXY_GENERATE_URL = "https://fabric-pdp.vercel.app/api/generate";
const DEBUG = true;
const log = (...args) => { if (DEBUG) console.debug("[PDP][bg]", ...args); };

// Unified badge helper for consistency
async function setBadge(text, tabId){
  try {
    const color = (text === "PDP") ? "#00A86B"
      : (text === "ERR") ? "#D14343"
      : (text === "…") ? "#2B6CB0"
      : (text === "AP") ? "#F0B429"
      : "#999999";
    await api.action.setBadgeText({ text, tabId });
    await api.action.setBadgeBackgroundColor({ color, tabId });
  } catch {}
}

const sessionCache = new Map();
const storageArea = (api?.storage && api.storage.session) ? api.storage.session : api.storage.local;
async function cacheSet(key, value) {
  try { await storageArea.set({ [key]: value }); } catch(e) { log("cacheSet error", e?.message || e); }
}
async function cacheGet(key) {
  try { const obj = await storageArea.get([key]); return obj?.[key]; } catch(e) { log("cacheGet error", e?.message || e); return undefined; }
}

// Load strategies as separate modules into the service worker global scope
try { importScripts("strategies/llmStrategy.js"); } catch(e) { log("importScripts llmStrategy error", e); }
try { importScripts("strategies/jsonLdStrategy.js"); } catch(e) { log("importScripts jsonLdStrategy error", e); }
try { importScripts("page/applyPatchInPage.js"); } catch(e) { log("importScripts applyPatchInPage error", e); }
try { importScripts("utils/utils.js"); } catch(e) { log("importScripts utils error", e); }

const STRATEGY_DEFAULT_ID = "jsonLdStrategy";
const STRATEGY_REGISTRY = {
  // Strategy ID: resolver function. Signature: (payload, ctx) => Promise<plan>
  llmStrategy: async (payload /*, ctx */) => {
    return await (self.llmStrategy ? self.llmStrategy(payload) : callLLM(payload));
  },
  jsonLdStrategy: async (payload, ctx) => {
    if (typeof self.resolveViaJsonLd === 'function') return await self.resolveViaJsonLd(payload, ctx);
    return await resolveViaJsonLd(payload, ctx); // fallback if imported symbol missing
  },
};

api.runtime.onInstalled.addListener(() => {
  log("onInstalled");
  api.storage.local.get(["whitelist"]).then(cfg => {
    if (!cfg || !Array.isArray(cfg.whitelist)) api.storage.local.set({ whitelist: [] });
  });
  // Initialize strategy settings on first install
  api.storage.local.get(["strategySettings"]).then(cfg => {
    const s = cfg?.strategySettings;
    if (!s || typeof s !== 'object') {
      const defaults = { global: STRATEGY_DEFAULT_ID, perDomain: [] };
      api.storage.local.set({ strategySettings: defaults });
    }
  });
  api.action.setBadgeBackgroundColor({ color: "#00A86B" });
});

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  log("message", { type: msg?.type, tabId: sender?.tab?.id });
  (async () => {
    try {
      if (msg.type === "LLM_ANALYZE") {
        // Backward compatibility: route to new resolver using configured strategy
        const tabId = sender.tab?.id;
        const { plan, error } = await resolvePlanWithStrategy(msg.payload, tabId);
        if (error) { sendResponse({ error }); return; }
        sendResponse({ plan }); return;
      }
      if (msg.type === "RESOLVE_PLAN") {
        const tabId = sender.tab?.id;
        const { plan, error } = await resolvePlanWithStrategy(msg.payload, tabId);
        if (error) { sendResponse({ error }); return; }
        sendResponse({ plan }); return;
      }
      if (msg.type === "SET_BADGE") {
        const tabId = (typeof msg.tabId === 'number') ? msg.tabId : sender.tab?.id;
        if (tabId != null) await setBadge(msg.text, tabId);
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
          if (tabId != null) { try { await setBadge("AP", tabId); } catch {} }
          const results = await api.scripting.executeScript({ target: { tabId }, func: self.applyPatchInPage || applyPatchInPage, args: [msg.plan] });
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
        const ok = (typeof self.shouldRun === 'function') ? self.shouldRun(msg.url, wl) : shouldRun(msg.url, wl);
        log("SHOULD_RUN", { url: msg.url, whitelistCount: wl.length, ok });
        sendResponse({ ok }); return;
      }
    } catch (e) { console.error("[PDP][bg] handler error", e); sendResponse({ error: String(e) }); }
  })();
  return true;
});

async function getStrategySettings(){
  try {
    const cfg = await api.storage.local.get(["strategySettings"]);
    const s = cfg?.strategySettings;
    if (!s || typeof s !== 'object') return { global: STRATEGY_DEFAULT_ID, perDomain: [] };
    const perDomain = Array.isArray(s.perDomain) ? s.perDomain.filter(e => e && typeof e.pattern === 'string' && typeof e.strategyId === 'string') : [];
    const global = typeof s.global === 'string' && s.global ? s.global : STRATEGY_DEFAULT_ID;
    return { global, perDomain };
  } catch {
    return { global: STRATEGY_DEFAULT_ID, perDomain: [] };
  }
}

function chooseStrategyIdForUrl(urlStr, settings){
  const urlHost = safeHostname(urlStr);
  // Find first matching per-domain pattern
  for (const entry of settings.perDomain) {
    try {
      const re = new RegExp(patternToRegex(entry.pattern));
      if (re.test(urlHost)) return entry.strategyId;
    } catch {}
  }
  return settings.global || STRATEGY_DEFAULT_ID;
}

function safeHostname(urlStr){
  try { return new URL(urlStr).hostname; } catch { return ""; }
}

async function resolvePlanWithStrategy(payload, tabId){
  log("RESOLVE_PLAN start", { url: payload?.url });
  const errKey = (tabId != null) ? `error:${tabId}` : undefined;
  try {
    const settings = await getStrategySettings();
    const strategyId = chooseStrategyIdForUrl(payload?.url || "", settings);
    const resolver = STRATEGY_REGISTRY[strategyId] || STRATEGY_REGISTRY[STRATEGY_DEFAULT_ID];
    const plan = await resolver(payload, { strategyId, tabId });
    if (tabId != null) {
      const key = `plan:${tabId}`;
      sessionCache.set(key, plan);
      try { await cacheSet(key, plan); } catch {}
      try { if (errKey) { sessionCache.set(errKey, ""); await cacheSet(errKey, ""); } } catch {}
    }
    log("RESOLVE_PLAN done", { is_pdp: !!plan?.is_pdp, patch: plan?.patch?.length || 0 });
    return { plan };
  } catch (e) {
    const msgStr = String(e?.message || e);
    try { if (errKey) { sessionCache.set(errKey, msgStr); await cacheSet(errKey, msgStr); } } catch {}
    log("RESOLVE_PLAN error", { error: msgStr });
    return { error: msgStr };
  }
}


async function generateValues(input){
  const traceId = (typeof self.makeTraceId === 'function') ? self.makeTraceId() : makeTraceId();
  const body = JSON.stringify({ ...input, trace_id: traceId });
  const resp = await fetch(PROXY_GENERATE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-trace-id": traceId },
    body,
  });
  const text = await resp.text();
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && !obj.error) return obj;
    throw new Error(String(obj?.error || 'Invalid generator response'));
  } catch (e) {
    log("generateValues parse error", { error: String(e?.message || e), len: text?.length || 0 });
    throw e;
  }
}

// moved to utils/utils.js

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
    // Surface backend error messages to the UI
    if (plan && typeof plan.error === 'string' && plan.error.trim().length > 0) {
      throw new Error(String(plan.error));
    }
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

