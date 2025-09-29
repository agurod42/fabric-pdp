export const config = { runtime: "edge" };
import { jsonResponse, createStream, buildOpenAIEnv, buildOpenAIHeaders } from "./_utils";

type PatchStep = { selector: string; op: "setText" | "setHTML"; value: string };

type FieldOut = {
  selector: string;          // may be ""
  selector_note: string;     // may be ""
  extracted: string;         // text for title; innerHTML for others; may be ""
  proposed: string;          // rewritten content; may be ""
};

type ChunkResult = {
  fields?: {
    title?: FieldOut;
    description?: FieldOut;
    shipping?: FieldOut;
    returns?: FieldOut;
  };
  patch?: PatchStep[];
};

function isDisallowedSelector(sel: string): boolean {
  if (!sel || typeof sel !== "string") return true;
  const s = sel.trim();
  // Block obvious non-product areas and branding/nav/footer selectors
  const badCtx = /(\b|[#.\-])(header|nav|navbar|logo|branding|breadcrumb|footer|menu|account|login|signup|search|newsletter|cart|bag)(\b|[#.\-])/i;
  if (badCtx.test(s)) return true;
  // Block selectors that likely indicate non-content UI/branding/metadata
  const uiNoise = /(\b|[#.\-])(icon|badge|label|sku|variant|size|color|swatch|price|pricing|quantity|qty|social|share|cookie|payment|paypal|applepay|klarna|afterpay|visa|mastercard)(\b|[#.\-])/i;
  if (uiNoise.test(s)) return true;
  // Block selectors that directly target <img>
  if (/^(\s*img\b)|([>\s]img\b)/i.test(s)) return true;
  return false;
}

async function chatJSON(
  base: string,
  model: string,
  apiKey: string,
  traceId: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  maxTokens = 800,
  timeoutMs = 45000
): Promise<ChunkResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    const resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: buildOpenAIHeaders(apiKey, traceId),
      body: JSON.stringify({
        model,
        temperature: model === "gpt-5" ? 1 : 0,
        stream: false,
        response_format: { type: "json_object" },
        messages,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      let err = ""; try { err = await resp.text(); } catch {}
      throw new Error(`LLM ${resp.status}: ${err || resp.statusText}`);
    }
    const json = await resp.json();
    const txt = (json?.choices?.[0]?.message?.content ?? "").trim();
    const start = txt.indexOf("{");
    const end = txt.lastIndexOf("}");
    let raw = (start >= 0 && end > start) ? txt.slice(start, end + 1) : "{}";
    // Remove common wrappers like code fences
    if (/^```/.test(raw)) {
      const s = raw.indexOf("{"); const e = raw.lastIndexOf("}");
      raw = (s >= 0 && e > s) ? raw.slice(s, e + 1) : raw;
    }
    try {
      return JSON.parse(raw);
    } catch {
      try {
        // Fallback: strip trailing commas
        const fixed = raw.replace(/,(\s*[}\]])/g, "$1");
        return JSON.parse(fixed);
      } catch {
        // Last resort: ignore this chunk
        return {} as ChunkResult;
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

function splitIntoN(s: string, n: number): string[] {
  if (!s) return [];
  const size = Math.ceil(s.length / n);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const start = i * size;
    if (start >= s.length) break;
    out.push(s.slice(start, Math.min(start + size, s.length)));
  }
  return out;
}

async function mapWithConcurrency<I, O>(
  items: I[],
  limit: number,
  fn: (item: I, index: number) => Promise<O>
): Promise<O[]> {
  const out: O[] = new Array(items.length);
  let i = 0;
  const runners: Promise<void>[] = [];
  async function run() {
    while (true) {
      const idx = i; i++; if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  for (let k = 0; k < n; k++) runners.push(run());
  await Promise.all(runners);
  return out;
}

/** Merge patches across chunks:
 * - drop meta targets
 * - dedup exact duplicates by (selector, op); keep the first
 */
function mergePatches(all: PatchStep[][]): PatchStep[] {
  const seen = new Set<string>();
  const merged: PatchStep[] = [];
  for (const arr of all) {
    if (!Array.isArray(arr)) continue;
    for (const st of arr) {
      if (!st || typeof st.selector !== "string") continue;
      if (st.op !== "setText" && st.op !== "setHTML") continue;
      if (typeof st.value !== "string" || !st.value) continue;
      if (/^meta(\{|\[|\.|\s|$)/i.test(st.selector)) continue;
      const key = `${st.op}@@${st.selector}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(st);
    }
  }
  return merged;
}

/** Merge fields across chunks:
 * Pick the "best" single candidate per field:
 *  - prefer the one with the longest extracted (fallback to longest proposed)
 *  - if ties, keep the first encountered
 */
function pickBestField(cands: FieldOut[]): FieldOut {
  if (!cands.length) return { selector: "", selector_note: "", extracted: "", proposed: "" };
  let best = cands[0];
  let bestScore = (best.extracted || "").length || (best.proposed || "").length;
  for (let i = 1; i < cands.length; i++) {
    const f = cands[i];
    const score = (f.extracted || "").length || (f.proposed || "").length;
    if (score > bestScore) {
      best = f;
      bestScore = score;
    }
  }
  // ensure defined strings
  return {
    selector: best.selector || "",
    selector_note: best.selector_note || "",
    extracted: best.extracted || "",
    proposed: best.proposed || "",
  };
}

export default async function handler(req: Request) {
  if (req.method === "OPTIONS") return jsonResponse({}, 204);
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);

  const { url, title, meta, html_excerpt, language, jsonld, trace_id } = await req.json().catch(() => ({}));
  const traceId = typeof trace_id === "string" ? trace_id : "";

  const { readable, writer, encoder, headers } = createStream();
  (async () => {
    try {
      // early byte to satisfy edge/proxy initial-response windows
      await writer.write(encoder.encode(" "));

      const safe = (s: any) => (typeof s === "string" ? s : "");
      const payload = {
        url: safe(url),
        title: safe(title),
        meta: (meta && typeof meta === "object") ? meta : {},
        language: safe(language),
        // FRONTEND already sent trimmed HTML
        html_excerpt: safe(html_excerpt),
        jsonld: Array.isArray(jsonld) || (jsonld && typeof jsonld === "object") ? jsonld : [],
        trace_id: traceId,
      };

      const html = payload.html_excerpt || "";
      const NUM_PROCESSES = 10;
      const chunks = splitIntoN(html, NUM_PROCESSES);

      const { base: OPENAI_BASE, model: OPENAI_MODEL, apiKey: OPENAI_API_KEY } = buildOpenAIEnv();
      if (!OPENAI_API_KEY) {
        await writer.write(encoder.encode(JSON.stringify({ error: "Server misconfiguration: OPENAI_API_KEY is required" })));
        await writer.close();
        return;
      }

      // Per-chunk: produce fields (single best per field present in fragment) AND patch steps.
      // Multiple selectors per field may appear in the patch (allowed).
      const CHUNK_SYS = `
You are a Product Detail Page (PDP) extractor and rewriter. Assume the overall page IS a PDP.
You receive ONLY a fragment of pre-trimmed HTML. For THIS fragment:
- If a field is present (title, description, shipping, returns), output ONE best candidate in "fields".
- You may include MULTIPLE patch steps per field (e.g., duplicates in UI).

You may use provided context hints (page_title, meta, jsonld) to disambiguate what is product content, but DO NOT copy those hints verbatim as page content. Extract only from the HTML fragment.

HARD EXCLUSIONS (never select from these):
- Tags/areas: header, nav, footer, aside, breadcrumb, menu, modal, drawer, offcanvas
- Elements whose id/class contains: logo, brand, branding, navbar, header, breadcrumb, footer, menu, cart, bag, account, login, signup, search, newsletter, icon, badge, label, sku, variant, size, color, price, social, share, cookie, payment
- Any <img> alt/title/aria-label/data-* attribute values (do not read attributes as content)
- Anchors linking to home/root (href="/" or root domain) or brand pages

TITLE SELECTION (strict):
- Prefer a product-specific <h1> within the main/product container; fallback to a strong <h2> only if it is clearly the product name.
- Must be visible text content (not attributes), 3–120 chars, not equal to the site or brand name, and not just a category or collection.
- Favor nodes within a container whose ancestors indicate product context (class/id with "product", near price/SKU/variants).
- Reject candidates located inside excluded areas or with class/id indicating branding or navigation.

DESCRIPTION SELECTION:
- Prefer the primary product description container with paragraph-rich text; > 40 words of meaningful copy.
- Allow minimal HTML only: <p>, <ul>, <li>, <strong>, <em>.
- Exclude marketing banners, policy footers, or sitewide generic text; avoid content under footer/header/nav.

SHIPPING/RETURNS SELECTION:
- Prefer content containers (panels/sections) actually holding the text (NOT the tab/button/trigger).
- Accept generic bullet points only if the fragment lacks concrete policy text.
- Exclude footer sitewide policy links; use content adjacent to the product area when possible.

 SELECTOR RULES (very strict and deterministic):
 - The selector MUST match at least one element in THIS fragment.
 - Prefer a single id if present (e.g., #product-title). If not, prefer a short class chain of 1–2 classes that are semantic and likely stable (e.g., .product .title). Avoid positional selectors.
 - Allowed attributes for targeting are limited to: id, class, data-testid, data-test, itemprop, aria-label, aria-labelledby. Do NOT use contains/starts-with attribute hacks.
 - DO NOT use :nth-child, :nth-of-type, :not(), wildcard *, or selectors that target button/tab triggers.
 - Target content containers (for description/shipping/returns), not triggers.
 - Provide a short selector_note explaining WHY this selector is the product field and what was excluded (e.g., "excluded header .logo title").

OUTPUT RULES:
- Proposed values:
  • title.proposed ≤ 70 chars, remove branding words; use "setText"
  • description.proposed 120–200 words, minimal HTML; use "setHTML"
  • shipping/returns proposed as <ul><li>…</li></ul> (generic if unclear); use "setHTML"
- If you are NOT confident a field is present, omit it entirely. Do NOT hallucinate.
- Output STRICT JSON with ONLY:
{
  "fields": {
    "title"?: { "selector": string, "selector_note": string, "extracted": string, "proposed": string },
    "description"?: { "selector": string, "selector_note": string, "extracted": string, "proposed": string },
    "shipping"?: { "selector": string, "selector_note": string, "extracted": string, "proposed": string },
    "returns"?: { "selector": string, "selector_note": string, "extracted": string, "proposed": string }
  },
  "patch": Array<{ "selector": string, "op": "setText"|"setHTML", "value": string }>
}
- Omit absent fields. No extra keys. No comments.
      `.trim();

      const perChunk = await mapWithConcurrency(
        chunks,
        NUM_PROCESSES,
        async (frag, idx) => {
            const user = JSON.stringify({
            url: payload.url,
            language: payload.language,
            page_title: payload.title,
            meta: payload.meta,
            jsonld: payload.jsonld,
            fragment_index: idx,
            html_fragment: frag,
          });
          const out = await chatJSON(
            OPENAI_BASE,
            OPENAI_MODEL,
            OPENAI_API_KEY,
            traceId,
            [
              { role: "system", content: CHUNK_SYS },
              { role: "user", content: user },
            ],
            900,
            45000
          );

          // Normalize fields
          const f = out?.fields || {};
          const normField = (x: any): FieldOut | undefined => {
            if (!x) return undefined;
            const sel = typeof x.selector === "string" ? x.selector : "";
            const note = typeof x.selector_note === "string" ? x.selector_note : "";
            const extracted = typeof x.extracted === "string" ? x.extracted : "";
            const proposed = typeof x.proposed === "string" ? x.proposed : "";
            if (isDisallowedSelector(sel)) return undefined;
            return { selector: sel, selector_note: note, extracted, proposed };
          };

          const validateSelectorInFragment = (sel) => {
            try {
              if (typeof sel !== "string" || !sel.trim()) return false;
              // In Edge runtime there is no DOMParser; if unavailable, skip strict validation
              if (typeof (globalThis as any).DOMParser === 'undefined') return true;
              // Very minimal CSS selector existence check within fragment using DOMParser
              const doc = new (globalThis as any).DOMParser().parseFromString(`<div id="root">${frag}</div>`, "text/html");
              const root = doc.getElementById("root");
              if (!root) return false;
              return !!root.querySelector(sel);
            } catch { return false; }
          };
          const nfTitle = normField(f.title);
          const nfDesc = normField(f.description);
          const nfShip = normField(f.shipping);
          const nfRet = normField(f.returns);
          const fields = {
            title: (nfTitle && validateSelectorInFragment(nfTitle.selector)) ? nfTitle : undefined,
            description: (nfDesc && validateSelectorInFragment(nfDesc.selector)) ? nfDesc : undefined,
            shipping: (nfShip && validateSelectorInFragment(nfShip.selector)) ? nfShip : undefined,
            returns: (nfRet && validateSelectorInFragment(nfRet.selector)) ? nfRet : undefined,
          };

          // Normalize patches
          // Ignore free-form LLM patches at the chunk level; we will build safe patches from final fields later
          return { fields, patch: [] } as ChunkResult;
        }
      );

      // Merge fields: collect candidates per field across chunks, then pick best
      const titleCands: FieldOut[] = [];
      const descCands: FieldOut[] = [];
      const shipCands: FieldOut[] = [];
      const retCands: FieldOut[] = [];
      const allPatchLists: PatchStep[][] = [];

      for (const r of perChunk) {
        if (!r) continue;
        if (r.fields?.title && (r.fields.title.selector || r.fields.title.extracted || r.fields.title.proposed)) titleCands.push(r.fields.title);
        if (r.fields?.description && (r.fields.description.selector || r.fields.description.extracted || r.fields.description.proposed)) descCands.push(r.fields.description);
        if (r.fields?.shipping && (r.fields.shipping.selector || r.fields.shipping.extracted || r.fields.shipping.proposed)) shipCands.push(r.fields.shipping);
        if (r.fields?.returns && (r.fields.returns.selector || r.fields.returns.extracted || r.fields.returns.proposed)) retCands.push(r.fields.returns);
        if (Array.isArray(r.patch)) allPatchLists.push(r.patch);
      }

      const fields = {
        title: pickBestField(titleCands),
        description: pickBestField(descCands),
        shipping: pickBestField(shipCands),
        returns: pickBestField(retCands),
      };

      // Build a conservative patch strictly from the chosen fields.
      const patch: PatchStep[] = [];
      try {
        const addIfValid = (selector: string, op: "setText" | "setHTML", value: string) => {
          if (!selector || !value) return;
          if (isDisallowedSelector(selector)) return;
          patch.push({ selector, op, value });
        };
        if (fields.title?.selector && fields.title.proposed) {
          addIfValid(fields.title.selector, "setText", fields.title.proposed);
        }
        if (fields.description?.selector && fields.description.proposed) {
          addIfValid(fields.description.selector, "setHTML", fields.description.proposed);
        }
        if (fields.shipping?.selector && fields.shipping.proposed) {
          addIfValid(fields.shipping.selector, "setHTML", fields.shipping.proposed);
        }
        if (fields.returns?.selector && fields.returns.proposed) {
          addIfValid(fields.returns.selector, "setHTML", fields.returns.proposed);
        }
      } catch {}

      // Final minimal schema (no diagnostics, no warnings)
      const response = {
        is_pdp: true,
        confidence: 1,
        language: payload.language || "",
        url: payload.url || "",
        trace_id: traceId,
        fields,
        patch,
      };

      await writer.write(encoder.encode(JSON.stringify(response)));
      await writer.close();
    } catch (e: any) {
      try { await writer.write(encoder.encode(JSON.stringify({ error: String(e?.message || e) }))); } catch {}
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, { status: 200, headers });
}
