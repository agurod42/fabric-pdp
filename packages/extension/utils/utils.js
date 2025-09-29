// Shared helpers expected by background.js and strategies

function evaluatePdpSignals(payload) {
  const DEBUG = true;
  const dbg = (...args) => { if (DEBUG) { try { console.debug("[PDP][signals]", ...args); } catch {} } };
  const toStr = (v) => String(v || "");
  const count = (re, s) => (s.match(re) || []).length;
  const has = (re, s) => re.test(s);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  let score = 0;
  let anti = 0;
  let strongProduct = false;

  // ---------- Vendor profiles (expandable) ----------
  const vendorProfiles = [
    {
      name: "Amazon",
      host: /(^|\.)amazon\./i,
      pdpPath: /\/(dp|gp\/product)\//i,
      buybox: /\b(add-to-cart-button|buy-now-button|buybox|data-feature-name=["']?(buybox|addToCart)|id=["']?twister)\b/i,
      boost: 3, antiCap: 5,
    },
    {
      name: "eBay",
      host: /(^|\.)ebay\./i,
      // eBay PDPs often like: /itm/<title>/item/<id> or /itm/<id>
      pdpPath: /\/itm(\/|$)/i,
      buybox: /\b(id|name)=["']?(isCartBtn_btn|binBtn_btn|atcRedesignId_btn|vi_.*?(Cart|Bin)|isCartBtn)\b/i,
      // also eBay “Add to cart” buttons often carry aria-labels
      extra: /\baria-label=["']?(Add to cart|Buy it now)/i,
      boost: 3, antiCap: 5,
    },
    {
      name: "Walmart",
      host: /(^|\.)walmart\./i,
      pdpPath: /\/ip\/|\/seller\/|\/product\/|\/browse\/product/i,
      buybox: /\b(data-automation-id|id)=["']?(add-to-cart|cta-button|buybox|add-to-cart-button)\b/i,
      extra: /\bitemprop=["']?sku\b/i,
      boost: 2, antiCap: 6,
    },
    {
      name: "Target",
      host: /(^|\.)target\./i,
      pdpPath: /\/p\/|\/product\//i,
      buybox: /\bdata-test=["']?(addToCartButton|addToCart|buyNowButton)\b/i,
      extra: /\bitemprop=["']?(sku|brand|name)\b/i,
      boost: 2, antiCap: 6,
    },
    {
      name: "BestBuy",
      host: /(^|\.)bestbuy\./i,
      pdpPath: /\/site\/.+\/\d+\.p/i,
      buybox: /\bdata-sku-id=|\bclass=["'][^"']*\badd-to-cart-button\b/i,
      boost: 2, antiCap: 6,
    },
    {
      name: "MercadoLibre",
      host: /(^|\.)mercadolibre\./i,
      pdpPath: /\/p\/|\/item\/|\/ML[A-Z]\-\d+/i,
      buybox: /\b(id|data-testid)=["']?(buy-now|add-to-cart|vip-buy-box|vip-action-primary)\b/i,
      extra: /\bitemprop=["']?(sku|brand|name)\b/i,
      boost: 2, antiCap: 6,
    },
    {
      name: "AliExpress",
      host: /(^|\.)aliexpress\./i,
      pdpPath: /\/item\/|\/i\/\d+.html/i,
      buybox: /\b(add-to-cart|buy-now|product-buy|buy-now-btn)\b/i,
      boost: 2, antiCap: 6,
    },
    {
      name: "Etsy",
      host: /(^|\.)etsy\./i,
      pdpPath: /\/listing\/\d+/i,
      buybox: /\b(add-to-cart|add-to-basket|buy-it-now|data-buy-box)\b/i,
      extra: /\bitemprop=["']?(sku|name)\b/i,
      boost: 2, antiCap: 6,
    },
    {
      name: "ShopifyGeneric",
      host: /./i, // fallback: detect via markup instead of host
      // Many Shopify PDPs have /products/<handle> while collections use /collections/
      pdpPath: /\/products\/[^/?#]+(?:$|[?#])/i,
      buybox: /\b(name|id)=["']?(add|Add)To(Cart|Bag)\b|form[^>]+action="\/cart\/add"/i,
      // Avoid overfitting: only apply if we also see Shopify fingerprints
      fingerprint: /(Shopify|shopify)\b|x-shopid|x-shopify|cdn\.shopify\.com/i,
      boost: 2, antiCap: 6,
    },
  ];

  try {
    const html = toStr(payload?.html_excerpt).slice(0, 320_000);
    const url = toStr(payload?.url);

    // ---------- URL guards ----------
    let host = "", path = "";
    try {
      const u = new URL(url);
      host = u.hostname || "";
      path = u.pathname || "";
      if (path === "/" || path === "") { dbg("anti: root path"); return { score: -10, strong_product: false }; }
      if (/^\/ref=/.test(path)) { dbg("anti: ref path"); return { score: -8, strong_product: false }; }
      if (/\b(cart|checkout|basket|account|orders?|login|register|help|support|search|wishlist)\b/i.test(url)) {
        dbg("anti: route keyword"); return { score: -10, strong_product: false };
      }
      if (/\b(collections?|categories?|category|catalog|tienda|shop|brand|tags?|list|offers?)\b/i.test(path)) {
        anti += 2; dbg("anti: category-ish path", { path });
      }
    } catch {}

    // ---------- Vendor boosts ----------
    let vendor = null;
    for (const v of vendorProfiles) {
      const hostOk = v === vendorProfiles.at(-1) ? true : v.host.test(host); // ShopifyGeneric handled later
      if (!hostOk) continue;
      const pdpOk = v.pdpPath && v.pdpPath.test(path);
      const hasFp = v.fingerprint ? v.fingerprint.test(html) : true;

      if (pdpOk && hasFp) {
        vendor = v;
        score += v.boost || 0;
        strongProduct = true;
        // look for explicit buybox markers to add a bit more
        const bb = v.buybox && v.buybox.test(html);
        const ex = v.extra && v.extra.test(html);
        if (bb) score += 2;
        if (ex) score += 1;
        // Slightly relax anti so density doesn't kill PDPs on these sites
        anti = Math.max(0, anti - 2);
        dbg(`VENDOR: ${v.name} pdp match`, { boost: v.boost || 0, bb, ex });
        break;
      }
    }

    // ---------- Structured/META ----------
    const productJsonldCount = count(/"@type"\s*:\s*"Product"\b/gi, html);
    const hasItemList = has(/"@type"\s*:\s*"(ItemList|CollectionPage)"/i, html);
    const hasOffer = has(/"@type"\s*:\s*"Offer"/i, html) || has(/"offers"\s*:\s*{[^}]*"@type"\s*:\s*"Offer"/i, html);
    const hasAggRating = has(/"@type"\s*:\s*"AggregateRating"/i, html);
    const hasOgProduct = has(/property="og:type"[^>]*content="product(\.group)?"/i, html);
    const hasMicrodataProduct = has(/itemtype\s*=\s*"[^"]*schema\.org\/Product/i, html);
    const hasOgPrice = has(/property="(product:price:amount|og:price:amount)"/i, html);

    if (productJsonldCount === 1) { score += 3; strongProduct = true; dbg("signal: single Product JSON-LD"); }
    if (productJsonldCount > 1 && !(vendor && /Amazon|eBay/i.test(vendor.name))) {
      anti += clamp(productJsonldCount - 1, 1, 4); dbg("anti: multi Product JSON-LD", { productJsonldCount });
    }
    if (hasItemList && !(vendor && /Amazon|eBay|Walmart|Target|BestBuy|MercadoLibre|AliExpress|Etsy/i.test(vendor.name))) {
      anti += 3; dbg("anti: ItemList/CollectionPage");
    }
    if (hasOffer) { score += 2; dbg("signal: Offer"); }
    if (hasAggRating) { score += 2; dbg("signal: AggregateRating"); }
    if (hasOgProduct) { score += 2; strongProduct = true; dbg("signal: og:type product"); }
    if (hasMicrodataProduct) { score += 2; strongProduct = true; dbg("signal: microdata Product"); }
    if (hasOgPrice) { score += 1; dbg("signal: price meta"); }

    // ---------- Headline / Title ----------
    const h1Count = count(/<h1\b[^>]*>/gi, html);
    if (h1Count === 1) { score += 1; dbg("signal: single h1"); }
    else if (h1Count >= 3) { anti += 2; dbg("anti: many h1s", { h1Count }); }
    const hasHeadline = has(/(<h1[\s>]|itemprop="name"|data-(test|qa)[^>]*title|aria-label="[^"]{5,200}")/i, html);

    // ---------- Variants / SKU ----------
    const hasSku = /\b(sku|mpn|model|ref\.?)\s*[:#\-\s]/i.test(html) || /itemprop="sku"/i.test(html);
    const hasVariants = /(select[^>]+name="[^"]*(size|color)\b|aria-label="[^"]*\b(Size|Color)\b|id=["']?twister)/i.test(html);
    if (hasSku) { score += 2; dbg("signal: sku/mpn/model"); }
    if (hasVariants) { score += 2; dbg("signal: variants"); }

    // ---------- CTAs ----------
    const ctaCommon = /\b(add to (cart|bag)|buy now|comprar(?: ahora| ya)?|añadir al (carrito|cesta|bolsa)|agregar al (carrito|cesta|bolsa))\b/gi;
    const ctaVendorIds = /\b(add-to-cart-button|buy-now-button|isCartBtn_btn|binBtn_btn|atcRedesignId_btn)\b/gi;
    const ctaCount = count(ctaCommon, html) + count(ctaVendorIds, html);
    if (ctaCount > 0) score += 2;
    const vendorIsNoisy = !!vendor;
    if (ctaCount >= 3 && !vendorIsNoisy) anti += 2;
    if (ctaCount >= 8 && !vendorIsNoisy) anti += 2;
    if (ctaCount) dbg("signal/anti: CTA density", { ctaCount });

    // ---------- Price & grid density (gated) ----------
    const priceCount = count(/(?:[$€£]\s?\d[\d.,]*)|(?:\b\d[\d.,]*\s?(?:USD|EUR|GBP)\b)/gi, html);
    const productCardHints = count(/(data-product-card|class="[^"]*\b(product-card|grid__item|product-tile)\b|data-sku=)/gi, html);
    const imgThumbHints = count(/class="[^"]*\b(product(-)?image|thumb|thumbnail)\b/gi, html);

    const hasFacets = /(data-facet|class="[^"]*\b(facet|filters)\b|aria-label="[^"]*\bFilter\b)/i.test(html);
    const hasPagination = /class="[^"]*\bpagination\b/i.test(html) || /aria-label="[^"]*\bPagination\b/i.test(html);
    const hasSortBy = /\bSort\s+by\b/i.test(html) || /aria-label="[^"]*\bSort\b/i.test(html) || /id=["']?s-result-sort/i.test(html);
    const looksLikeListPage = (hasFacets || hasPagination || hasSortBy) && !vendorIsNoisy;

    const listDensity = (productCardHints + imgThumbHints) + Math.floor(priceCount / 12);
    if (looksLikeListPage && (productCardHints >= 6 || priceCount >= 28 || listDensity >= 12)) {
      anti += 4; dbg("anti: grid/list density (gated)", { productCardHints, priceCount, imgThumbHints, listDensity });
    } else if (!looksLikeListPage && (productCardHints >= 20 && priceCount >= 60) && !vendorIsNoisy) {
      anti += 2; dbg("anti: extreme density (ungated)", { productCardHints, priceCount });
    }

    // ---------- rel prev/next ----------
    if ((/<link[^>]+rel="next"/i.test(html) || /<link[^>]+rel="prev"/i.test(html)) && !(vendor && /Amazon|eBay/i.test(vendor.name))) {
      anti += 2; dbg("anti: rel prev/next");
    }

    // ---------- Shipping/returns (weak) ----------
    if (/(shipping|env[ií]o|delivery|entrega|despacho)/i.test(html)) score += 1;
    if (/(returns?|devoluci[oó]n(?:es)?|cambios?|reembolsos?)/i.test(html)) score += 1;

    // ---------- Headline + price combo ----------
    const hasPrice = priceCount > 0 || hasOgPrice;
    if (hasHeadline && hasPrice) { score += 2; dbg("signal: headline+price"); }

    // ---------- Reviews ----------
    if (/\b\d{1,4}\s*(reviews?|reseñas)\b/i.test(html) || /itemprop="reviewCount"/i.test(html)) {
      score += 1; dbg("signal: review count");
    }

    // ---------- Finalize with vendor anti cap ----------
    if (vendor && hasPrice) {
      anti = Math.min(anti, vendor.antiCap ?? 6);
    }

    // Decision paths
    const pathA = (strongProduct && (hasOffer || hasAggRating || h1Count === 1) && anti <= (vendor ? vendor.antiCap : 6));
    const hasVariantish = hasSku || hasVariants;
    const pathB = (hasHeadline && hasPrice && hasVariantish && anti <= ((vendor ? vendor.antiCap : 6) - 1));

    if (pathA) score += 3;
    if (pathB) score += 2;

    dbg("final score", { score, anti, vendor: vendor?.name, strong_product: strongProduct, url });
  } catch (e) {
    dbg("error", e?.message || e);
  }

  const finalScore = score - anti;
  return { score: finalScore, strong_product: strongProduct };
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

function patternToRegex(pattern) {
  return "^" + String(pattern || "").replace(/\./g, "\\.").replace(/\*/g, ".*") + "$";
}

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
