
// background.js
const api = (typeof browser !== 'undefined') ? browser : chrome;
const PROXY_URL = "https://fabric-pdp.vercel.app/api/analyze"; // set your deployed URL
const PROXY_GENERATE_URL = "https://fabric-pdp.vercel.app/api/generate";
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

const STRATEGY_DEFAULT_ID = "jsonLdStrategy";
const STRATEGY_REGISTRY = {
  // Strategy ID: resolver function. Signature: (payload, ctx) => Promise<plan>
  llmStrategy: async (payload /*, ctx */) => {
    return await callLLM(payload);
  },
  jsonLdStrategy: async (payload, ctx) => {
    return await resolveViaJsonLd(payload, ctx);
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

// JSON-LD-based strategy implementation
async function resolveViaJsonLd(payload, ctx){
  const jsonlds = Array.isArray(payload?.jsonld) ? payload.jsonld : [];
  const product = pickFirstProduct(jsonlds);
  const planBase = { source: "jsonLdStrategy", url: payload?.url };
  if (!product) {
    return { ...planBase, is_pdp: false, patch: [], fields: {} };
  }
  const extracted = extractProductTexts(product);
  const targets = {};
  if (extracted.title) targets.title = extracted.title;
  if (extracted.description) targets.description = extracted.description;
  if (extracted.shipping) targets.shipping = extracted.shipping;
  if (extracted.returns) targets.returns = extracted.returns;

  let matches = {};
  try {
    if (typeof ctx?.tabId === 'number') {
      const results = await api.scripting.executeScript({ target: { tabId: ctx.tabId }, func: findSelectorsForTargets, args: [targets] });
      matches = Array.isArray(results) ? (results[0]?.result || {}) : {};
    }
  } catch (e) {
    log("jsonLdStrategy matching error", String(e?.message || e));
  }

  // Generate improved values via backend LLM generator
  let generated = {};
  try {
    generated = await generateValues({
      url: payload?.url || "",
      language: payload?.language || "",
      title: targets.title || "",
      description: targets.description || "",
      shipping: targets.shipping || "",
      returns: targets.returns || "",
    });
  } catch (e) {
    log("jsonLdStrategy generate error", String(e?.message || e));
  }

  const fields = {};
  const patch = [];
  const ensureObj = (v) => (v && typeof v === 'object') ? v : {};
  const addField = (key, label) => {
    const sel = ensureObj(matches[key]).selector;
    const raw = typeof generated[key] === 'string' && generated[key] ? generated[key] : (targets[key] || "");
    if (typeof sel === 'string' && sel && typeof raw === 'string' && raw) {
      const val = raw; // prefixing is handled at apply time via applyPatchInPage ensurePrefixed
      const isHtml = (key === 'description' || key === 'shipping' || key === 'returns');
      fields[key] = { selector: sel, html: isHtml, proposed: val };
      patch.push({ selector: sel, op: isHtml ? "setHTML" : "setText", value: val });
    }
  };
  addField('title');
  addField('description');
  addField('shipping');
  addField('returns');

  return { ...planBase, is_pdp: true, patch, fields };
}

function pickFirstProduct(jsonlds){
  try {
    for (const item of jsonlds) {
      if (!item || typeof item !== 'object') continue;
      // Handle @graph arrays
      const nodes = Array.isArray(item['@graph']) ? item['@graph'] : [item];
      for (const node of nodes) {
        const t = node['@type'];
        if (typeof t === 'string' && /Product$/i.test(t)) return node;
        if (Array.isArray(t) && t.some(x => typeof x === 'string' && /Product$/i.test(x))) return node;
      }
    }
  } catch {}
  return null;
}

function extractProductTexts(p){
  const getFirstString = (v) => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return String(v.find(x => typeof x === 'string') || '');
    if (v && typeof v === 'object' && typeof v['@value'] === 'string') return v['@value'];
    return '';
  };
  const name = getFirstString(p.name) || getFirstString(p.title);
  const description = getFirstString(p.description);
  // Shipping - best effort from offers.shippingDetails or shippingLabel/terms
  let shipping = '';
  try {
    const offers = Array.isArray(p.offers) ? p.offers[0] : p.offers;
    const sd = offers?.shippingDetails || offers?.hasDeliveryMethod;
    shipping = getFirstString(sd?.shippingLabel) || getFirstString(sd?.transitTime) || getFirstString(sd?.name) || '';
  } catch {}
  // Returns - best effort from hasMerchantReturnPolicy
  let returns = '';
  try {
    const rp = p.hasMerchantReturnPolicy || p.returnPolicy || p.merchantReturnPolicy;
    returns = getFirstString(rp?.returnPolicyCategory) || getFirstString(rp?.name) || getFirstString(rp?.returnPolicySeasonalOverride) || '';
  } catch {}
  return { title: name, description, shipping, returns };
}

// Executed in the page context to find best selectors for given target texts
function findSelectorsForTargets(targets){
  function normalize(s){
    try { return String(s || '').replace(/\s+/g,' ').trim().toLowerCase(); } catch { return ''; }
  }
  function levenshtein(a,b){
    a = normalize(a); b = normalize(b);
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    const dp = new Array(n + 1);
    for (let j=0;j<=n;j++) dp[j]=j;
    for (let i=1;i<=m;i++){
      let prev = i-1; dp[0]=i;
      for (let j=1;j<=n;j++){
        const tmp = dp[j];
        const cost = a[i-1] === b[j-1] ? 0 : 1;
        dp[j] = Math.min(
          dp[j] + 1,
          dp[j-1] + 1,
          prev + cost
        );
        prev = tmp;
      }
    }
    return dp[n];
  }
  function jaccardTokens(a,b){
    const A = new Set(normalize(a).split(/[^a-z0-9]+/).filter(Boolean));
    const B = new Set(normalize(b).split(/[^a-z0-9]+/).filter(Boolean));
    if (!A.size && !B.size) return 1;
    let inter = 0; for (const t of A) if (B.has(t)) inter++;
    const union = A.size + B.size - inter;
    return union ? inter/union : 0;
  }
  function trigramCosine(a,b){
    const grams = s => {
      s = `  ${normalize(s)}  `;
      const map = new Map();
      for (let i=0;i<s.length-2;i++){
        const g = s.slice(i,i+3);
        map.set(g,(map.get(g)||0)+1);
      }
      return map;
    };
    const A = grams(a), B = grams(b);
    let dot=0, a2=0, b2=0;
    for (const [g,c] of A){ a2 += c*c; if (B.has(g)) dot += c*B.get(g); }
    for (const c of B.values()) b2 += c*c;
    if (!a2 || !b2) return 0;
    return dot / Math.sqrt(a2*b2);
  }
  function scoreMatch(source, target){
    if (!source || !target) return 0;
    const ns = normalize(source), nt = normalize(target);
    if (ns.length === 0 || nt.length === 0) return 0;
    const exact = ns.includes(nt) ? 1 : 0;
    const jac = jaccardTokens(source, target);
    const cos = trigramCosine(source, target);
    const lev = levenshtein(source, target);
    const levScore = 1 - Math.min(1, lev / Math.max(ns.length, nt.length));
    return exact * 0.5 + jac * 0.2 + cos * 0.2 + levScore * 0.1;
  }
  function isVisible(el){
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return true;
  }
  function cssPath(el){
    if (!(el instanceof Element)) return '';
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 5){
      let selector = el.nodeName.toLowerCase();
      if (el.classList && el.classList.length && el.classList.length <= 3){
        selector += '.' + Array.from(el.classList).slice(0,3).map(c=>CSS.escape(c)).join('.');
      }
      const parent = el.parentElement;
      if (parent){
        const siblings = Array.from(parent.children).filter(n=>n.nodeName === el.nodeName);
        if (siblings.length > 1){
          const index = siblings.indexOf(el) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }
      parts.unshift(selector);
      el = parent;
    }
    return parts.join(' > ');
  }
  const tags = ['h1','h2','h3','p','div','span','li','dd','dt','strong','em'];
  const candidates = Array.from(document.querySelectorAll(tags.join(',')))
    .filter(el => isVisible(el))
    .map(el => ({ el, text: (el.textContent||'').trim() }))
    .filter(x => x.text.length >= 2);
  const out = {};
  for (const [key, target] of Object.entries(targets || {})){
    let best = { score: 0, selector: '' };
    for (const c of candidates){
      const s = scoreMatch(c.text, target);
      if (s > best.score){
        best = { score: s, selector: cssPath(c.el) };
      }
    }
    if (best.selector) out[key] = { selector: best.selector, score: best.score };
  }
  return out;
}

async function generateValues(input){
  const traceId = makeTraceId();
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
