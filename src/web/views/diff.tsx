import type { DiffFile } from "../../git/diff.js";
import { highlightCode, languageFor } from "../highlight.js";
import { raw } from "hono/html";
import { Octicon } from "./layout.js";

const MAX_LINES_PER_FILE = 3000;
const MAX_FILES = 300;

export function Diffstat({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  const blocks = 5;
  const add = total === 0 ? 0 : Math.round((additions / total) * blocks);
  const del = total === 0 ? 0 : Math.min(blocks - add, Math.round((deletions / total) * blocks));
  return (
    <span class="no-wrap" aria-label={`${additions} additions and ${deletions} deletions`}>
      <span class="color-fg-success text-bold">+{additions}</span> <span class="color-fg-danger text-bold">−{deletions}</span>
      <span class="ml-1">
        {Array.from({ length: blocks }, (_, i) => (
          <span class={`diffstat-block ${i < add ? "diffstat-add" : i < add + del ? "diffstat-del" : "diffstat-neutral"}`}></span>
        ))}
      </span>
    </span>
  );
}

function fileLabel(f: DiffFile) {
  if (f.status === "renamed" && f.oldPath !== f.newPath) return `${f.oldPath} → ${f.newPath}`;
  return f.status === "deleted" ? f.oldPath : f.newPath;
}

/** Summary line plus one table per file, with old/new line number columns and hunk headers. */
export function DiffView({ files, truncated, viewFileHref }: { files: DiffFile[]; truncated?: boolean; viewFileHref?: (f: DiffFile) => string | null }) {
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const shown = files.slice(0, MAX_FILES);
  return (
    <div>
      <div class="d-flex flex-items-center mb-3 f6 color-fg-muted">
        <span class="flex-auto">
          Showing <strong>{files.length} changed file{files.length === 1 ? "" : "s"}</strong> with{" "}
          <strong>{additions} addition{additions === 1 ? "" : "s"}</strong> and{" "}
          <strong>{deletions} deletion{deletions === 1 ? "" : "s"}</strong>.
        </span>
      </div>
      {(truncated || files.length > MAX_FILES) && (
        <div class="flash flash-warn mb-3">This diff is too large to show in full; some files are not displayed.</div>
      )}
      {shown.map((f, i) => {
        const lineCount = f.hunks.reduce((n, h) => n + h.lines.length, 0);
        const lang = languageFor(f.newPath || f.oldPath);
        const href = viewFileHref?.(f) ?? null;
        return (
          <div class="Box mb-3" id={`diff-${i}`}>
            <div class="Box-header py-2 px-3 d-flex flex-items-center file-header">
              <span class="f6 mr-3"><Diffstat additions={f.additions} deletions={f.deletions} /></span>
              <span class="text-mono f6 text-bold flex-auto css-truncate css-truncate-target" style="max-width:none" title={fileLabel(f)}>{fileLabel(f)}</span>
              {f.status === "added" && <span class="Label Label--success ml-2">added</span>}
              {f.status === "deleted" && <span class="Label Label--danger ml-2">deleted</span>}
              {href && <a class="btn btn-sm ml-2" href={href}>View file</a>}
            </div>
            {f.binary ? (
              <div class="p-3 color-fg-muted text-center">Binary file not shown.</div>
            ) : f.hunks.length === 0 ? (
              <div class="p-3 color-fg-muted text-center">{f.status === "renamed" ? "File renamed without changes." : "No content changes."}</div>
            ) : lineCount > MAX_LINES_PER_FILE ? (
              <div class="p-3 color-fg-muted text-center">Large diff ({lineCount.toLocaleString("en-US")} lines) not rendered.</div>
            ) : (
              <div class="blob-wrapper">
                <table class="diff-table" aria-label={`Diff for ${fileLabel(f)}`}>
                  <tbody>
                    {f.hunks.map((h) => (
                      <>
                        <tr class="hunk">
                          <td class="blob-num" colspan={2}><Octicon name="unfold" size={12} /></td>
                          <td class="blob-code-hunk text-mono">{h.header}</td>
                        </tr>
                        {h.lines.map((l) => (
                          <tr class={l.type}>
                            <td class="blob-num">{l.oldNo ?? ""}</td>
                            <td class="blob-num">{l.newNo ?? ""}</td>
                            <td class="blob-code">{raw(highlightCode(l.text, lang))}</td>
                          </tr>
                        ))}
                      </>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
