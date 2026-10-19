// Insitio progressive enhancements. Every page works without this script.

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

// Line permalinks: #L10 and #L10-L20. Click selects a line; shift-click extends the range.
function highlightLineRange() {
  const match = /^#L(\d+)(?:-L?(\d+))?$/.exec(location.hash);
  for (const row of document.querySelectorAll(".blob-table tr.highlighted")) row.classList.remove("highlighted");
  if (!match) return;
  let start = Number(match[1]);
  let end = match[2] ? Number(match[2]) : start;
  if (start > end) [start, end] = [end, start];
  for (let line = start; line <= end; line++) document.getElementById(`L${line}`)?.classList.add("highlighted");
}
let lineAnchor = null;
document.addEventListener("click", (event) => {
  const link = event.target.closest(".blob-table .blob-num a");
  if (!link) return;
  const line = Number(link.closest("tr")?.id.slice(1));
  if (!line) return;
  event.preventDefault();
  if (event.shiftKey && lineAnchor) {
    const [lo, hi] = lineAnchor < line ? [lineAnchor, line] : [line, lineAnchor];
    location.hash = `#L${lo}-L${hi}`;
  } else {
    lineAnchor = line;
    location.hash = `#L${line}`;
  }
  highlightLineRange();
});
window.addEventListener("hashchange", highlightLineRange);
highlightLineRange();

// Plain editor: Tab inserts a tab, and the gutter tracks the lines.
function syncGutter(area) {
  const gutter = area.parentElement?.querySelector("[data-editor-gutter]");
  if (!gutter) return;
  const count = Math.max(1, area.value.split("\n").length);
  const next = Array.from({ length: count }, (_, i) => String(i + 1)).join("\n");
  if (gutter.textContent !== next) gutter.textContent = next;
}
document.addEventListener("keydown", (event) => {
  const area = event.target.closest("[data-code-editor]");
  if (!area || event.key !== "Tab") return;
  event.preventDefault();
  const start = area.selectionStart;
  area.setRangeText("\t", start, area.selectionEnd, "end");
  syncGutter(area);
});
document.addEventListener("input", (event) => {
  const area = event.target.closest("[data-code-editor]");
  if (area) syncGutter(area);
});
document.addEventListener("scroll", (event) => {
  const area = event.target;
  if (!(area instanceof HTMLTextAreaElement) || !area.matches("[data-code-editor]")) return;
  const gutter = area.parentElement?.querySelector("[data-editor-gutter]");
  if (gutter) gutter.scrollTop = area.scrollTop;
}, true);

// Folder drops keep the relative path in the uploaded filename.
async function filesFromList(items) {
  const files = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      files.push(new File([file], `${prefix}${file.name}`, { type: file.type }));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const entries = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      for (const child of entries) await walk(child, `${prefix}${entry.name}/`);
    }
  };
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) await walk(entry, "");
    else if (item.getAsFile?.()) files.push(item.getAsFile());
  }
  return files;
}
document.addEventListener("dragover", (event) => {
  if (event.target.closest("[data-drop-zone]")) event.preventDefault();
});
document.addEventListener("drop", async (event) => {
  const zone = event.target.closest("[data-upload-drop]");
  if (!zone) return;
  event.preventDefault();
  const form = zone.closest("form");
  const files = await filesFromList([...event.dataTransfer.items]);
  if (!files.length) return;
  const body = new FormData(form);
  body.delete("files");
  for (const file of files) body.append("files", file, file.name);
  const response = await fetch(form.action, { method: "POST", body, headers: { "x-csrf-token": form.dataset.csrf || "" } });
  if (response.redirected) {
    location.href = response.url;
    return;
  }
  document.open();
  document.write(await response.text());
  document.close();
});

// Confirm destructive buttons.
document.addEventListener("submit", (event) => {
  const message = event.submitter?.dataset.confirm ?? event.target.dataset.confirm;
  if (message && !confirm(message)) event.preventDefault();
});
