import type { Context, Hono } from "hono";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Deps } from "../../deps.js";
import type { Commit, TreeEntry } from "../../git/repo.js";
import { splitRefAndPath } from "../../git/refs.js";
import { GitError, assertSafePath } from "../../git/run.js";
import { repoAnalysis } from "../../services/analyze.js";
import { recordView } from "../../services/parity.js";
import { can, type Access } from "../../services/permissions.js";
import { latestRelease } from "../../services/releases.js";
import { star, unstar } from "../../services/repos.js";
import { listTopics } from "../../services/topics.js";
import type { Env } from "../env.js";
import { formatBytes, formatDate, timeAgo } from "../format.js";
import { highlightLines } from "../highlight.js";
import { renderMarkdown } from "../markdown.js";
import { loginRedirect, safeNext } from "../middleware.js";
import { archiveUrl, blameUrl, blobUrl, commitUrl, commitsUrl, deleteUrl, editUrl, encPath, newFileUrl, rawUrl, repoUrl, treeUrl, uploadUrl } from "../paths.js";
import { loadRepo, type RepoCtx } from "../repoContext.js";
import { notFound, render } from "../render.js";
import { Octicon, TimeAgo, CsrfField } from "../views/layout.js";
import { AboutSidebar } from "../views/about.js";
import { BlobLines } from "../views/editor.js";
import { DiffView } from "../views/diff.js";
import {
  CloneButton, CommitAuthor, FileTable, LatestCommitBar, PathBreadcrumbs, RefPicker, RepoLayout, commitHistoryHref, type RepoTab,
} from "../views/repo.js";

const MAX_BLOB_VIEW = 1024 * 1024;
const MAX_RAW = 50 * 1024 * 1024;
const COMMITS_PER_PAGE = 35;
const README_RE = /^readme(\.(md|markdown|mdown|txt|rst))?$/i;
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml", avif: "image/avif",
};
const RAW_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

type Located = { ref: string; path: string; sha: string };

function ext(path: string) {
  const base = path.split("/").pop()!.toLowerCase();
  return base.includes(".") ? base.split(".").pop()! : "";
}

function isBinary(buf: Buffer) {
  return buf.subarray(0, 8000).includes(0);
}

export function repoPage(c: Context<Env>, ctx: RepoCtx, tab: RepoTab, title: string, body: Child, status: ContentfulStatusCode = 200) {
  return render(
    c,
    title,
    <RepoLayout ctx={ctx} tab={tab} csrf={c.get("csrf")} signedIn={!!c.get("user")}>
      {body}
    </RepoLayout>,
    status,
  );
}

/** Wraps a handler so it only runs once :owner/:repo resolves for this viewer with the needed access. */
export function withRepo(deps: Deps, need: Access, handler: (c: Context<Env>, ctx: RepoCtx) => Promise<Response> | Response) {
  return async (c: Context<Env>) => {
    const ctx = await loadRepo(deps, c, need);
    if (ctx instanceof Response) return ctx;
    return handler(c, ctx);
  };
}

/** Splits "<ref>/<path>" from the URL using the repo's real branch and tag names. */
async function locate(ctx: RepoCtx, rest: string): Promise<Located | null> {
  const split = splitRefAndPath(rest, await ctx.git.refNames());
  if (!split) return null;
  try {
    assertSafePath(split.path);
    const sha = await ctx.git.resolve(split.ref);
    return sha ? { ...split, sha } : null;
  } catch (err) {
    if (err instanceof GitError) return null;
    throw err;
  }
}

/** The branch to show on the repo home: the default branch, or any branch if HEAD dangles. */
async function homeRef(ctx: RepoCtx): Promise<string | null> {
  if (await ctx.git.resolve(ctx.repo.defaultBranch)) return ctx.repo.defaultBranch;
  return (await ctx.git.branches())[0]?.name ?? null;
}

function EmptyRepo({ ctx, cloneUrl, canPush }: { ctx: RepoCtx; cloneUrl: string; canPush: boolean }) {
  const name = ctx.repo.name;
  return (
    <div class="Box empty-repo">
      <div class="Box-header color-bg-accent">
        <h2 class="f4 mb-2">Quick setup</h2>
        <div class="input-group" style="max-width:640px">
          <input class="form-control text-mono" id="clone-url" value={cloneUrl} readonly aria-label="Clone URL" />
          <span class="input-group-button">
            <button class="btn" type="button" data-copy-target="clone-url" aria-label="Copy clone URL"><Octicon name="copy" /></button>
          </span>
        </div>
        <p class="note mt-2">Authenticate with your username and a personal access token from Settings.</p>
      </div>
      {canPush ? (
        <>
          <div class="Box-row">
            <h3 class="f5 mb-2">…or create a new repository on the command line</h3>
            <pre class="p-3 color-bg-subtle rounded-2 f6 text-mono">{`echo "# ${name}" >> README.md
git init
git add README.md
git commit -m "first commit"
git branch -M main
git remote add origin ${cloneUrl}
git push -u origin main`}</pre>
          </div>
          <div class="Box-row">
            <h3 class="f5 mb-2">…or push an existing repository from the command line</h3>
            <pre class="p-3 color-bg-subtle rounded-2 f6 text-mono">{`git remote add origin ${cloneUrl}
git branch -M main
git push -u origin main`}</pre>
          </div>
        </>
      ) : (
        <div class="Box-row color-fg-muted">This repository is empty.</div>
      )}
    </div>
  );
}

function Readme({ html, name }: { html: string; name: string }) {
  return (
    <div class="Box mt-4" id="readme">
      <div class="Box-header py-2 d-flex flex-items-center">
        <Octicon name="book" class="mr-2" />
        <h2 class="Box-title">{name}</h2>
      </div>
      <div class="Box-body markdown-body px-5 py-4">{raw(html)}</div>
    </div>
  );
}

export function codeRoutes(deps: Deps, app: Hono<Env>) {
  const R = "/:owner/:repo";
  const cloneUrl = (ctx: RepoCtx) => `${deps.config.baseUrl}/${ctx.repo.owner}/${ctx.repo.name}.git`;

  async function readmeHtml(ctx: RepoCtx, loc: Located, entries: TreeEntry[]): Promise<{ html: string; name: string } | null> {
    const entry = entries.find((e) => e.type === "blob" && README_RE.test(e.name));
    if (!entry) return null;
    const { content } = await ctx.git.blob(loc.ref, entry.path, MAX_BLOB_VIEW);
    const text = content.toString("utf8");
    const isMd = /\.(md|markdown|mdown)$/i.test(entry.name);
    const html = isMd
      ? renderMarkdown(text, { repo: { owner: ctx.repo.owner, name: ctx.repo.name, ref: loc.ref, dir: loc.path } })
      : `<pre>${text.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!)}</pre>`;
    return { html, name: entry.name };
  }

  async function codeView(c: Context<Env>, ctx: RepoCtx, loc: Located) {
    const { owner, name } = ctx.repo;
    const [entries, branches, tags, latest] = await Promise.all([
      ctx.git.tree(loc.sha, loc.path),
      ctx.git.branches(),
      ctx.git.tags(),
      ctx.git.log(loc.sha, { path: loc.path || undefined, skip: 0, limit: 1 }),
    ]);
    const isRoot = loc.path === "";
    const count = isRoot ? await ctx.git.commitCount(loc.sha) : undefined;
    const readme = await readmeHtml(ctx, loc, entries);
    const analysis = isRoot ? await repoAnalysis(deps, ctx.repo, loc.sha) : null;
    const topics = isRoot ? listTopics(deps.db, ctx.repo.id) : [];
    const release = isRoot ? latestRelease(deps.db, ctx.repo.id) : null;
    const writable = can(ctx.access, "write");
    const archiveKind = branches.some((b) => b.name === loc.ref) ? "heads" : tags.includes(loc.ref) ? "tags" : "sha";
    const archiveRef = archiveKind === "sha" ? loc.sha : loc.ref;
    const title = isRoot ? `${owner}/${name}` : `${name}/${loc.path} at ${loc.ref} · ${owner}/${name}`;
    return repoPage(
      c,
      ctx,
      "code",
      title,
      <div class="d-md-flex">
        <div class="flex-auto min-width-0">
          <div class="d-flex flex-wrap flex-items-center mb-3" style="gap:8px">
            <RefPicker current={loc.ref} branches={branches.map((b) => b.name)} tags={tags} hrefFor={(r) => treeUrl(owner, name, r, loc.path)} />
            {isRoot ? (
              <>
                <a class="Link--primary f6 ml-2 no-wrap" href={repoUrl(owner, name, "branches")}>
                  <Octicon name="git-branch" class="mr-1 color-fg-muted" />
                  <strong>{branches.length}</strong> Branch{branches.length === 1 ? "" : "es"}
                </a>
                <a class="Link--primary f6 ml-2 no-wrap" href={repoUrl(owner, name, "tags")}>
                  <Octicon name="tag" class="mr-1 color-fg-muted" />
                  <strong>{tags.length}</strong> Tag{tags.length === 1 ? "" : "s"}
                </a>
              </>
            ) : (
              <div class="ml-2"><PathBreadcrumbs ctx={ctx} gitRef={loc.ref} path={loc.path} last="text" /></div>
            )}
            <div class="ml-auto d-flex" style="gap:8px">
              <form action={repoUrl(owner, name, "search")} method="get" role="search">
                <input class="form-control input-sm" type="search" name="q" placeholder="Search code" aria-label="Search code in this repository" />
              </form>
              {writable && (
                <>
                  <a class="btn btn-sm" href={newFileUrl(owner, name, loc.ref, loc.path)}><Octicon name="plus" class="mr-1" />Add file</a>
                  <a class="btn btn-sm" href={uploadUrl(owner, name, loc.ref, loc.path)}>Upload files</a>
                </>
              )}
              {isRoot && (
                <CloneButton
                  url={cloneUrl(ctx)}
                  zipHref={archiveUrl(owner, name, archiveKind, archiveRef, "zip")}
                  tarHref={archiveUrl(owner, name, archiveKind, archiveRef, "tar.gz")}
                />
              )}
            </div>
          </div>
          <div class="Box">
            {latest[0] && <LatestCommitBar ctx={ctx} commit={latest[0]} historyHref={commitHistoryHref(ctx, loc.ref, loc.path)} count={count} />}
            <FileTable ctx={ctx} gitRef={loc.ref} path={loc.path} entries={entries} />
          </div>
          {readme && <Readme html={readme.html} name={readme.name} />}
        </div>
        {isRoot && analysis && (
          <AboutSidebar
            ctx={ctx}
            csrf={c.get("csrf")}
            canAdmin={ctx.access === "admin"}
            branchCount={branches.length}
            hasReadme={!!readme}
            analysis={analysis}
            topics={topics}
            latest={release}
            error={c.req.query("error")}
          />
        )}
      </div>,
    );
  }

  app.get(R, withRepo(deps, "read", async (c, ctx) => {
    recordView(deps.db, ctx.repo.id);
    if (await ctx.git.isEmpty()) {
      return repoPage(c, ctx, "code", `${ctx.repo.owner}/${ctx.repo.name}`, <EmptyRepo ctx={ctx} cloneUrl={cloneUrl(ctx)} canPush={can(ctx.access, "write")} />);
    }
    const ref = await homeRef(ctx);
    const sha = ref && (await ctx.git.resolve(ref));
    if (!ref || !sha) return notFound(c);
    return codeView(c, ctx, { ref, path: "", sha });
  }));

  // Redirect using the stored names, never the decoded URL params (which could form "//host").
  app.get(`${R}/tree`, withRepo(deps, "read", (c, ctx) => c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name))));

  app.get(`${R}/tree/:rest{.+}`, withRepo(deps, "read", async (c, ctx) => {
    const loc = await locate(ctx, (c.req.param("rest") ?? ""));
    if (!loc) return notFound(c);
    const type = await ctx.git.objectType(loc.sha, loc.path);
    if (type === "blob") return c.redirect(blobUrl(ctx.repo.owner, ctx.repo.name, loc.ref, loc.path));
    if (type !== "tree") return notFound(c);
    return codeView(c, ctx, loc);
  }));

  app.get(`${R}/blob/:rest{.+}`, withRepo(deps, "read", async (c, ctx) => {
    const loc = await locate(ctx, (c.req.param("rest") ?? ""));
    if (!loc || !loc.path) return notFound(c);
    const type = await ctx.git.objectType(loc.sha, loc.path);
    if (type === "tree") return c.redirect(treeUrl(ctx.repo.owner, ctx.repo.name, loc.ref, loc.path));
    if (type !== "blob") return notFound(c);
    const { owner, name } = ctx.repo;
    const [blob, latest, branches, tags] = await Promise.all([
      ctx.git.blob(loc.sha, loc.path, MAX_BLOB_VIEW),
      ctx.git.log(loc.sha, { path: loc.path, skip: 0, limit: 1 }),
      ctx.git.branches(),
      ctx.git.tags(),
    ]);
    const fileName = loc.path.split("/").pop()!;
    const image = IMAGE_TYPES[ext(loc.path)];
    const binary = isBinary(blob.content);
    const text = binary ? "" : blob.content.toString("utf8");
    const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
    const loc_ = lines.filter((l) => l.trim() !== "").length;
    const isMd = /\.(md|markdown|mdown)$/i.test(fileName);
    const showRendered = isMd && c.req.query("plain") !== "1" && !blob.truncated;
    const raw_ = rawUrl(owner, name, loc.ref, loc.path);

    let body: Child;
    if (image) body = <div class="p-4 text-center"><img src={raw_} alt={fileName} style="max-width:100%" /></div>;
    else if (binary) body = <div class="p-4 text-center color-fg-muted">Binary file not shown. <a href={raw_}>View raw</a></div>;
    else if (blob.truncated) body = <div class="p-4 text-center color-fg-muted">This file is too large to display. <a href={raw_}>View raw</a></div>;
    else if (showRendered) {
      const dir = loc.path.includes("/") ? loc.path.slice(0, loc.path.lastIndexOf("/")) : "";
      body = <div class="markdown-body px-5 py-4">{raw(renderMarkdown(text, { repo: { owner, name, ref: loc.ref, dir } }))}</div>;
    } else {
      const html = highlightLines(text, fileName);
      body = (
        <BlobLines
          lines={html}
          permalink={(line) => `${deps.config.baseUrl}${blobUrl(owner, name, loc.sha, loc.path)}#L${line}`}
          blameHref={(line) => `${blameUrl(owner, name, loc.sha, loc.path)}#L${line}`}
        />
      );
    }

    return repoPage(
      c,
      ctx,
      "code",
      `${name}/${loc.path} at ${loc.ref} · ${owner}/${name}`,
      <>
        <div class="d-flex flex-wrap flex-items-center mb-3" style="gap:8px">
          <RefPicker current={loc.ref} branches={branches.map((b) => b.name)} tags={tags} hrefFor={(r) => blobUrl(owner, name, r, loc.path)} />
          <PathBreadcrumbs ctx={ctx} gitRef={loc.ref} path={loc.path} last="text" />
        </div>
        <div class="Box mb-3">
          {latest[0] && <LatestCommitBar ctx={ctx} commit={latest[0]} historyHref={commitHistoryHref(ctx, loc.ref, loc.path)} />}
        </div>
        <div class="Box">
          <div class="Box-header py-2 d-flex flex-items-center flex-wrap" style="gap:8px">
            {isMd && (
              <div class="BtnGroup mr-2">
                <a class={`btn btn-sm BtnGroup-item ${showRendered ? "selected" : ""}`} href={blobUrl(owner, name, loc.ref, loc.path)} aria-current={showRendered ? "true" : undefined}>Preview</a>
                <a class={`btn btn-sm BtnGroup-item ${!showRendered ? "selected" : ""}`} href={`${blobUrl(owner, name, loc.ref, loc.path)}?plain=1`} aria-current={!showRendered ? "true" : undefined}>Code</a>
              </div>
            )}
            <span class="f6 color-fg-muted flex-auto text-mono">
              {!binary && !image && !blob.truncated && `${lines.length} lines (${loc_} loc) · `}
              {formatBytes(blob.size)}
            </span>
            <div class="BtnGroup">
              <a class="btn btn-sm BtnGroup-item" href={raw_}>Raw</a>
              <a class="btn btn-sm BtnGroup-item" href={`${raw_}?download=1`} aria-label="Download raw file"><Octicon name="download" /></a>
            </div>
            {!binary && !blob.truncated && <a class="btn btn-sm" href={blameUrl(owner, name, loc.ref, loc.path)}>Blame</a>}
            {can(ctx.access, "write") && !binary && !image && !blob.truncated && (
              <a class="btn btn-sm" href={editUrl(owner, name, loc.ref, loc.path)}><Octicon name="pencil" class="mr-1" />Edit</a>
            )}
            {can(ctx.access, "write") && <a class="btn btn-sm" href={deleteUrl(owner, name, loc.ref, loc.path)}>Delete</a>}
            <a class="btn btn-sm" href={commitHistoryHref(ctx, loc.ref, loc.path)}><Octicon name="history" class="mr-1" />History</a>
          </div>
          {body}
        </div>
      </>,
    );
  }));

  app.get(`${R}/raw/:rest{.+}`, withRepo(deps, "read", async (c, ctx) => {
    const loc = await locate(ctx, (c.req.param("rest") ?? ""));
    if (!loc || !loc.path || (await ctx.git.objectType(loc.sha, loc.path)) !== "blob") return notFound(c);
    const { content, truncated } = await ctx.git.blob(loc.sha, loc.path, MAX_RAW);
    if (truncated) return c.text("File too large to serve.", 413);
    const type = IMAGE_TYPES[ext(loc.path)] ?? (isBinary(content) ? "application/octet-stream" : "text/plain; charset=utf-8");
    const headers: Record<string, string> = { "content-type": type, "content-security-policy": RAW_CSP, "cache-control": "private, max-age=60" };
    if (c.req.query("download")) {
      const fileName = loc.path.split("/").pop()!;
      const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
      headers["content-disposition"] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
    }
    return c.body(new Uint8Array(content), 200, headers);
  }));

  // JSON endpoint mirroring GitHub's /tree-commit-info (docs/rea-findings.md §2).
  app.get(`${R}/tree-commit-info/:rest{.+}`, withRepo(deps, "read", async (c, ctx) => {
    const loc = await locate(ctx, (c.req.param("rest") ?? ""));
    if (!loc || (await ctx.git.objectType(loc.sha, loc.path)) !== "tree") return c.json({ error: "not found" }, 404);
    const names = (await ctx.git.tree(loc.sha, loc.path)).map((e) => e.name);
    const found = await ctx.git.lastCommitsFor(loc.sha, loc.path, names);
    const entries: Record<string, unknown> = {};
    for (const [n, commit] of Object.entries(found)) {
      entries[n] = {
        oid: commit.sha,
        shortOid: commit.shortSha,
        subject: commit.subject,
        date: new Date(commit.date * 1000).toISOString(),
        ago: timeAgo(commit.date),
        url: commitUrl(ctx.repo.owner, ctx.repo.name, commit.sha),
      };
    }
    return c.json({ entries }, 200, { "cache-control": "private, max-age=30" });
  }));

  async function commitsPage(c: Context<Env>, ctx: RepoCtx, loc: Located) {
    const { owner, name } = ctx.repo;
    const path = c.req.query("path") ?? "";
    try {
      assertSafePath(path);
    } catch {
      return notFound(c);
    }
    const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
    const [commits, branches, tags] = await Promise.all([
      ctx.git.log(loc.sha, { path: path || undefined, skip: (page - 1) * COMMITS_PER_PAGE, limit: COMMITS_PER_PAGE + 1 }),
      ctx.git.branches(),
      ctx.git.tags(),
    ]);
    const hasMore = commits.length > COMMITS_PER_PAGE;
    const groups = new Map<string, Commit[]>();
    for (const cm of commits.slice(0, COMMITS_PER_PAGE)) {
      const day = formatDate(cm.date);
      groups.set(day, [...(groups.get(day) ?? []), cm]);
    }
    const pageHref = (p: number) => `${commitsUrl(owner, name, loc.ref)}?${new URLSearchParams({ ...(path ? { path } : {}), page: String(p) })}`;
    return repoPage(
      c,
      ctx,
      "code",
      `Commits · ${owner}/${name}`,
      <>
        <div class="d-flex flex-wrap flex-items-center mb-3" style="gap:8px">
          <h1 class="f3 text-normal mr-2">Commits</h1>
          <RefPicker current={loc.ref} branches={branches.map((b) => b.name)} tags={tags} hrefFor={(r) => commitsUrl(owner, name, r, path)} />
          {path && <span class="f6 color-fg-muted">History for <a href={blobUrl(owner, name, loc.ref, path)} class="text-mono">{path}</a></span>}
        </div>
        <div aria-label="Commit history">
          {[...groups].map(([day, list]) => (
            <section class="mb-4">
              <h2 class="f5 text-normal color-fg-muted mb-2 d-flex flex-items-center">
                <Octicon name="git-commit" class="mr-2" />Commits on {day}
              </h2>
              <ul class="Box list-style-none" aria-label={`Commits on ${day}`}>
                {list.map((cm) => (
                  <li class="Box-row d-flex flex-items-center">
                    <div class="flex-auto min-width-0">
                      <h3 class="f5 text-bold">
                        <a class="Link--primary" href={commitUrl(owner, name, cm.sha)}>{cm.subject}</a>
                      </h3>
                      <div class="f6 color-fg-muted mt-1 d-flex flex-items-center">
                        <CommitAuthor ctx={ctx} commit={cm} size={16} />
                        <span class="ml-1">committed <TimeAgo ts={cm.date} /></span>
                      </div>
                    </div>
                    <div class="BtnGroup ml-3 flex-shrink-0">
                      <a class="btn btn-sm BtnGroup-item text-mono" href={commitUrl(owner, name, cm.sha)}>{cm.shortSha}</a>
                      <button class="btn btn-sm BtnGroup-item" type="button" data-copy-text={cm.sha} aria-label={`Copy full SHA for ${cm.shortSha}`}><Octicon name="copy" /></button>
                    </div>
                    <a class="btn btn-sm ml-2 flex-shrink-0" href={treeUrl(owner, name, cm.sha)} aria-label="Browse repository at this point"><Octicon name="code" /></a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {commits.length === 0 && <div class="blankslate Box"><h3 class="blankslate-heading">No commits</h3></div>}
        </div>
        <div class="d-flex flex-justify-center mt-3">
          <div class="BtnGroup">
            {page > 1 ? <a class="btn BtnGroup-item" href={pageHref(page - 1)}>Newer</a> : <button class="btn BtnGroup-item" disabled>Newer</button>}
            {hasMore ? <a class="btn BtnGroup-item" href={pageHref(page + 1)}>Older</a> : <button class="btn BtnGroup-item" disabled>Older</button>}
          </div>
        </div>
      </>,
    );
  }

  app.get(`${R}/commits`, withRepo(deps, "read", async (c, ctx) => {
    const ref = await homeRef(ctx);
    const sha = ref && (await ctx.git.resolve(ref));
    if (!ref || !sha) return notFound(c);
    return commitsPage(c, ctx, { ref, path: "", sha });
  }));

  app.get(`${R}/commits/:rest{.+}`, withRepo(deps, "read", async (c, ctx) => {
    const loc = await locate(ctx, (c.req.param("rest") ?? ""));
    if (!loc) return notFound(c);
    return commitsPage(c, ctx, loc);
  }));

  app.get(`${R}/commit/:sha`, withRepo(deps, "read", async (c, ctx) => {
    const ref = c.req.param("sha") ?? "";
    if (!/^[0-9a-f]{4,40}$/i.test(ref)) return notFound(c);
    let commit;
    try {
      commit = await ctx.git.commit(ref);
    } catch (err) {
      if (err instanceof GitError) return notFound(c);
      throw err;
    }
    const { owner, name } = ctx.repo;
    return repoPage(
      c,
      ctx,
      "code",
      `${commit.subject} · ${owner}/${name}@${commit.shortSha}`,
      <>
        <div class="Box mb-4">
          <div class="Box-body">
            <div class="d-flex flex-items-start">
              <h1 class="f3 text-normal flex-auto">{commit.subject}</h1>
              <a class="btn btn-sm ml-2" href={treeUrl(owner, name, commit.sha)}>Browse files</a>
            </div>
            {commit.body && <pre class="mt-2 f6 color-fg-muted" style="white-space:pre-wrap">{commit.body}</pre>}
          </div>
          <div class="Box-footer d-flex flex-wrap flex-items-center f6 color-fg-muted" style="gap:12px">
            <span class="flex-auto"><CommitAuthor ctx={ctx} commit={commit} /> committed <TimeAgo ts={commit.date} /></span>
            <span>
              {commit.parents.length} parent{commit.parents.length === 1 ? "" : "s"}{" "}
              {commit.parents.map((p) => <a class="text-mono ml-1" href={commitUrl(owner, name, p)}>{p.slice(0, 7)}</a>)}
            </span>
            <span>commit <span class="text-mono color-fg-default">{commit.sha}</span></span>
          </div>
        </div>
        <DiffView files={commit.files} truncated={commit.diffTruncated} viewFileHref={(f) => (f.status === "deleted" ? null : blobUrl(owner, name, commit.sha, f.newPath))} />
      </>,
    );
  }));

  app.get(`${R}/branches`, withRepo(deps, "read", async (c, ctx) => {
    const { owner, name, defaultBranch } = ctx.repo;
    const branches = await ctx.git.branches();
    const tags = await ctx.git.tags();
    const writable = can(ctx.access, "write");
    const deleted = c.req.query("deleted") ?? "";
    const deletedSha = c.req.query("sha") ?? "";
    const canRestore = writable && deleted && /^[0-9a-f]{40}$/i.test(deletedSha);
    return repoPage(
      c,
      ctx,
      "code",
      `Branches · ${owner}/${name}`,
      <>
        <div class="d-flex flex-items-center mb-3">
          <h1 class="f3 text-normal flex-auto">Branches</h1>
        </div>
        {c.req.query("error") && <div class="flash flash-error mb-3" role="alert">{c.req.query("error")}</div>}
        {canRestore && (
          <div class="flash flash-success mb-3" role="status">
            Deleted <strong>{deleted}</strong> ({deletedSha.slice(0, 7)}).
            <form method="post" action={repoUrl(owner, name, "branches", "restore")} class="d-inline ml-2">
              <CsrfField csrf={c.get("csrf")} />
              <input type="hidden" name="name" value={deleted} />
              <input type="hidden" name="sha" value={deletedSha} />
              <button class="btn btn-sm" type="submit">Restore</button>
            </form>
          </div>
        )}
        {writable && (
          <form method="post" action={repoUrl(owner, name, "branches")} class="d-flex flex-wrap mb-3" style="gap:8px">
            <CsrfField csrf={c.get("csrf")} />
            <input class="form-control input-sm" name="name" placeholder="New branch name" aria-label="New branch name" required style="max-width:240px" />
            <select class="form-select input-sm" name="source" aria-label="Source branch, tag or commit">
              {branches.map((b) => <option value={b.name}>{b.name}</option>)}
              {tags.map((tag) => <option value={tag}>{tag}</option>)}
            </select>
            <button class="btn btn-sm" type="submit">Create branch</button>
          </form>
        )}
        <div class="Box">
          {branches.length === 0 && <div class="Box-row color-fg-muted">No branches yet.</div>}
          {branches.map((b) => (
            <div class="Box-row d-flex flex-items-center">
              <Octicon name="git-branch" class="mr-2 color-fg-muted" />
              <a class="branch-name mr-2" href={treeUrl(owner, name, b.name)}>{b.name}</a>
              {b.name === defaultBranch && <span class="Label Label--secondary">default</span>}
              <span class="f6 color-fg-muted ml-3 flex-auto">Updated <TimeAgo ts={b.date} /></span>
              {b.name !== defaultBranch && c.get("user") && (
                <a class="btn btn-sm" href={repoUrl(owner, name, "compare", `${encPath(defaultBranch)}...${encPath(b.name)}`)}>
                  <Octicon name="git-pull-request" class="mr-1" />New pull request
                </a>
              )}
              {writable && b.name !== defaultBranch && (
                <form method="post" action={repoUrl(owner, name, "branches", "delete")} class="ml-2">
                  <CsrfField csrf={c.get("csrf")} />
                  <input type="hidden" name="name" value={b.name} />
                  <button class="btn btn-sm btn-danger" type="submit" data-confirm={`Delete branch ${b.name}?`} aria-label={`Delete branch ${b.name}`}>
                    <Octicon name="trash" />
                  </button>
                </form>
              )}
            </div>
          ))}
        </div>
      </>,
    );
  }));

  app.get(`${R}/search`, withRepo(deps, "read", async (c, ctx) => {
    const { owner, name } = ctx.repo;
    const q = (c.req.query("q") ?? "").trim();
    const ref = await homeRef(ctx);
    const results = q && ref ? await ctx.git.grep(ref, q, 50) : [];
    return repoPage(
      c,
      ctx,
      "code",
      `Search · ${owner}/${name}`,
      <>
        <form action={repoUrl(owner, name, "search")} method="get" class="d-flex mb-3" role="search">
          <input class="form-control flex-auto mr-2" type="search" name="q" value={q} placeholder="Search code" aria-label="Search code" autofocus />
          <button class="btn" type="submit">Search</button>
        </form>
        {q && (
          <p class="color-fg-muted mb-3">
            {results.length} file{results.length === 1 ? "" : "s"} matching <strong>{q}</strong> on <span class="branch-name">{ref}</span>
          </p>
        )}
        {results.map((r) => (
          <div class="Box mb-3">
            <div class="Box-header py-2">
              <a class="text-mono f6 text-bold" href={blobUrl(owner, name, ref!, r.path)}>{r.path}</a>
            </div>
            <table class="blob-table">
              <tbody>
                {r.lines.map((l) => (
                  <tr>
                    <td class="blob-num"><a href={`${blobUrl(owner, name, ref!, r.path)}#L${l.no}`}>{l.no}</a></td>
                    <td class="blob-code">{l.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {q && results.length === 0 && (
          <div class="blankslate Box">
            <Octicon name="search" size={24} />
            <h3 class="blankslate-heading">No code results</h3>
            <p>Searches are case-insensitive and match text exactly.</p>
          </div>
        )}
      </>,
    );
  }));

  const starHandler = (on: boolean) =>
    withRepo(deps, "read", (c, ctx) => {
      const user = c.get("user");
      if (!user) return loginRedirect(c);
      if (on) star(deps.db, user.id, ctx.repo.id);
      else unstar(deps.db, user.id, ctx.repo.id);
      const back = c.req.header("referer");
      let to = repoUrl(ctx.repo.owner, ctx.repo.name);
      if (back) {
        const u = new URL(back, deps.config.baseUrl);
        if (u.origin === new URL(deps.config.baseUrl).origin) to = safeNext(u.pathname + u.search);
      }
      return c.redirect(to);
    });
  app.post(`${R}/star`, starHandler(true));
  app.post(`${R}/unstar`, starHandler(false));
}
