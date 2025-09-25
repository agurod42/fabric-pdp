
const api = (typeof browser !== 'undefined') ? browser : chrome;
const DEBUG = true;
const log = (...args) => { if (DEBUG) console.debug("[PDP][options]", ...args); };

async function load(){
  log("load whitelist");
  const cfg = await api.storage.local.get(["whitelist"]);
  const wl = cfg?.whitelist || [];
  render(wl);
}
function render(wl){
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
      render(wl2);
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
  render(wl);
});
document.getElementById("clear").addEventListener("click", async ()=>{
  log("clear whitelist");
  await api.storage.local.set({ whitelist: [] });
  render([]);
});
log("options loaded");
load();
