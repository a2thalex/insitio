import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import { CsrfField, Octicon } from "./layout.js";

/** Highlighted file with line numbers, a range target, and a per-line permalink menu. */
export function BlobLines({ lines, permalink, blameHref }: { lines: string[]; permalink: (line: number) => string; blameHref: (line: number) => string }) {
  return (
    <div class="blob-wrapper py-2" data-line-select>
      <table class="blob-table" aria-label="File contents">
        <tbody>
          {lines.map((html, index) => {
            const line = index + 1;
            return (
              <tr id={`L${line}`}>
                <td class="blob-num"><a href={`#L${line}`}>{line}</a></td>
                <td class="blob-code">{raw(html)}</td>
                <td class="blob-menu">
                  <details class="details-reset details-overlay">
                    <summary class="btn-octicon" aria-label={`Line ${line} options`}>…</summary>
                    <div class="dropdown-menu dropdown-menu-se">
                      <button class="dropdown-item btn-link" type="button" data-copy-text={permalink(line)}>Copy permalink</button>
                      <a class="dropdown-item" href={blameHref(line)}>View git blame</a>
                    </div>
                  </details>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CodeEditor({ value }: { value: string }) {
  const lines = value.length === 0 ? 1 : value.split("\n").length;
  return (
    <div class="code-editor">
      <pre class="code-editor-gutter" data-editor-gutter aria-hidden="true">{Array.from({ length: lines }, (_, i) => String(i + 1)).join("\n")}</pre>
      <textarea class="form-control code-editor-text" name="content" data-code-editor spellcheck={false} aria-label="File contents">{value}</textarea>
    </div>
  );
}

export function CommitForm({
  action,
  csrf,
  branch,
  baseSha,
  message,
  description,
  error,
  extra,
  children,
}: {
  action: string;
  csrf: string;
  branch: string;
  baseSha: string;
  message: string;
  description: string;
  error?: string;
  extra?: Child;
  children?: Child;
}) {
  return (
    <form method="post" action={action} class="commit-form">
      <CsrfField csrf={csrf} />
      <input type="hidden" name="base_sha" value={baseSha} />
      {error && <div class="flash flash-error mb-3" role="alert">{error}</div>}
      {children}
      <div class="Box mt-3">
        <div class="Box-header"><h2 class="Box-title f5">Commit changes</h2></div>
        <div class="Box-body">
          <label class="d-block mb-2" for="commit-message">Commit message</label>
          <input class="form-control mb-2" id="commit-message" name="message" value={message} required />
          <label class="d-block mb-2" for="commit-body">Extended description</label>
          <textarea class="form-control mb-3" id="commit-body" name="description" rows={4}>{description}</textarea>
          <div class="form-checkbox mb-2">
            <label>
              <input type="radio" name="commit_to" value="direct" checked /> Commit directly to the <strong>{branch}</strong> branch
            </label>
          </div>
          <div class="form-checkbox mb-2">
            <label>
              <input type="radio" name="commit_to" value="branch" /> Create a new branch for this commit and start a pull request
            </label>
          </div>
          <input class="form-control input-sm mb-3" name="new_branch" placeholder="new-branch-name" aria-label="New branch name" />
          {extra}
          <button class="btn btn-primary" type="submit">Commit changes</button>
        </div>
      </div>
    </form>
  );
}

export function UploadForm({ action, csrf, branch, baseSha, error }: { action: string; csrf: string; branch: string; baseSha: string; error?: string }) {
  const withToken = `${action}${action.includes("?") ? "&" : "?"}_csrf=${encodeURIComponent(csrf)}`;
  return (
    <form method="post" action={withToken} encType="multipart/form-data" data-upload-drop data-csrf={csrf}>
      <input type="hidden" name="base_sha" value={baseSha} />
      {error && <div class="flash flash-error mb-3" role="alert">{error}</div>}
      <div class="Box mb-3" data-drop-zone>
        <div class="Box-body text-center py-5">
          <Octicon name="upload" size={24} />
          <p class="f4 mt-2">Drop files or a folder here, or choose them.</p>
          <p class="color-fg-muted f6">25 MB per file, 100 files, 100 MB in total. Larger files need git or nsit.</p>
          <div class="d-flex flex-justify-center mt-3" style="gap:8px">
            <label class="btn">
              Choose files <input class="sr-only" type="file" name="files" multiple />
            </label>
            <label class="btn">
              Choose a folder <input class="sr-only" type="file" name="files" multiple webkitdirectory="" directory="" />
            </label>
          </div>
        </div>
      </div>
      <CommitFields csrf={csrf} branch={branch} />
    </form>
  );
}

function CommitFields({ csrf, branch }: { csrf: string; branch: string }) {
  return (
    <div class="Box">
      <div class="Box-body">
        <input type="hidden" name="_csrf" value={csrf} />
        <label class="d-block mb-2" for="upload-message">Commit message</label>
        <input class="form-control mb-2" id="upload-message" name="message" placeholder="Add files via upload" />
        <label class="d-block mb-2" for="upload-body">Extended description</label>
        <textarea class="form-control mb-3" id="upload-body" name="description" rows={3}></textarea>
        <div class="form-checkbox mb-2">
          <label><input type="radio" name="commit_to" value="direct" checked /> Commit directly to the <strong>{branch}</strong> branch</label>
        </div>
        <div class="form-checkbox mb-2">
          <label><input type="radio" name="commit_to" value="branch" /> Create a new branch for this commit and start a pull request</label>
        </div>
        <input class="form-control input-sm mb-3" name="new_branch" placeholder="new-branch-name" aria-label="New branch name" />
        <button class="btn btn-primary" type="submit">Commit changes</button>
      </div>
    </div>
  );
}
