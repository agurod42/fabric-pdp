// utils/utils.js — Small shared helpers used by background and strategies
// Exposes a minimal API on the global scope for the service worker.

/**
 * Lightweight PDP signals scoring shared by strategies.
 * Uses only the reduced HTML excerpt and URL/meta fields from payload.
 */
function evaluatePdpSignals(payload) {
  const DEBUG = true;
  const dbg = (...args) => { if (DEBUG) { try { console.debug("[PDP][signals]", ...args); } catch {} } };
  let score = 0;
  try {
    const html = String(payload?.html_excerpt || "").slice(0, 200000);
    const title = String(payload?.title || "");
    const url = String(payload?.url || "");

    // Root page: treat as non-PDP
    try {
      const u = new URL(url);
      const path = String(u.pathname || "");
      if (path === "/" || path === "") { dbg("anti: root path", { url }); return { score: -10 }; }
    } catch {}

    // Quick anti routes
    if (/\b(cart|checkout|basket|account|orders?|login|register|help|support|search)\b/i.test(url)) { dbg("anti: route", { url }); return { score: -10 }; }

    // Structured/meta signals (regex over reduced HTML)
    if (/"@type"\s*:\s*"Product"/i.test(html)) { score += 3; dbg("signal: jsonld product"); }
    if (/itemtype\s*=\s*"[^"]*schema\.org\/Product/i.test(html)) { score += 2; dbg("signal: microdata product"); }
    if (/property="og:type"[^>]*content="product"/i.test(html)) { score += 2; dbg("signal: og:type product"); }
    if (/property="product:price:amount"/i.test(html)) { score += 2; dbg("signal: product:price:amount"); }

    // CTA (EN + ES variants)
    if (/(add to cart|buy now|add to bag|comprar(?: ahora| ya)?|añadir al carrito|añadir a la cesta|añadir a la bolsa|agregar al carrito|agregar a la cesta|agregar a la bolsa)/i.test(html)) { score += 3; dbg("signal: CTA"); }

    // SKU / variants / qty
    if (/\b(sku|mpn|model|ref\.?)[\s:]/i.test(html)) { score += 2; dbg("signal: sku/mpn/model"); }
    if (/(select[^>]+name="[^"]*(size|color)|aria-label="[^"]*(Size|Color))/i.test(html)) { score += 2; dbg("signal: size/color"); }
    if (/(input[^>]+type="number"[^>]+name="[^"]*(qty|quantity)|aria-label="[^"]*Quantity)/i.test(html)) { score += 1; dbg("signal: qty"); }

    // Shipping / Returns (EN + ES)
    if (/(shipping|env[ií]o|envios|env[íi]os|delivery|entrega|despacho)/i.test(html)) { score += 1; dbg("signal: shipping words"); }
    if (/(returns?|devoluci[oó]n(?:es)?|cambios?|reembolsos?)/i.test(html)) { score += 1; dbg("signal: returns words"); }

    // Anti-signals: many cards, facets, pagination
    const repeatedPriceBlocks = html.match(/(?:\$|€|£)\s?\d[\d.,]*/g)?.length || 0;
    const productCardHints = (html.match(/(data-product-card|class="[^"]*product-card|data-sku=)/g) || []).length;
    if (productCardHints >= 6 || repeatedPriceBlocks >= 12) { score -= 4; dbg("anti: grid/list cards", { productCardHints, repeatedPriceBlocks }); }
    if (/class="[^"]*(pagination)\b/i.test(html) || /aria-label="[^"]*Pagination/i.test(html)) { score -= 3; dbg("anti: pagination"); }
    if (/(data-facet|class="[^"]*(facet|filters)\b|aria-label="[^"]*Filter)/i.test(html)) { score -= 3; dbg("anti: filters/facets"); }

    // Price near title heuristic via coarse check
    const hasHeadline = /(\<h1[\s>]|\<h2[\s>]|itemprop="name"|data-(test|qa)[^>]*title)/i.test(html);
    const hasPrice = /(?:[$€£]\s?\d[\d.,]*)|(?:\d[\d.,]*\s?(?:USD|EUR|GBP))/i.test(html);
    if (hasHeadline && hasPrice) { score += 2; dbg("signal: headline+price"); }
  } catch {}
  dbg("final score", { score, url: String(payload?.url || "") });
  return { score };
}

/** Generate a short, prefixed trace id safe for logs and headers. */
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

/** Convert wildcard patterns like *.shopify.com to a safe RegExp source. */
function patternToRegex(pattern) {
  return "^" + String(pattern || "").replace(/\./g, "\\.").replace(/\*/g, ".*") + "$";
}

/**
 * Return true when the given URL hostname matches any whitelist pattern.
 * Empty or missing whitelist means allow all.
 */
function shouldRun(urlStr, whitelist) {
  if (!Array.isArray(whitelist) || whitelist.length === 0) return true;
  try {
    const host = new URL(urlStr).hostname;
    return whitelist.some(p => new RegExp(patternToRegex(p)).test(host));
  } catch { return false; }
}

self.evaluatePdpSignals = evaluatePdpSignals;
self.makeTraceId = makeTraceId;
self.patternToRegex = patternToRegex;
self.shouldRun = shouldRun;

// (removed) ensureVendorScript: no vendor scripts are used
