// utils/utils.js — Small shared helpers used by background and strategies
// Exposes a minimal API on the global scope for the service worker.

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

self.patternToRegex = patternToRegex;
self.shouldRun = shouldRun;
self.makeTraceId = makeTraceId;

/**
 * Ensure a vendor script is present in the page by URL. Returns true if present or loaded.
 */
function ensureVendorScript(tabId, path){
  const api = (typeof browser !== 'undefined') ? browser : chrome;
  const url = api.runtime.getURL(path);
  return new Promise(async (resolve) => {
    try {
      const [{ result } = { result: null }] = await api.scripting.executeScript({ target: { tabId }, func: (u) => {
        return new Promise((res) => {
          try {
            const exists = Array.from(document.scripts || []).some(s => s && s.src === u);
            if (exists) { res(true); return; }
            const s = document.createElement('script');
            s.src = u; s.type = 'text/javascript'; s.async = true; s.onload = () => res(true); s.onerror = () => res(false);
            (document.head || document.documentElement).appendChild(s);
          } catch { res(false); }
        });
      }, args: [url] });
      resolve(!!result);
    } catch { resolve(false); }
  });
}

self.ensureVendorScript = ensureVendorScript;

