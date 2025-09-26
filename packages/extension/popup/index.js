
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
      ? `<div id="error" class="error"><div class="card" style="background:#FDE8E8;color:#611A15;border:1px solid #F8B4B4"><strong>Backend error</strong><div class="mono" style="white-space:pre-wrap">${enc(String(lastError))}</div></div></div>`
      : `<div id="error" class="error" style="display:none"></div>`;
    app.innerHTML = `${errBox}<div class="divider"></div><div class="link"><a id="openOptions" href="#">Settings (whitelist)</a></div>`;
    bindOptions();
    return;
  }
  const enc = (s) => { const d=document.createElement("div"); d.textContent=String(s ?? ""); return d.innerHTML; };
  const renderFieldDiff = (key, label) => {
    const f = plan.fields?.[key];
    if (!f || !f.selector) return "";
    const selector = enc(f.selector);
    const allowHTML = !!f.html;
    const prev = typeof f.original === 'string' ? f.original : '';
    const curr = typeof f.proposed === 'string' ? f.proposed : '';
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
  app.innerHTML = `
    <div class="topbar">
      <div class="left">
        <h3>${resultEmoji} ${resultHeader}</h3>
      </div>
      <div id="actionsRight" class="right actions icons" style="display:none">
        <button id="saveHtml" class="icon-btn" title="Save reduced HTML" aria-label="Save reduced HTML">
          <span class="icon" data-icon="download"></span>
        </button>
        <button id="revert" class="icon-btn" title="Revert" aria-label="Revert" disabled>
          <span class="icon" data-icon="undo"></span>
        </button>
        <button id="reapply" class="icon-btn" title="Re-apply" aria-label="Re-apply" disabled>
          <span class="icon" data-icon="redo"></span>
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
    <div class="divider"></div>
    <div class="link"><a id="openOptions" href="#">Settings (whitelist)</a></div>
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

  // fetch latest apply summary (if any) for this tab+url
  // also fetch any last error
  let latestSummary = null;
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
        const [{ result }] = await api.scripting.executeScript({ target: { tabId }, func: () => {
          const g = (n) => document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.getAttribute("content") || null;
          const meta = { ogTitle: g("og:title"), ogDescription: g("og:description"), twTitle: g("twitter:title"), twDescription: g("twitter:description") };
          // inline a minimal copy of sanitize logic without stripping attributes extensively
          const doc = document.cloneNode(true);
          const body = doc.body || doc.documentElement;
          ['script','style','noscript','template','iframe','object','embed','svg','canvas','picture','source'].forEach(tag => Array.from(body.querySelectorAll(tag)).forEach(n => n.remove()));
          const walker = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT, null);
          const comments = [];
          while (walker.nextNode()) comments.push(walker.currentNode);
          comments.forEach(c => c.parentNode && c.parentNode.removeChild(c));
          const nodes = body.querySelectorAll('*');
          nodes.forEach((el) => {
            Array.from(el.attributes).forEach(attr => {
              const name = attr.name.toLowerCase();
              if (name.startsWith('on') || name === 'style') el.removeAttribute(attr.name);
              if (name === 'href' && /^\s*javascript:/i.test(attr.value)) el.setAttribute('href', '#');
            });
          });
          let html = (body.outerHTML || '').replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ');
          const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          return { url, meta };
        }});
        const { url: blobUrl } = result || {};
        if (blobUrl) {
          const filename = 'reduced-pdp.html';
          try {
            await api.downloads.download({ url: blobUrl, filename, saveAs: true });
          } catch {
            // Fallback to programmatic link click if downloads API blocked
            const a = document.createElement('a');
            a.href = blobUrl; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
          }
        }
      } catch (err) {
        console.error('[PDP][popup] save html error', err);
      }
    });
  }

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

function bindOptions(){
  const link = document.getElementById("openOptions");
  if (link) link.addEventListener("click", (e)=>{
    e.preventDefault();
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else window.open(chrome.runtime.getURL("options/index.html"));
  });
}

init();
