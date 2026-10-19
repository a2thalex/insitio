import type { Hono } from "hono";
import type { Env } from "../env.js";
import { raw } from "hono/html";
import type { Deps } from "../../deps.js";
import { GitError } from "../../git/run.js";
import { escapeHtml } from "../format.js";
import { highlightLines } from "../highlight.js";
import { locateRef } from "../locate.js";
import { blameUrl, blobUrl, commitUrl } from "../paths.js";
import { notFound } from "../render.js";
import { TimeAgo } from "../views/layout.js";
import { PathBreadcrumbs, RefPicker } from "../views/repo.js";
import { repoPage, withRepo } from "./code.js";

const MAX_BLAME = 1024 * 1024;

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

export function blameRoutes(deps: Deps, app: Hono<Env>) {
  app.get("/:owner/:repo/blame/:rest{.+}", withRepo(deps, "read", async (c, ctx) => {
    const loc = await locateRef(ctx, c.req.param("rest") ?? "");
    if (!loc?.path || (await ctx.git.objectType(loc.sha, loc.path)) !== "blob") return notFound(c);
    const { owner, name } = ctx.repo;
    const blob = await ctx.git.blob(loc.sha, loc.path, MAX_BLAME);
    const blocked = blob.truncated || blob.size > MAX_BLAME || isBinary(blob.content);
    const [branches, tags] = await Promise.all([ctx.git.branches(), ctx.git.tags()]);
    let body;
    if (blocked) {
      body = <div class="blankslate">Can't show blame for this file.</div>;
    } else {
      let hunks;
      try {
        hunks = await ctx.git.blame(loc.sha, loc.path);
      } catch (err) {
        if (err instanceof GitError) return repoPage(c, ctx, "code", `Blame · ${name}`, <div class="blankslate">Can't show blame for this file.</div>);
        throw err;
      }
      const text = blob.content.toString("utf8");
      const highlighted = highlightLines(text, loc.path.split("/").pop()!);
      const lineCount = text.endsWith("\n") && text.length > 0 ? text.slice(0, -1).split("\n").length : text.split("\n").length;
      const useHtml = highlighted.length === lineCount || highlighted.length === hunks.reduce((n, h) => n + h.lines.length, 0);
      body = (
        <div class="blob-wrapper" data-line-select>
          <table class="blob-table blame-table">
            <tbody>
              {hunks.map((hunk) =>
                hunk.lines.map((line, index) => {
                  const n = hunk.startLine + index;
                  const html = useHtml ? highlighted[n - 1] : escapeHtml(line);
                  const permalink = `${deps.config.baseUrl}${blobUrl(owner, name, loc.sha, loc.path)}#L${n}`;
                  return (
                    <tr id={`L${n}`}>
                      {index === 0 && (
                        <td class="blame-meta" rowspan={hunk.lines.length}>
                          <a class="text-mono" href={commitUrl(owner, name, hunk.sha)}>{hunk.shortSha}</a>
                          <span class="ml-2">{ctx.userForEmail(hunk.authorEmail) ?? hunk.authorName}</span>
                          <span class="ml-2 color-fg-muted"><TimeAgo ts={hunk.date} /></span>
                          <div class="color-fg-muted css-truncate">{hunk.summary}</div>
                        </td>
                      )}
                      <td class="blob-num"><a href={`#L${n}`}>{n}</a></td>
                      <td class="blob-code">{html ? raw(html) : ""}</td>
                      <td class="blob-menu">
                        <details class="details-reset details-overlay">
                          <summary class="btn-octicon" aria-label={`Line ${n} options`}>…</summary>
                          <div class="dropdown-menu dropdown-menu-se">
                            <button class="dropdown-item btn-link" type="button" data-copy-text={permalink}>Copy permalink</button>
                            <a class="dropdown-item" href={`${blameUrl(owner, name, loc.sha, loc.path)}#L${n}`}>View git blame</a>
                          </div>
                        </details>
                      </td>
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
      );
    }
    return repoPage(
      c,
      ctx,
      "code",
      `Blame ${loc.path} · ${owner}/${name}`,
      <>
        <div class="d-flex flex-wrap flex-items-center mb-3" style="gap:8px">
          <RefPicker current={loc.ref} branches={branches.map((b) => b.name)} tags={tags} hrefFor={(ref) => blameUrl(owner, name, ref, loc.path)} />
          <PathBreadcrumbs ctx={ctx} gitRef={loc.ref} path={loc.path} last="text" />
          <a class="btn btn-sm ml-auto" href={blobUrl(owner, name, loc.ref, loc.path)}>View file</a>
        </div>
        <div class="Box">{body}</div>
      </>,
    );
  }));
}
