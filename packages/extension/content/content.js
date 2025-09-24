
const api = (typeof browser !== 'undefined') ? browser : chrome;

const MAX_HTML = 200000;

function getHeuristics() {
  const hasPrice = !!document.querySelector('[itemprop="price"], .price, [data-price], [class*="price"]');
  const hasAddToCart = !!document.querySelector('button[id*="cart"], button[name*="cart"], button.add-to-cart, button[type="submit"]');
  const hasProductSchema = !!document.querySelector('script[type="application/ld+json"]');
  return { hasPrice, hasAddToCart, hasProductSchema };
}

function getMeta() {
  const g = (n) => document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.getAttribute("content") || null;
  return {
    ogTitle: g("og:title"), ogDescription: g("og:description"),
    twTitle: g("twitter:title"), twDescription: g("twitter:description")
  };
}

function htmlExcerpt() {
  const html = document.documentElement.outerHTML;
  return html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html;
}

async function main() {
  try {
    const url = location.href;
    const { ok } = await api.runtime.sendMessage({ type: "SHOULD_RUN", url });
    if (!ok) return;

    const payload = {
      url,
      title: document.title,
      meta: getMeta(),
      heuristics: getHeuristics(),
      html_excerpt: htmlExcerpt(),
      language: document.documentElement.getAttribute("lang") || navigator.language || "en"
    };

    const res = await api.runtime.sendMessage({ type: "LLM_ANALYZE", payload });
    const plan = res?.plan;
    if (!plan) throw new Error("No plan");

    await api.runtime.sendMessage({ type: "CACHE_PLAN", url, plan });
    await api.runtime.sendMessage({ type: "SET_BADGE", text: plan.is_pdp ? "PDP" : "—" });

    if (plan.is_pdp) await api.runtime.sendMessage({ type: "APPLY_PATCH", plan });
  } catch (e) {
    console.error("content error", e);
    try { await api.runtime.sendMessage({ type: "SET_BADGE", text: "ERR" }); } catch {}
  }
}

window.addEventListener("load", () => setTimeout(main, 600));
