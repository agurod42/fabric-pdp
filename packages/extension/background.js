
const api = (typeof browser !== 'undefined') ? browser : chrome;
const DEBUG = false;
const log = (...args) => { if (DEBUG) console.debug("[PDP][bg]", ...args); };

/**
 * Set extension badge text and background color for a tab.
 * Uses a small palette to communicate states: PDP, ERR, …, AP.
 */
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
/** Store a small value in the chosen storage area (session if available). */
async function cacheSet(key, value) {
  try { await storageArea.set({ [key]: value }); } catch(e) { log("cacheSet error", e?.message || e); }
}
/** Retrieve a value previously stored via cacheSet. */
async function cacheGet(key) {
  try { const obj = await storageArea.get([key]); return obj?.[key]; } catch(e) { log("cacheGet error", e?.message || e); return undefined; }
}

// Tab-scoped cache helpers
function tabKey(ns, tabId){ return `${ns}:${tabId}`; }

async function tabCacheSet(ns, tabId, value){
  try {
    const key = tabKey(ns, tabId);
    sessionCache.set(key, value);
    try { await cacheSet(key, value); } catch {}
    return true;
  } catch { return false; }
}

async function tabCacheGet(ns, tabId){
  try {
    const key = tabKey(ns, tabId);
    let val = sessionCache.get(key);
    if (typeof val === 'undefined') {
      val = await cacheGet(key);
      if (typeof val !== 'undefined') sessionCache.set(key, val);
    }
    return val;
  } catch { return undefined; }
}

async function tabCacheClear(ns, tabId){
  try {
    const key = tabKey(ns, tabId);
    sessionCache.delete(key);
    try { await cacheSet(key, null); } catch {}
  } catch {}
}

/** Clear cached state for a tab on navigation. */
async function clearTabState(tabId){
  try {
    await Promise.all([
      tabCacheClear('plan', tabId),
      tabCacheClear('summary', tabId),
      tabCacheSet('error', tabId, ""),
      tabCacheSet('processing', tabId, false),
    ]);
  } catch {}
}

/** Trigger recompute on a tab after its URL changes. */
async function handleNavigation(tabId, url){
  try {
    await clearTabState(tabId);
    try { await setBadge("—", tabId); } catch {}
    // Ask the content script to recompute with fresh page context
    try { await api.tabs.sendMessage(tabId, { type: "RECOMPUTE", url }); } catch {}
  } catch {}
}

// Debounce recompute on navigation to avoid thrash
const navTimers = new Map();
function scheduleRecompute(tabId, url){
  try {
    const prev = navTimers.get(tabId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      navTimers.delete(tabId);
      handleNavigation(tabId, url);
    }, 350);
    navTimers.set(tabId, t);
  } catch {}
}

// Load strategies as separate modules into the service worker global scope
try { importScripts("page/applyPatchInPage.js"); } catch(e) { log("importScripts applyPatchInPage error", e); }
try { importScripts("strategies/heuristicsStrategy.js"); } catch(e) { log("importScripts heuristicsStrategy error", e); }
try { importScripts("strategies/llmStrategy.js"); } catch(e) { log("importScripts llmStrategy error", e); }
try { importScripts("utils/utils.js"); } catch(e) { log("importScripts utils error", e); }

const STRATEGY_DEFAULT_ID = "llmStrategy";
const STRATEGY_REGISTRY = {
  heuristicsStrategy: async (payload, ctx) => {
    if (typeof self.heuristicsStrategy === 'function') return await self.heuristicsStrategy(payload, ctx);
    // Fallback: delegate to LLM strategy if present
    if (typeof self.llmStrategy === 'function') return await self.llmStrategy(payload);
    throw new Error('No strategy available');
  },
  // Strategy ID: resolver function. Signature: (payload, ctx) => Promise<plan>
  llmStrategy: async (payload /*, ctx */) => {
    if (typeof self.llmStrategy === 'function') return await self.llmStrategy(payload);
    throw new Error('llmStrategy not available');
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
  // Initialize PDP settings on first install
  api.storage.local.get(["pdpSettings"]).then(cfg => {
    const p = cfg?.pdpSettings;
    if (!p || typeof p !== 'object' || typeof p.minScoreToContinue !== 'number') {
      const defaults = { minScoreToContinue: 10 };
      api.storage.local.set({ pdpSettings: defaults });
    }
  });
  api.action.setBadgeBackgroundColor({ color: "#00A86B" });
});

// Recompute plan when the tab URL changes (navigations)
try {
  api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    try {
      if (changeInfo && typeof changeInfo.url === 'string' && changeInfo.url) {
        log("onUpdated:url", { tabId, url: changeInfo.url });
        scheduleRecompute(tabId, changeInfo.url);
      }
    } catch {}
  });
} catch {}

// Handle SPA route changes via History API
try {
  if (api.webNavigation && api.webNavigation.onHistoryStateUpdated) {
    api.webNavigation.onHistoryStateUpdated.addListener((details) => {
      try {
        if (typeof details?.tabId === 'number' && typeof details?.url === 'string') {
          log("onHistoryStateUpdated", { tabId: details.tabId, url: details.url });
          scheduleRecompute(details.tabId, details.url);
        }
      } catch {}
    });
  }
} catch {}

// Patch apply helpers
function pickApplySummary(arr){
  if (!Array.isArray(arr)) return null;
  try {
    const main = arr.find(r => r && typeof r.frameId === 'number' && r.frameId === 0 && r.result);
    if (main && main.result) return main.result;
    const anyApplied = arr.find(r => r && r.result && r.result.steps_applied > 0);
    if (anyApplied && anyApplied.result) return anyApplied.result;
    return arr[0]?.result ?? null;
  } catch { return arr[0]?.result ?? null; }
}

async function executePatchInWorld(tabId, world, plan){
  const res = await api.scripting.executeScript({ target: { tabId, allFrames: true }, world, func: self.applyPatchInPage || applyPatchInPage, args: [plan] });
  return pickApplySummary(res);
}

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
          await tabCacheSet('plan', tabId, msg.plan);
          log("CACHE_PLAN", { tabId });
        }
        sendResponse({ ok: true }); return;
      }
      if (msg.type === "GET_PLAN") {
        const tabId = (typeof msg.tabId === 'number') ? msg.tabId : sender.tab?.id;
        const plan = (tabId != null) ? await tabCacheGet('plan', tabId) : undefined;
        log("GET_PLAN", { tabId, found: !!plan });
        sendResponse({ plan }); return;
      }
      if (msg.type === "APPLY_PATCH") {
        const tabId = (typeof msg.tabId === 'number') ? msg.tabId : sender?.tab?.id;
        const steps = msg?.plan?.patch?.length || 0;
        const t0 = Date.now();
        log("APPLY_PATCH start", { tabId, steps });
        try {
          if (tabId != null) { try { await setBadge("AP", tabId); } catch {} }
          let summary = await executePatchInWorld(tabId, 'ISOLATED', msg.plan);
          // If nothing applied but there are steps, retry once after a short delay (late-loading DOMs)
          try {
            if (summary && summary.steps_total > 0 && summary.steps_applied === 0) {
              await new Promise(r => setTimeout(r, 1200));
              summary = await executePatchInWorld(tabId, 'ISOLATED', msg.plan);
            }
          } catch {}
          // If still nothing applied and steps exist, try MAIN world as a fallback
          try {
            if (steps > 0 && (!summary || summary.steps_applied === 0)) {
              summary = await executePatchInWorld(tabId, 'MAIN', msg.plan);
            }
          } catch {}
          log("APPLY_PATCH done", { took_ms: Date.now() - t0, summary });
          try {
            if (tabId != null) { await tabCacheSet('summary', tabId, summary); log("APPLY_PATCH cached summary", { tabId }); }
          } catch {}
          sendResponse({ ok: true, summary }); return;
        } catch (e) {
          console.error("[PDP][bg] APPLY_PATCH error", e);
          try {
            const msgStr = String(e?.message || e);
            if (tabId != null) { await tabCacheSet('error', tabId, msgStr); }
          } catch {}
          sendResponse({ error: String(e) }); return;
        }
      }
      if (msg.type === "GET_APPLY_SUMMARY") {
        const tabId = (typeof msg.tabId === 'number') ? msg.tabId : sender.tab?.id;
        const summary = (tabId != null) ? await tabCacheGet('summary', tabId) : undefined;
        log("GET_APPLY_SUMMARY", { tabId, found: !!summary });
        sendResponse({ summary }); return;
      }
      if (msg.type === "GET_LAST_ERROR") {
        const tabId = (typeof msg.tabId === 'number') ? msg.tabId : sender.tab?.id;
        const err = (tabId != null) ? await tabCacheGet('error', tabId) : undefined;
        const has = typeof err === 'string' && err.trim().length > 0;
        log("GET_LAST_ERROR", { tabId, has });
        sendResponse({ error: has ? err : null }); return;
      }
      if (msg.type === "SET_PROCESSING") {
        const tabId = (typeof msg.tabId === 'number') ? msg.tabId : sender.tab?.id;
        const val = !!msg.processing;
        if (tabId != null) { await tabCacheSet('processing', tabId, val); log("SET_PROCESSING", { tabId, val }); }
        sendResponse({ ok: true }); return;
      }
      if (msg.type === "GET_PROCESSING") {
        const tabId = (typeof msg.tabId === 'number') ? msg.tabId : sender.tab?.id;
        (async () => {
          const val = (tabId != null) ? await tabCacheGet('processing', tabId) : undefined;
          const processing = !!val;
          log("GET_PROCESSING", { tabId, processing });
          sendResponse({ processing });
        })();
        return true;
      }
      if (msg.type === "SET_LAST_ERROR") {
        const tabId = (typeof msg.tabId === 'number') ? msg.tabId : sender.tab?.id;
        const val = String(msg.error || msg.message || "");
        if (tabId != null) { await tabCacheSet('error', tabId, val); log("SET_LAST_ERROR", { tabId, len: val.length }); }
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

/**
 * Load persisted strategy settings.
 * Falls back to sane defaults when not configured.
 */
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

/** Choose a strategy id for a given URL from settings (per-domain > global). */
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

/** Best-effort hostname extraction (empty string on failure). */
function safeHostname(urlStr){
  try { return new URL(urlStr).hostname; } catch { return ""; }
}

/**
 * Resolve a plan using the selected strategy.
 * Also caches the plan and clears any last error for the tab.
 */
async function resolvePlanWithStrategy(payload, tabId){
  log("RESOLVE_PLAN start", { url: payload?.url });
  const errKey = (tabId != null) ? `error:${tabId}` : undefined;
  const procKey = (tabId != null) ? `processing:${tabId}` : undefined;
  try {
    // Mark processing=true for this tab
    try { if (procKey) { sessionCache.set(procKey, true); await cacheSet(procKey, true); } } catch {}
    const t0 = Date.now();
    const settings = await getStrategySettings();
    const candidateId = chooseStrategyIdForUrl(payload?.url || "", settings);
    const exists = Object.prototype.hasOwnProperty.call(STRATEGY_REGISTRY, candidateId);
    const strategyId = exists ? candidateId : STRATEGY_DEFAULT_ID;
    const resolver = STRATEGY_REGISTRY[strategyId];
    const plan = await resolver(payload, { strategyId, tabId });
    const took = Date.now() - t0;
    if (plan && typeof plan === 'object') {
      const patchLen = Array.isArray(plan?.patch) ? plan.patch.length : 0;
      if (patchLen === 0) plan.is_pdp = false;

      plan.meta = plan.meta && typeof plan.meta === 'object' ? { ...plan.meta } : {};
      plan.meta.process_ms = took;
      plan.meta.strategy_id = strategyId;
    }
    if (tabId != null) {
      const key = `plan:${tabId}`;
      sessionCache.set(key, plan);
      try { await cacheSet(key, plan); } catch {}
      try { if (errKey) { sessionCache.set(errKey, ""); await cacheSet(errKey, ""); } } catch {}
    }
    log("RESOLVE_PLAN done", { is_pdp: !!plan?.is_pdp, patch: plan?.patch?.length || 0, took_ms: plan?.meta?.process_ms });
    return { plan };
  } catch (e) {
    const msgStr = String(e?.message || e);
    try { if (errKey) { sessionCache.set(errKey, msgStr); await cacheSet(errKey, msgStr); } } catch {}
    log("RESOLVE_PLAN error", { error: msgStr });
    return { error: msgStr };
  } finally {
    // Clear processing flag
    try { if (procKey) { sessionCache.set(procKey, false); await cacheSet(procKey, false); } } catch {}
  }
}


// moved to utils/utils.js

