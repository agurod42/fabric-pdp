
const api = (typeof browser !== 'undefined') ? browser : chrome;
const DEBUG = true;
const log = (...args) => { if (DEBUG) console.debug("[PDP][popup]", ...args); };

async function init(){
  log("init popup");
  const [tab] = await api.tabs.query({ active:true, currentWindow:true });
  const url = tab.url;
  const tabId = tab.id;
  log("current tab", { url });
  const res = await api.runtime.sendMessage({ type: "GET_PLAN", url, tabId });
  const plan = res?.plan;
  const app = document.getElementById("app");
  if (!plan) {
    app.innerHTML = `<div>No analysis cached for this page yet.</div><div class="link"><a id="openOptions" href="#">Settings (whitelist)</a></div>`;
    bindOptions();
    return;
  }
  if (!plan.is_pdp) {
    app.innerHTML = `<div>This page doesn't look like a Product Detail Page.</div><div class="link"><a id="openOptions" href="#">Settings (whitelist)</a></div>`;
    bindOptions();
    return;
  }
  const sec = (label, f) => {
    if (!f) return "";
    const orig = (f.original ?? "(empty)");
    const prop = (f.proposed ?? "(empty)");
    const allowHTML = !!f.html;
    const enc = s => { const d=document.createElement("div"); d.textContent=s; return d.innerHTML; };
    return `
    <div>
      <div class="label">${label} — Original</div>
      <div class="card">${enc(orig)}</div>
    </div>
    <div>
      <div class="label">${label} — Rewritten</div>
      <div class="card">${allowHTML ? prop : enc(prop)}</div>
    </div>`;
  };

  app.innerHTML = `
    <h3>Detected PDP</h3>
    <div class="status"><small class="mono">${url}</small></div>
    <div id="summary" class="summary"></div>
    <div class="grid">
      ${sec("Title", plan.fields?.title)}
      ${sec("Description", plan.fields?.description)}
      ${sec("Shipping", plan.fields?.shipping)}
      ${sec("Returns", plan.fields?.returns)}
    </div>
    <div class="actions">
      <button id="revert">Revert</button>
    </div>
    <div class="link"><a id="openOptions" href="#">Settings (whitelist)</a></div>
  `;
  document.getElementById("revert").addEventListener("click", async () => {
    log("revert clicked");
    const inverse = makeInverse(plan);
    try { await api.runtime.sendMessage({ type: "SET_BADGE", text: "AP", tabId }); } catch {}
    await api.runtime.sendMessage({ type: "APPLY_PATCH", plan: inverse, tabId });
    try { await api.runtime.sendMessage({ type: "SET_BADGE", text: "PDP", tabId }); } catch {}
    window.close();
  });
  bindOptions();

  // fetch latest apply summary (if any) for this tab+url
  try {
    const { summary } = await api.runtime.sendMessage({ type: "GET_APPLY_SUMMARY", url, tabId });
    const box = document.getElementById("summary");
    if (box && summary && typeof summary === 'object') {
      const parts = [];
      parts.push(`<div class=\"summary-row\"><strong>Patch</strong>: ${summary.steps_applied || 0}/${summary.steps_total || 0} applied` +
        (summary.steps_skipped ? `, ${summary.steps_skipped} skipped` : '') +
        (summary.steps_error ? `, ${summary.steps_error} errors` : '') +
        ` (${summary.took_ms || 0} ms)</div>`);
      const details = Array.isArray(summary.results) ? summary.results.slice(0, 6).map(r => {
        const badge = r.status === 'applied' ? '✅' : r.status === 'skipped' ? '⚠️' : '❌';
        return `<div class=\"result\">${badge} <code>${r.op}</code> <code>${r.selector}</code> — ${r.status}${r.note ? ` (${r.note})` : ''}</div>`;
      }).join("") : "";
      box.innerHTML = `<div class=\"card\">${parts.join("")}${details}</div>`;
    }
  } catch {}
}

function makeInverse(plan){
  const inv = JSON.parse(JSON.stringify(plan));
  inv.patch = [];
  for (const key of ["title","description","shipping","returns"]) {
    const f = plan.fields?.[key];
    if (f?.selector) {
      inv.patch.push({ selector: f.selector, op: (f.html ? "setHTML" : "setText"), valueRef: `fields.${key}.original` });
    }
  }
  log("inverse built", { steps: inv.patch.length });
  return inv;
}

function bindOptions(){
  const link = document.getElementById("openOptions");
  if (link) link.addEventListener("click", (e)=>{
    e.preventDefault();
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else window.open(chrome.runtime.getURL("options/index.html"));
  });
}

init();
