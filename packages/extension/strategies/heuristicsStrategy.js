// strategies/heuristicsStrategy.js — Fast heuristic PDP detector and selector finder
// Implements a staged scoring approach and returns a plan compatible with LLM output
// Signature: async function heuristicsStrategy(payload, ctx) => plan
(function(){
const api = (typeof browser !== 'undefined') ? browser : chrome;

// Use shared evaluator
const evaluateSignals = (payload) => {
  const res = (typeof self.evaluatePdpSignals === 'function' ? self.evaluatePdpSignals(payload) : { score: 0 });
  try { console.debug('[PDP][heuristics] evaluatePdpSignals score', res?.score, { url: payload?.url }); } catch {}
  return res;
};

/** Discover stable selectors for title/description/shipping/returns on live page. */
async function discoverSelectorsInPage(tabId){
	try {
		const [{ result } = { result: {} }] = await api.scripting.executeScript({
			target: { tabId },
			func: () => {
				function txt(el){ try { return (el && typeof el.textContent === 'string') ? el.textContent.trim() : ""; } catch { return ""; } }
				function visible(el){ try { if (!el) return false; const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false; if (!el.offsetParent && s.position !== 'fixed') return false; const r = el.getBoundingClientRect(); return (r.width * r.height) > 0; } catch { return true; } }
				function pickSelector(el){
					if (!el) return "";
					if (el.id) return `#${CSS.escape(el.id)}`;
					for (const a of Array.from(el.attributes || [])){
						const n = (a.name || '').toLowerCase();
						if (n.startsWith('data-')) return `${el.tagName.toLowerCase()}[${n}="${a.value}"]`;
					}
					let cur = el, parts = [];
					for (let depth=0; cur && depth < 4; depth++) {
						let sel = cur.tagName ? cur.tagName.toLowerCase() : '';
						if (cur.classList && cur.classList.length > 0) sel += '.' + Array.from(cur.classList).slice(0,2).map(c=>CSS.escape(c)).join('.');
						parts.unshift(sel);
						cur = cur.parentElement;
					}
					return parts.join('>');
				}
				function preferLongestText(nodes){
					let best = null, bestLen = 0;
					for (const el of nodes){
						const t = txt(el);
						if (!visible(el)) continue;
						const len = t.length;
						if (len > bestLen) { best = el; bestLen = len; }
					}
					return best;
				}
				const out = {};
				try {
					// Title
					let titleEl = document.querySelector('h1, h2, [itemprop="name"], [data-test*="title"], [data-qa*="title"]');
					if (titleEl && visible(titleEl)) out.title = pickSelector(titleEl);

					// Description candidates (EN + ES)
					// Broaden to include common headings/containers like "About this item", "Product details", "Overview", "Specifications"
					const descCandidates = Array.from(document.querySelectorAll('[itemprop="description"], .product-description, .product__description, #description, [id*="description" i], [class*="description" i], #descripcion, [id*="descripci" i], [class*="descripci" i], [id*="about" i], [class*="about" i], [id*="details" i], [class*="details" i], [id*="overview" i], [class*="overview" i], [id*="specifications" i], [class*="specifications" i]'));
					let descEl = preferLongestText(descCandidates);
					// Fallback: pick a visible text block near title with decent length
					if (!descEl && titleEl) {
						const scope = titleEl.closest('section, main, article') || document.body;
						// Prefer blocks preceded by headings with EN/ES description hints
						// Include lists (ul) commonly used under headings like "About this item"
						const blocks = Array.from(scope.querySelectorAll('p, div, section, ul')).filter(e => {
							if (!visible(e)) return false;
							if (e.tagName && e.tagName.toLowerCase() === 'ul') {
								// Accept meaningful bullet lists with at least 3 items or decent text
								const items = e.querySelectorAll('li');
								if (items.length >= 3) return true;
							}
							return txt(e).length >= 120;
						});
						const headingHint = (el) => {
							let prev = el.previousElementSibling, hops = 0;
							while (prev && hops < 4) {
								if (/^h[1-6]$|^summary$|^button$/i.test(prev.tagName)) {
									const t = txt(prev).toLowerCase();
									// Strong bonus for exact phrases seen on major retailers (e.g., Amazon)
									if (/(about\s+this\s+item|product\s+details|key\s+features)/i.test(t)) return 5;
									if (/(description|details|about|product|overview|specifications)|(descripci[oó]n|detalles|acerca|resumen|caracter[ií]sticas|especificaciones)/i.test(t)) return 3;
								}
								prev = prev.previousElementSibling; hops++;
							}
							return 0;
						};
						let best = null, bestScore = 0;
						for (const b of blocks){
							const isUl = b.tagName && b.tagName.toLowerCase() === 'ul';
							const len = txt(b).length;
							const bonus = headingHint(b);
							// Give additional weight to ULs when preceded by a strong heading (e.g., "About this item")
							const listBoost = isUl && bonus >= 3 ? 400 : 0;
							const s = len + bonus * 200 + listBoost;
							if (s > bestScore) { best = b; bestScore = s; }
						}
						descEl = best;
					}
					// If still not found, explicitly look for headings like "About this item" and pick the next content block
					if (!descEl) {
						const heading = Array.from((document.querySelectorAll('h1,h2,h3,h4,h5,summary,button') || [])).find(h => {
							const t = txt(h).toLowerCase();
							return /(about\s+this\s+item|product\s+details|key\s+features|overview|specifications)/i.test(t);
						});
						if (heading) {
							let sib = heading.nextElementSibling;
							// Skip over trivial siblings like icons/images
							while (sib && (/^(svg|img|picture)$/i.test(sib.tagName))) sib = sib.nextElementSibling;
							if (sib && visible(sib)) descEl = sib;
						}
					}
					if (descEl) out.description = pickSelector(descEl);

					function inDisallowedChrome(el){
						try {
							let n = el;
							for (let i=0; n && i<6; i++) {
								const tag = (n.tagName || '').toLowerCase();
								const role = (n.getAttribute && n.getAttribute('role')) || '';
								const cls = (n.className || '').toString().toLowerCase();
								if (tag === 'footer' || tag === 'nav' || tag === 'header' || role === 'navigation' || /\bfooter\b/.test(cls)) return true;
								n = n.parentElement;
							}
							return false;
						} catch { return false; }
					}

					function findPanelForTrigger(tr){
						if (!tr) return null;
						const ac = tr.getAttribute('aria-controls');
						if (ac) { const p = document.getElementById(ac); if (p) return p; }
						let sib = tr.nextElementSibling;
						while (sib && (/^(svg|img|picture)$/i.test(sib.tagName))) sib = sib.nextElementSibling;
						if (sib) return sib;
						// Try parent panel
						let par = tr.parentElement;
						for (let i=0; par && i<4; i++){
							if (/panel|content|section|tab|accordion/i.test(par.className || '')) return par;
							par = par.parentElement;
						}
						return null;
					}

					function validateAndScorePanel(el, type){
						if (!el || !visible(el) || inDisallowedChrome(el)) return -1;
						const t = txt(el).toLowerCase();
						const idc = ((el.id || '') + ' ' + (el.className || '')).toLowerCase();
						const len = t.length;
						if (len < 60) return -1; // too short to be useful
						const kw = {
							shipping: {
								core: /(shipping|env[ií]o|envios|env[íi]os|delivery|entrega|despacho)/i,
								extra: /(free|gratis|cost|costo|precio|fee|tarifa|times?|tiempo|d[ií]as|days|method|m[eé]todo|carrier|courier|polic[yí]a|pol[ií]tica)/i
							},
							returns: {
								core: /(returns?|devoluci[oó]n(?:es)?|cambios?|reembolsos?)/i,
								extra: /(policy|pol[ií]tica|period|plazo|days|d[ií]as|refund|exchange|replace|cambio|reembolso)/i
							}
						};
						const set = kw[type];
						let score = 0;
						if (set.core.test(t)) score += 3;
						if (set.extra.test(t)) score += 2;
						// Bonus for id/class hints
						if ((type === 'shipping' && /(ship|envio|delivery|entrega|despacho)/i.test(idc)) ||
							(type === 'returns' && /(return|devolu|reembolso|cambio)/i.test(idc))) score += 2;
						// Normalize by length but cap influence
						score += Math.min(3, Math.floor(len / 400));
						return score;
					}

					// Shipping
					const shipTriggers = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,button,[role="tab"],a,summary,[aria-controls]'))
						.filter(n => /shipping|env[ií]o|envios|env[íi]os|delivery|entrega|despacho/i.test(txt(n)) && !inDisallowedChrome(n));
					let bestShip = { el: null, score: -1 };
					for (const tr of shipTriggers){
						const panel = findPanelForTrigger(tr);
						const sc = validateAndScorePanel(panel, 'shipping');
						if (sc > bestShip.score) bestShip = { el: panel, score: sc };
					}
					if (bestShip.el && bestShip.score >= 4) out.shipping = pickSelector(bestShip.el);

					// Returns
					const retTriggers = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,button,[role="tab"],a,summary,[aria-controls]'))
						.filter(n => /returns?|devoluci[oó]n(?:es)?|cambios?|reembolsos?/i.test(txt(n)) && !inDisallowedChrome(n));
					let bestRet = { el: null, score: -1 };
					for (const tr of retTriggers){
						const panel = findPanelForTrigger(tr);
						const sc = validateAndScorePanel(panel, 'returns');
						if (sc > bestRet.score) bestRet = { el: panel, score: sc };
					}
					if (bestRet.el && bestRet.score >= 4) out.returns = pickSelector(bestRet.el);
				} catch {}
				return out;
			}
		});
		return result || {};
	} catch { return {}; }
}

/** Build a plan object consistent with backend schema. */
async function buildPlan(payload, isPdp, score, ctx){
	const fields = {};
	try {
		const tabId = ctx && typeof ctx.tabId === 'number' ? ctx.tabId : undefined;
		const sels = tabId != null ? await discoverSelectorsInPage(tabId) : {};
		if (sels.title) fields.title = { selector: sels.title, html: false };
		if (sels.description) fields.description = { selector: sels.description, html: true };
		if (sels.shipping) fields.shipping = { selector: sels.shipping, html: true };
		if (sels.returns) fields.returns = { selector: sels.returns, html: true };
	} catch {}
	return {
		is_pdp: !!isPdp,
		score: typeof score === 'number' ? score : undefined,
		fields,
		patch: [],
		meta: { strategy: 'heuristics', url: payload?.url || '' }
	};
}

/** Main entry for background: fast PDP detection with optional LLM fallback upstream */
async function heuristicsStrategy(payload, ctx){
    const { score, strong_product } = evaluateSignals(payload);
    let threshold = 10;
    try {
        const cfg = await api.storage.local.get(["pdpSettings"]);
        const p = cfg?.pdpSettings;
        if (p && typeof p.minScoreToContinue === 'number') threshold = p.minScoreToContinue;
    } catch {}
    const gate = (typeof score === 'number' && score > threshold) || !!strong_product;
    const isPdp = gate && score >= 7 && !!strong_product;
    if (!gate) return await buildPlan(payload, false, score, ctx);
    return await buildPlan(payload, isPdp, score, ctx);
}

self.heuristicsStrategy = heuristicsStrategy;
})();
