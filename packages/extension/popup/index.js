
const api = (typeof browser !== 'undefined') ? browser : chrome;
const DEBUG = true;
const log = (...args) => { if (DEBUG) console.debug("[PDP][popup]", ...args); };

async function init(){
  log("init popup");
  const [tab] = await api.tabs.query({ active:true, currentWindow:true });
  const url = tab.url;
  const tabId = tab.id;
  log("current tab", { url });
  // Fetch any last error early so we can display it even if no plan is cached
  let lastError = null;
  try {
    const { error } = await api.runtime.sendMessage({ type: "GET_LAST_ERROR", url, tabId });
    if (error) lastError = error;
  } catch {}
  const res = await api.runtime.sendMessage({ type: "GET_PLAN", url, tabId });
  const plan = res?.plan;
  const app = document.getElementById("app");
  if (!plan) {
    const enc = s => { const d=document.createElement("div"); d.textContent=s; return d.innerHTML; };
    const errBox = lastError
      ? `<div id="error" class="error"><div class="card" style="background:#FDE8E8;color:#611A15;border:1px solid #F8B4B4"><strong>Proxy error</strong><div class="mono" style="white-space:pre-wrap">${enc(String(lastError))}</div></div></div>`
      : `<div id="error" class="error" style="display:none"></div>`;
    app.innerHTML = `${errBox}<div class="link"><a id="openOptions" href="#">Settings (whitelist)</a></div>`;
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
    <div id="error" class="error" style="display:none"></div>
    <div id="summary" class="summary"></div>
    <div class="grid">
      ${sec("Title", plan.fields?.title)}
      ${sec("Description", plan.fields?.description)}
      ${sec("Shipping", plan.fields?.shipping)}
      ${sec("Returns", plan.fields?.returns)}
    </div>
    <div class="actions">
      <button id="revert" disabled>Revert</button>
      <button id="reapply" disabled>Re-apply</button>
    </div>
    <div class="link"><a id="openOptions" href="#">Settings (whitelist)</a></div>
  `;
  bindOptions();

  // fetch latest apply summary (if any) for this tab+url
  // also fetch any last error
  let latestSummary = null;
  try {
    const { error } = await api.runtime.sendMessage({ type: "GET_LAST_ERROR", url, tabId });
    const box = document.getElementById("error");
    if (box && error) {
      box.style.display = "block";
      const enc = (s) => { const d=document.createElement("div"); d.textContent=s; return d.innerHTML; };
      box.innerHTML = `<div class="card" style="background:#FDE8E8;color:#611A15;border:1px solid #F8B4B4"><strong>Proxy error</strong><div class="mono" style="white-space:pre-wrap">${enc(String(error))}</div></div>`;
    }
  } catch {}
  try {
    const { summary } = await api.runtime.sendMessage({ type: "GET_APPLY_SUMMARY", url, tabId });
    const box = document.getElementById("summary");
    if (box && summary && typeof summary === 'object') {
      latestSummary = summary;
      const parts = [];
      parts.push(`<div class="summary-row"><strong>Patch</strong>: ${summary.steps_applied || 0}/${summary.steps_total || 0} applied` +
        (summary.steps_skipped ? `, ${summary.steps_skipped} skipped` : '') +
        (summary.steps_error ? `, ${summary.steps_error} errors` : '') +
        ` (${summary.took_ms || 0} ms)</div>`);
      const details = Array.isArray(summary.results) ? summary.results.map(r => {
        const badge = r.status === 'applied' ? '✅' : r.status === 'skipped' ? '⚠️' : '❌';
        const val = (typeof r.value === 'string') ? r.value : '';
        return `<div class="result">${badge} <code>${r.op}</code> <code>${r.selector}</code> — ${r.status}${r.note ? ` (${r.note})` : ''}${val ? `<div><small>value:</small> ${val}</div>` : ''}</div>`;
      }).join("") : "";
      box.innerHTML = `<div class="card">${parts.join("")}${details}</div>`;
    }
  } catch {}

  const revertBtn = document.getElementById("revert");
  const reapplyBtn = document.getElementById("reapply");

  const hasApplied = Array.isArray(latestSummary?.results) && latestSummary.results.some(r => r.status === 'applied');
  const hasPrev = Array.isArray(latestSummary?.results) && latestSummary.results.some(r => typeof r.prev === 'string');

  // Enable revert only if there were applied steps
  if (hasApplied) revertBtn.removeAttribute('disabled');
  // Enable re-apply only if we can revert (i.e., have prev snapshots)
  if (hasPrev) reapplyBtn.removeAttribute('disabled');

  function buildRevertFromSummary(plan, summary){
    const inv = { ...plan, patch: [] };
    const steps = Array.isArray(summary?.results) ? summary.results : [];
    for (const r of steps) {
      if (r.status !== 'applied') continue;
      if (!r.selector || !r.op) continue;
      // Use captured prev content if present, else fall back to fields.original by selector match
      if (typeof r.prev === 'string') {
        inv.patch.push({ selector: r.selector, op: r.op, value: r.prev, noPrefix: true, allowEmpty: true });
      } else {
        for (const key of ["title","description","shipping","returns"]) {
          const f = plan.fields?.[key];
          if (f?.selector === r.selector) {
            inv.patch.push({ selector: f.selector, op: (f.html ? "setHTML" : "setText"), valueRef: `fields.${key}.original`, noPrefix: true, allowEmpty: true });
            break;
          }
        }
      }
    }
    return inv;
  }

  function buildReapplyFromSummary(plan, summary){
    const fwd = { ...plan, patch: [] };
    const steps = Array.isArray(summary?.results) ? summary.results : [];
    for (const r of steps) {
      if (r.status !== 'applied') continue;
      if (!r.selector || !r.op) continue;
      if (typeof r.value === 'string') {
        fwd.patch.push({ selector: r.selector, op: r.op, value: r.value });
      } else {
        for (const key of ["title","description","shipping","returns"]) {
          const f = plan.fields?.[key];
          if (f?.selector === r.selector) {
            fwd.patch.push({ selector: f.selector, op: (f.html ? "setHTML" : "setText"), valueRef: `fields.${key}.proposed` });
            break;
          }
        }
      }
    }
    return fwd;
  }

  revertBtn.addEventListener("click", async () => {
    if (!latestSummary) return;
    const inverse = buildRevertFromSummary(plan, latestSummary);
    log("revert clicked", { steps: inverse.patch.length });
    try { await api.runtime.sendMessage({ type: "SET_BADGE", text: "AP", tabId }); } catch {}
    await api.runtime.sendMessage({ type: "APPLY_PATCH", plan: inverse, tabId });
    try { await api.runtime.sendMessage({ type: "SET_BADGE", text: "PDP", tabId }); } catch {}
    window.close();
  });

  reapplyBtn.addEventListener("click", async () => {
    if (!latestSummary) return;
    const forward = buildReapplyFromSummary(plan, latestSummary);
    log("reapply clicked", { steps: forward.patch.length });
    try { await api.runtime.sendMessage({ type: "SET_BADGE", text: "AP", tabId }); } catch {}
    await api.runtime.sendMessage({ type: "APPLY_PATCH", plan: forward, tabId });
    try { await api.runtime.sendMessage({ type: "SET_BADGE", text: "PDP", tabId }); } catch {}
    window.close();
  });
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
