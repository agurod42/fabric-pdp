// JSON-LD-based strategy implementation and helpers (loaded via importScripts)

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

  // Generate improved values via backend LLM generator (uses global generateValues)
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

// Expose to background global scope
self.resolveViaJsonLd = resolveViaJsonLd;
self.findSelectorsForTargets = findSelectorsForTargets;


