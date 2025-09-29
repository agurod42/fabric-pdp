function applyPatchInPage(plan) {
  const log = () => {};
  const deny = /(?:<script|javascript:|on\w+=|<iframe|<object)/i;
  const PREFIX = "[PDP] ";
  const ensurePrefixed = (s) => (typeof s === "string" && !s.startsWith(PREFIX)) ? (PREFIX + s) : s;
  const t0 = Date.now();
  const steps = Array.isArray(plan.patch) ? plan.patch : [];
  const results = [];
  log("apply start", { steps: steps.length });
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const entry = { index: i, selector: step.selector, op: step.op, status: "pending", note: "" };
    try {
      const node = document.querySelector(step.selector);
      if (!node) { entry.status = "skipped"; entry.note = "selector not found"; log("selector not found", step.selector); results.push(entry); continue; }
      let val = "";
      const allowEmpty = !!step.allowEmpty;
      const noPrefix = !!step.noPrefix;
      if (typeof step.value === "string") {
        val = step.value;
      }
      if (typeof val !== "string") { entry.status = "skipped"; entry.note = "value not string"; log("value not string", step.selector); results.push(entry); continue; }
      if (val.length === 0 && !allowEmpty) { entry.status = "skipped"; entry.note = "empty value"; log("empty value", step.selector); results.push(entry); continue; }
      if (deny.test(val)) { entry.status = "skipped"; entry.note = "value denied by policy"; log("value denied", step.selector); results.push(entry); continue; }
      const outVal = noPrefix ? val : ensurePrefixed(val);
      if (step.op === "setText") {
        entry.prev = String(node.textContent ?? "");
        node.textContent = outVal; entry.status = "applied"; entry.value = outVal; log("setText", step.selector);
      }
      else if (step.op === "setHTML") {
        entry.prev = String(node.innerHTML ?? "");
        node.innerHTML = outVal; entry.status = "applied"; entry.value = outVal; log("setHTML", step.selector);
      }
      else { entry.status = "skipped"; entry.note = "unknown op"; log("unknown op", step.op); }
    } catch(e){ entry.status = "error"; entry.note = String(e); }
    results.push(entry);
  }
  const took_ms = Date.now() - t0;
  const summary = {
    steps_total: steps.length,
    steps_applied: results.filter(r => r.status === "applied").length,
    steps_skipped: results.filter(r => r.status === "skipped").length,
    steps_error: results.filter(r => r.status === "error").length,
    took_ms,
    results,
  };
  log("apply end", summary);
  return summary;
}

// Expose symbol to service worker scope after importScripts
self.applyPatchInPage = applyPatchInPage;


