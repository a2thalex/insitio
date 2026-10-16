// GitFkd progressive enhancements. Every page works without this script.

// Copy buttons: data-copy-target="<input id>" or data-copy-text="<text>".
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-target], [data-copy-text]");
  if (!button) return;
  const target = button.dataset.copyTarget && document.getElementById(button.dataset.copyTarget);
  const text = target ? target.value : button.dataset.copyText;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    if (target) {
      target.select();
      document.execCommand("copy");
    }
  }
  button.classList.add("copy-ok");
  const label = button.getAttribute("aria-label");
  button.setAttribute("aria-label", "Copied!");
  setTimeout(() => {
    button.classList.remove("copy-ok");
    if (label) button.setAttribute("aria-label", label);
  }, 1500);
});

// Close an open dropdown when another one opens.
document.addEventListener("toggle", (event) => {
  const d = event.target;
  if (!(d instanceof HTMLDetailsElement) || !d.open || !d.classList.contains("details-overlay")) return;
  for (const other of document.querySelectorAll("details.details-overlay[open]")) if (other !== d) other.open = false;
  d.querySelector("[data-ref-filter]")?.focus();
}, true);

// Branch picker filter.
document.addEventListener("input", (event) => {
  const input = event.target.closest("[data-ref-filter]");
  if (!input) return;
  const q = input.value.trim().toLowerCase();
  for (const item of input.closest(".SelectMenu, .ref-menu").querySelectorAll("[data-ref-name]")) {
    item.hidden = q !== "" && !item.dataset.refName.toLowerCase().includes(q);
  }
});

// Per-entry last commit for file listings, fetched after render the way GitHub's
// code view does (see docs/rea-findings.md §2).
async function loadTreeCommitInfo(table) {
  try {
    const res = await fetch(table.dataset.treeCommitInfo, { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const { entries } = await res.json();
    for (const row of table.querySelectorAll("[data-entry]")) {
      const info = entries[row.dataset.entry];
      const msg = row.querySelector(".col-msg");
      const age = row.querySelector(".col-age");
      if (!info) {
        msg.textContent = "";
        age.textContent = "";
        continue;
      }
      const link = document.createElement("a");
      link.href = info.url;
      link.textContent = info.subject;
      link.title = info.subject;
      msg.replaceChildren(link);
      const time = document.createElement("time");
      time.dateTime = info.date;
      time.title = new Date(info.date).toUTCString();
      time.textContent = info.ago;
      age.replaceChildren(time);
    }
  } catch {
    // leave placeholders in place
  }
}
for (const table of document.querySelectorAll("[data-tree-commit-info]")) loadTreeCommitInfo(table);

// Confirm destructive buttons.
document.addEventListener("submit", (event) => {
  const message = event.submitter?.dataset.confirm ?? event.target.dataset.confirm;
  if (message && !confirm(message)) event.preventDefault();
});
