
// popup/index.js — Popup UI for viewing and controlling applied changes
const api = (typeof browser !== 'undefined') ? browser : chrome;
const DEBUG = true;
const log = (...args) => { if (DEBUG) console.debug("[PDP][popup]", ...args); };

/** Initialize popup: load plan, render diffs, bind actions. */
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
      ? `<div id="error" class="error"><div class="card" style="background:#FDE8E8;color:#611A15;border:1px solid #F8B4B4"><strong>Backend error</strong><div class="mono" style="white-space:pre-wrap">${enc(String(lastError))}</div></div></div>`
      : `<div id="error" class="error" style="display:none"></div>`;
    app.innerHTML = `${errBox}<div class="divider"></div><div class="link"><a id="openOptions" href="#">Settings</a></div>`;
    bindOptions();
    return;
  }
  const enc = (s) => { const d=document.createElement("div"); d.textContent=String(s ?? ""); return d.innerHTML; };

  // Try to fetch latest apply summary BEFORE rendering so we can show applied values
  let latestSummary = null;
  try {
    const { summary } = await api.runtime.sendMessage({ type: "GET_APPLY_SUMMARY", url, tabId });
    if (summary && typeof summary === 'object') latestSummary = summary;
  } catch {}

  /** Render diff for a single field with selector and prev/current panes. */
  const renderFieldDiff = (key, label) => {
    const f = plan.fields?.[key] || {};
    const hasSelector = typeof f.selector === 'string' && f.selector.length > 0;
    const selector = hasSelector ? enc(f.selector) : '<span style="color:#6b7280">(no selector)</span>';
    const allowHTML = !!f.html;
    // If no selector, only show label + selector note, skip prev/current panes
    if (!hasSelector) {
      return `
      <div class="diff-item">
        <div class="label">${label}</div>
        <div class="selector"><small class="mono">${selector}</small></div>
      </div>
      `;
    }
    const prev = typeof f.original === 'string' ? f.original : '';
    // Prefer applied value from summary (post-patch), else fall back to proposed/top-level
    let applied = '';
    try {
      if (hasSelector && latestSummary && Array.isArray(latestSummary.results)) {
        const r = latestSummary.results.find(r => r && r.status === 'applied' && r.selector === f.selector && typeof r.value === 'string');
        if (r && typeof r.value === 'string') applied = r.value;
      }
    } catch {}
    let curr = '';
    if (typeof applied === 'string' && applied.length > 0) curr = applied;
    else if (typeof f.proposed === 'string') curr = f.proposed;
    else if (typeof plan[key] === 'string') curr = plan[key];

    const prevHtml = allowHTML ? prev : enc(prev);
    const currHtml = allowHTML ? curr : enc(curr);
    return `
      <div class="diff-item">
        <div class="label">${label}</div>
        <div class="selector"><small class="mono">${selector}</small></div>
        <div class="diff-grid">
          <div>
            <div class="label">Previous</div>
            <div class="card">${prevHtml || '<span style="color:#6b7280">(empty)</span>'}</div>
          </div>
          <div>
            <div class="label">Current</div>
            <div class="card">${currHtml || '<span style="color:#6b7280">(empty)</span>'}</div>
          </div>
        </div>
      </div>
    `;
  };

  const resultHeader = plan.is_pdp ? 'PDP detected' : 'No PDP detected';
  const resultEmoji = plan.is_pdp ? '✅' : 'ℹ️';
  const tookMs = (plan?.meta && typeof plan.meta.process_ms === 'number') ? plan.meta.process_ms : null;
  const tookStr = (tookMs != null) ? ` · ${(tookMs/1000).toFixed(2)}s` : '';
  // Build list of additional applied changes beyond the primary field selectors
  let extraAppliedHtml = '';
  try {
    if (latestSummary && Array.isArray(latestSummary.results)) {
      const primarySelectors = new Set(["title","description","shipping","returns"].map(k => plan.fields?.[k]?.selector).filter(Boolean));
      const extras = latestSummary.results.filter(r => r && r.status === 'applied' && r.selector && !primarySelectors.has(r.selector));
      if (extras.length > 0) {
        const items = extras.map(r => {
          const val = (typeof r.value === 'string') ? r.value : '';
          const show = val ? enc(val) : '<span style="color:#6b7280">(no value)</span>';
          return `<div class="result"><code>${enc(r.op)}</code> <code>${enc(r.selector)}</code><div class="card">${show}</div></div>`;
        }).join("");
        extraAppliedHtml = `<div class="divider"></div><div class="extras"><div class="label">Additional applied changes</div>${items}</div>`;
      }
    }
  } catch {}

  app.innerHTML = `
    <div class="topbar">
      <div class="left">
        <h3>${resultEmoji} ${resultHeader}${tookStr}</h3>
      </div>
      <div id="actionsRight" class="right actions icons" style="display:none">
        <button id="saveHtml" class="icon-btn" title="Save reduced HTML" aria-label="Save reduced HTML">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3a1 1 0 011 1v8.59l2.3-2.3a1 1 0 011.4 1.42l-4 4a1 1 0 01-1.4 0l-4-4a1 1 0 111.4-1.42L11 12.59V4a1 1 0 011-1zM5 17a1 1 0 100 2h14a1 1 0 100-2H5z"/></svg>
        </button>
        <button id="revert" class="icon-btn" title="Revert" aria-label="Revert" disabled>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M9.53 2.47a.75.75 0 010 1.06L6.06 7H15a6 6 0 010 12h-3a.75.75 0 010-1.5h3a4.5 4.5 0 000-9H6.06l3.47 3.47a.75.75 0 11-1.06 1.06l-4.75-4.75a.75.75 0 010-1.06l4.75-4.75a.75.75 0 011.06 0z"/></svg>
        </button>
        <button id="reapply" class="icon-btn" title="Re-apply" aria-label="Re-apply" disabled>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M9.53 2.47a.75.75 0 010 1.06L6.06 7H15a6 6 0 010 12h-3a.75.75 0 010-1.5h3a4.5 4.5 0 000-9H6.06l3.47 3.47a.75.75 0 11-1.06 1.06l-4.75-4.75a.75.75 0 010-1.06l4.75-4.75a.75.75 0 011.06 0z"/></svg>
        </button>
      </div>
    </div>
    <div id="error" class="error" style="display:none"></div>
    <div id="diffs" class="diffs">
      ${renderFieldDiff('title','Title')}
      ${renderFieldDiff('description','Description')}
      ${renderFieldDiff('shipping','Shipping')}
      ${renderFieldDiff('returns','Returns')}
    </div>
    ${extraAppliedHtml}
    <div class="divider"></div>
    <div class="link"><a id="openOptions" href="#">Settings</a></div>
  `;
  bindOptions();

  // If we already know there's a proxy error, show it and hide details/actions immediately
  if (lastError) {
    const box = document.getElementById("error");
    if (box) {
      box.style.display = "block";
      const enc = (s) => { const d=document.createElement("div"); d.textContent=s; return d.innerHTML; };
      box.innerHTML = `<div class="card" style="background:#FDE8E8;color:#611A15;border:1px solid #F8B4B4"><strong>Backend error</strong><div class="mono" style="white-space:pre-wrap">${enc(String(lastError))}</div></div>`;
    }
    const diffsEl = document.getElementById("diffs");
    if (diffsEl) diffsEl.style.display = "none";
    const actionsRightInit = document.getElementById("actionsRight");
    if (actionsRightInit) actionsRightInit.style.display = "none";
  }

  // also fetch any last error and render it
  try {
    const { error } = await api.runtime.sendMessage({ type: "GET_LAST_ERROR", url, tabId });
    const box = document.getElementById("error");
    if (box && error) {
      box.style.display = "block";
      const enc = (s) => { const d=document.createElement("div"); d.textContent=s; return d.innerHTML; };
      box.innerHTML = `<div class="card" style="background:#FDE8E8;color:#611A15;border:1px solid #F8B4B4"><strong>Backend error</strong><div class="mono" style="white-space:pre-wrap">${enc(String(error))}</div></div>`;
      const diffsEl = document.getElementById("diffs");
      if (diffsEl) diffsEl.style.display = "none";
      const actionsRightEl = document.getElementById("actionsRight");
      if (actionsRightEl) actionsRightEl.style.display = "none";
    }
  } catch {}

  const revertBtn = document.getElementById("revert");
  const reapplyBtn = document.getElementById("reapply");
  const saveHtmlLink = document.getElementById("saveHtml");
  const actionsRight = document.getElementById("actionsRight");

  const hasApplied = Array.isArray(latestSummary?.results) && latestSummary.results.some(r => r.status === 'applied');
  const hasPrev = Array.isArray(latestSummary?.results) && latestSummary.results.some(r => typeof r.prev === 'string');

  // Enable revert only if there were applied steps
  if (hasApplied) revertBtn.removeAttribute('disabled');
  // Enable re-apply only if we can revert (i.e., have prev snapshots)
  if (hasPrev) reapplyBtn.removeAttribute('disabled');
  // Show actions only when we have a result (applied steps)
  if (actionsRight) actionsRight.style.display = hasApplied ? 'flex' : 'none';

  if (saveHtmlLink) {
    saveHtmlLink.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        const [tab] = await api.tabs.query({ active:true, currentWindow:true });
        const tabId = tab?.id;
        if (tabId == null) return;
        // Ask content script for its reduced HTML
        const { html, error } = await api.tabs.sendMessage(tabId, { type: 'GET_REDUCED_HTML' });
        if (error) throw new Error(String(error));
        const blob = new Blob([html || ''], { type: 'text/html;charset=utf-8' });
        const blobUrl = URL.createObjectURL(blob);
        const filename = 'reduced-pdp.html';
        try {
          await api.downloads.download({ url: blobUrl, filename, saveAs: true });
        } catch {
          const a = document.createElement('a');
          a.href = blobUrl; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
        }
      } catch (err) {
        console.error('[PDP][popup] save html error', err);
      }
    });
  }

  /** Build an inverse plan from an apply summary. */
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
            const val = (typeof f.original === 'string') ? f.original : '';
            inv.patch.push({ selector: f.selector, op: (f.html ? "setHTML" : "setText"), value: val, noPrefix: true, allowEmpty: true });
            break;
          }
        }
      }
    }
    return inv;
  }

  /** Build a forward plan (re-apply) from an apply summary. */
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
            const val = (typeof f.proposed === 'string') ? f.proposed : '';
            fwd.patch.push({ selector: f.selector, op: (f.html ? "setHTML" : "setText"), value: val });
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

// Legacy inverse helper (kept for reference)
function makeInverse(plan){
  const inv = JSON.parse(JSON.stringify(plan));
  inv.patch = [];
  for (const key of ["title","description","shipping","returns"]) {
    const f = plan.fields?.[key];
    if (f?.selector) {
      const val = (typeof f.original === 'string') ? f.original : '';
      inv.patch.push({ selector: f.selector, op: (f.html ? "setHTML" : "setText"), value: val });
    }
  }
  log("inverse built", { steps: inv.patch.length });
  return inv;
}

/** Bind Settings link to open the options page. */
function bindOptions(){
  const link = document.getElementById("openOptions");
  if (link) link.addEventListener("click", (e)=>{
    e.preventDefault();
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else window.open(chrome.runtime.getURL("options/index.html"));
  });
}

init();
