function applyPatchInPage(plan) {
  const log = () => {};
  const deny = /(?:<script|javascript:|on\w+=|<iframe|<object)/i;
  // Success-like styling similar to the extension's green badge palette
  const WRAP_STYLE = "background:#ECFDF5;color:#065F46;border:1px solid #A7F3D0;padding:4px 6px;border-radius:6px;display:inline-block;";
  const wrapHtml = (innerHtml) => `<div data-pdp="1" style="${WRAP_STYLE}">${innerHtml}</div>`;
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
      const noPrefix = !!step.noPrefix; // Back-compat: if set, do not wrap
      if (typeof step.value === "string") {
        val = step.value;
      }
      if (typeof val !== "string") { entry.status = "skipped"; entry.note = "value not string"; log("value not string", step.selector); results.push(entry); continue; }
      if (val.length === 0 && !allowEmpty) { entry.status = "skipped"; entry.note = "empty value"; log("empty value", step.selector); results.push(entry); continue; }
      if (deny.test(val)) { entry.status = "skipped"; entry.note = "value denied by policy"; log("value denied", step.selector); results.push(entry); continue; }
      const shouldWrap = !noPrefix;
      if (step.op === "setText") {
        entry.prev = String(node.textContent ?? "");
        if (shouldWrap) {
          try {
            while (node.firstChild) node.removeChild(node.firstChild);
            const wrapper = document.createElement('div');
            wrapper.setAttribute('data-pdp', '1');
            wrapper.setAttribute('role', 'note');
            wrapper.style.cssText = WRAP_STYLE;
            wrapper.textContent = val;
            node.appendChild(wrapper);
            entry.status = "applied"; entry.value = val; log("setText(wrap)", step.selector);
          } catch (e) {
            entry.status = "error"; entry.note = String(e);
          }
        } else {
          node.textContent = val; entry.status = "applied"; entry.value = val; log("setText", step.selector);
        }
      }
      else if (step.op === "setHTML") {
        entry.prev = String(node.innerHTML ?? "");
        try {
          const htmlToSet = shouldWrap ? wrapHtml(val) : val;
          if (window.trustedTypes && window.trustedTypes.createPolicy) {
            const policy = window.trustedTypes.createPolicy('pdp-allow', { createHTML: (s) => s });
            node.innerHTML = policy.createHTML(htmlToSet);
          } else {
            node.innerHTML = htmlToSet;
          }
          entry.status = "applied"; entry.value = htmlToSet; log(shouldWrap ? "setHTML(wrap)" : "setHTML", step.selector);
        } catch(e) {
          entry.status = "error"; entry.note = String(e);
        }
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


