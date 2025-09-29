
// options/index.js — Settings page logic for strategy and whitelist management
const api = (typeof browser !== 'undefined') ? browser : chrome;
const DEBUG = true;
const log = (...args) => { if (DEBUG) console.debug("[PDP][options]", ...args); };

/** Available strategy choices displayed in selects. */
const STRATEGIES = [
  { id: "heuristicsStrategy", label: "Heuristics (very fast, local)" },
  { id: "llmStrategy", label: "Backend LLM (fallback)" },
  { id: "webllmStrategy", label: "WebLLM (local, WebGPU)" },
];

/** Fill a <select> with strategy options. */
function fillStrategySelect(selectEl){
  if (!selectEl) return;
  selectEl.innerHTML = STRATEGIES.map(s => `<option value="${s.id}">${s.label}</option>`).join("");
}

/** Brief toast feedback message. */
function showToast(message){
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = String(message || "Saved");
  el.style.display = "block";
  requestAnimationFrame(()=>{
    el.classList.add("show");
    setTimeout(()=>{
      el.classList.remove("show");
      setTimeout(()=>{ el.style.display = "none"; }, 200);
    }, 1600);
  });
}

/** Load settings from storage and render UI. */
async function load(){
  log("load settings");
  const cfg = await api.storage.local.get(["whitelist","strategySettings"]);
  const wl = cfg?.whitelist || [];
  const s = cfg?.strategySettings || { global: "webllmStrategy", perDomain: [] };
  renderWhitelist(wl);
  renderStrategies(s);
}

/** Render the whitelist list with remove buttons. */
function renderWhitelist(wl){
  const list = document.getElementById("list");
  list.innerHTML = "";
  wl.forEach((h, idx)=>{
    const li = document.createElement("li");
    li.innerHTML = `<code>${h}</code> <button data-i="${idx}">Remove</button>`;
    list.appendChild(li);
  });
  list.querySelectorAll("button[data-i]").forEach(btn => {
    btn.addEventListener("click", async (e)=>{
      const i = parseInt(e.target.getAttribute("data-i"), 10);
      log("remove host", { index: i });
      const cfg = await api.storage.local.get(["whitelist"]);
      const wl2 = cfg?.whitelist || [];
      wl2.splice(i,1);
      await api.storage.local.set({ whitelist: wl2 });
      renderWhitelist(wl2);
    });
  });
}

/** Render global strategy select and per-domain overrides. */
function renderStrategies(s){
  fillStrategySelect(document.getElementById("globalStrategy"));
  fillStrategySelect(document.getElementById("domainStrategy"));
  const g = document.getElementById("globalStrategy");
  if (g) g.value = s.global || "webllmStrategy";

  const list = document.getElementById("overrides");
  list.innerHTML = "";
  (Array.isArray(s.perDomain) ? s.perDomain : []).forEach((o, idx)=>{
    const st = STRATEGIES.find(x => x.id === o.strategyId);
    const label = st ? st.label : o.strategyId;
    const li = document.createElement("li");
    li.innerHTML = `<code>${o.pattern}</code> → <code>${label}</code> <button data-i="${idx}">Remove</button>`;
    list.appendChild(li);
  });
  list.querySelectorAll("button[data-i]").forEach(btn => {
    btn.addEventListener("click", async (e)=>{
      const i = parseInt(e.target.getAttribute("data-i"), 10);
      const cfg = await api.storage.local.get(["strategySettings"]);
      const s = cfg?.strategySettings || { global: "llmStrategy", perDomain: [] };
      const arr = Array.isArray(s.perDomain) ? s.perDomain : [];
      arr.splice(i,1);
      await api.storage.local.set({ strategySettings: { ...s, perDomain: arr } });
      renderStrategies({ ...s, perDomain: arr });
    });
  });
}

document.getElementById("add").addEventListener("click", async ()=>{
  const host = document.getElementById("host").value.trim();
  if (!host) return;
  log("add host", { host });
  const cfg = await api.storage.local.get(["whitelist"]);
  const wl = cfg?.whitelist || [];
  if (!wl.includes(host)) wl.push(host);
  await api.storage.local.set({ whitelist: wl });
  document.getElementById("host").value = "";
  renderWhitelist(wl);
  showToast("Whitelist updated");
});
document.getElementById("clear").addEventListener("click", async ()=>{
  log("clear whitelist");
  await api.storage.local.set({ whitelist: [] });
  renderWhitelist([]);
  showToast("Whitelist cleared");
});

document.getElementById("saveGlobal").addEventListener("click", async ()=>{
  const select = document.getElementById("globalStrategy");
  const id = select ? select.value : "llmStrategy";
  const cfg = await api.storage.local.get(["strategySettings"]);
  const s = cfg?.strategySettings || { global: "webllmStrategy", perDomain: [] };
  await api.storage.local.set({ strategySettings: { ...s, global: id } });
  renderStrategies({ ...s, global: id });
  showToast("Global strategy saved");
});

document.getElementById("addOverride").addEventListener("click", async ()=>{
  const pattern = document.getElementById("pattern").value.trim();
  const strategyId = document.getElementById("domainStrategy").value;
  if (!pattern) return;
  const cfg = await api.storage.local.get(["strategySettings"]);
  const s = cfg?.strategySettings || { global: "webllmStrategy", perDomain: [] };
  const list = Array.isArray(s.perDomain) ? s.perDomain : [];
  list.push({ pattern, strategyId });
  await api.storage.local.set({ strategySettings: { ...s, perDomain: list } });
  document.getElementById("pattern").value = "";
  renderStrategies({ ...s, perDomain: list });
  showToast("Override added");
});

document.getElementById("clearOverrides").addEventListener("click", async ()=>{
  const cfg = await api.storage.local.get(["strategySettings"]);
  const s = cfg?.strategySettings || { global: "webllmStrategy", perDomain: [] };
  await api.storage.local.set({ strategySettings: { ...s, perDomain: [] } });
  renderStrategies({ ...s, perDomain: [] });
  showToast("Overrides cleared");
});

log("options loaded");
load();
