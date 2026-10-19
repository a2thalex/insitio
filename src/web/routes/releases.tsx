import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { Context, Hono } from "hono";
import { raw } from "hono/html";
import type { Deps } from "../../deps.js";
import { can } from "../../services/permissions.js";
import {
  attachAsset,
  createRelease,
  deleteAsset,
  deleteRelease,
  getAssetByName,
  getReleaseByTag,
  latestRelease,
  listAssets,
  listReleases,
  partialAssetPath,
  recordDownload,
  releaseAssetPath,
  releaseDir,
  RELEASE_ASSET_MAX_BYTES,
  RELEASES_PER_PAGE,
  updateRelease,
  type Release,
  type ReleaseInput,
} from "../../services/releases.js";
import { ValidationError } from "../../services/errors.js";
import type { Env } from "../env.js";
import { attachmentDisposition } from "../download.js";
import { formatBytes, formatDate } from "../format.js";
import { renderMarkdown } from "../markdown.js";
import { field, form } from "../middleware.js";
import { archiveUrl, encPath, repoUrl } from "../paths.js";
import type { RepoCtx } from "../repoContext.js";
import { notFound } from "../render.js";
import { CsrfField, Octicon, Pagination, TimeAgo } from "../views/layout.js";
import { repoPage, withRepo } from "./code.js";

function releaseInput(f: Record<string, string | string[]>, fallbackTarget: string): ReleaseInput {
  return {
    tag: field(f, "tag"),
    target: field(f, "target") || fallbackTarget,
    title: field(f, "title"),
    body: field(f, "body"),
    draft: field(f, "draft") === "1",
    prerelease: field(f, "prerelease") === "1",
    setLatest: field(f, "set_latest") === "1",
  };
}

export function releaseRoutes(deps: Deps, app: Hono<Env>) {
  const R = "/:owner/:repo";

  function visible(ctx: RepoCtx, release: Release): boolean {
    return !release.draft || can(ctx.access, "write");
  }

  async function targets(ctx: RepoCtx): Promise<string[]> {
    const [branches, tags] = await Promise.all([ctx.git.branches(), ctx.git.tags()]);
    return [...branches.map((b) => b.name), ...tags];
  }

  function formPage(c: Context<Env>, ctx: RepoCtx, opts: { release?: Release; error?: string; values: ReleaseInput; choices: string[] }) {
    const { owner, name } = ctx.repo;
    const editing = Boolean(opts.release);
    const action = editing
      ? repoUrl(owner, name, "releases", "edit", encPath(opts.release!.tag))
      : repoUrl(owner, name, "releases", "new");
    const v = opts.values;
    return repoPage(
      c,
      ctx,
      "code",
      `${editing ? "Edit" : "New"} release · ${owner}/${name}`,
      <>
        <h1 class="f3 text-normal mb-3">{editing ? "Edit release" : "New release"}</h1>
        {opts.error && <div class="flash flash-error mb-3" role="alert">{opts.error}</div>}
        <form method="post" action={action} class="Box">
          <div class="Box-body">
            <CsrfField csrf={c.get("csrf")} />
            <label class="d-block mb-2" for="rel-tag">Tag</label>
            <input class="form-control mb-2" id="rel-tag" name="tag" value={v.tag} required />
            <label class="d-block mb-2" for="rel-target">Target</label>
            <input class="form-control mb-2" id="rel-target" name="target" value={v.target} list="rel-targets" />
            <datalist id="rel-targets">{opts.choices.map((choice) => <option value={choice} />)}</datalist>
            <p class="note mb-3">A new tag is created at this branch, tag or commit when you publish.</p>
            <label class="d-block mb-2" for="rel-title">Release title</label>
            <input class="form-control mb-2" id="rel-title" name="title" value={v.title} required />
            <label class="d-block mb-2" for="rel-body">Release notes</label>
            <textarea class="form-control mb-3" id="rel-body" name="body" rows={8}>{v.body}</textarea>
            <div class="form-checkbox mb-2"><label><input type="checkbox" name="draft" value="1" checked={v.draft} /> Save as draft</label></div>
            <div class="form-checkbox mb-2"><label><input type="checkbox" name="prerelease" value="1" checked={v.prerelease} /> This is a pre-release</label></div>
            <div class="form-checkbox mb-3"><label><input type="checkbox" name="set_latest" value="1" checked={v.setLatest} /> Set as the latest release</label></div>
            <button class="btn btn-primary" type="submit">{v.draft ? "Save draft" : "Publish release"}</button>
          </div>
        </form>
      </>,
      opts.error ? 400 : 200,
    );
  }

  app.get(`${R}/releases/new`, withRepo(deps, "write", async (c, ctx) => {
    return formPage(c, ctx, {
      choices: await targets(ctx),
      values: { tag: "", target: ctx.repo.defaultBranch, title: "", body: "", draft: false, prerelease: false, setLatest: true },
    });
  }));

  app.post(`${R}/releases/new`, withRepo(deps, "write", async (c, ctx) => {
    const f = await form(c);
    const input = releaseInput(f, ctx.repo.defaultBranch);
    try {
      const release = await createRelease(deps, ctx.repo, c.get("user")!, input);
      return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "releases", "tag", encPath(release.tag)));
    } catch (err) {
      if (err instanceof ValidationError) return formPage(c, ctx, { error: err.message, values: input, choices: await targets(ctx) });
      throw err;
    }
  }));

  app.get(`${R}/releases/latest/download/:asset`, withRepo(deps, "read", async (c, ctx) => {
    const release = latestRelease(deps.db, ctx.repo.id);
    if (!release) return notFound(c);
    return sendAsset(c, ctx, release, c.req.param("asset") ?? "");
  }));

  app.get(`${R}/releases/latest`, withRepo(deps, "read", async (c, ctx) => {
    const release = latestRelease(deps.db, ctx.repo.id);
    if (!release) return notFound(c, "The latest release");
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "releases", "tag", encPath(release.tag)));
  }));

  app.get(`${R}/releases/download/:rest{.+}`, withRepo(deps, "read", async (c, ctx) => {
    const rest = c.req.param("rest") ?? "";
    const cut = rest.lastIndexOf("/");
    if (cut <= 0) return notFound(c);
    const release = getReleaseByTag(deps.db, ctx.repo.id, rest.slice(0, cut));
    if (!release || !visible(ctx, release)) return notFound(c);
    return sendAsset(c, ctx, release, rest.slice(cut + 1));
  }));

  app.get(`${R}/releases/tag/:rest{.+}`, withRepo(deps, "read", async (c, ctx) => releaseView(c, ctx, c.req.param("rest") ?? "")));

  app.get(`${R}/releases/edit/:rest{.+}`, withRepo(deps, "write", async (c, ctx) => {
    const release = getReleaseByTag(deps.db, ctx.repo.id, c.req.param("rest") ?? "");
    if (!release) return notFound(c);
    return formPage(c, ctx, {
      release,
      choices: await targets(ctx),
      values: { tag: release.tag, target: release.target || ctx.repo.defaultBranch, title: release.title, body: release.body, draft: release.draft, prerelease: release.prerelease, setLatest: release.makeLatest !== "false" },
    });
  }));

  app.post(`${R}/releases/edit/:rest{.+}`, withRepo(deps, "write", async (c, ctx) => {
    const release = getReleaseByTag(deps.db, ctx.repo.id, c.req.param("rest") ?? "");
    if (!release) return notFound(c);
    const input = releaseInput(await form(c), release.target || ctx.repo.defaultBranch);
    try {
      const saved = await updateRelease(deps, ctx.repo, c.get("user")!, release, input);
      return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "releases", "tag", encPath(saved.tag)));
    } catch (err) {
      if (err instanceof ValidationError) return formPage(c, ctx, { release, error: err.message, values: input, choices: await targets(ctx) });
      throw err;
    }
  }));

  app.post(`${R}/releases/delete`, withRepo(deps, "write", async (c, ctx) => {
    const release = getReleaseByTag(deps.db, ctx.repo.id, field(await form(c), "tag"));
    if (!release) return notFound(c);
    await deleteRelease(deps, ctx.repo, release);
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "releases"));
  }));

  app.post(`${R}/releases/:id/assets`, withRepo(deps, "write", async (c, ctx) => {
    const release = await ownedRelease(ctx, c.req.param("id") ?? "");
    if (!release) return notFound(c);
    const dir = releaseDir(deps.config.dataDir, ctx.repo.id, release.id);
    await mkdir(dir, { recursive: true });
    const temp = partialAssetPath(deps.config.dataDir, ctx.repo.id, release.id);
    try {
      if (!c.req.raw.body) throw new ValidationError("Choose a file to attach.");
      const { readMultipart } = await import("../multipart.js");
      const parsed = await readMultipart(c.req.raw.body, c.req.header("content-type") ?? "", {
        dir,
        maxFiles: 1,
        maxFileBytes: RELEASE_ASSET_MAX_BYTES,
        maxTotalBytes: RELEASE_ASSET_MAX_BYTES,
      });
      const file = parsed.files[0];
      if (!file) throw new ValidationError("Choose a file to attach.");
      const name = c.req.query("name") || file.filename;
      await attachAsset(deps, ctx.repo, release, file.tempPath, name, file.size, file.contentType);
      return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "releases", "tag", encPath(release.tag)));
    } catch (err) {
      const { rm } = await import("node:fs/promises");
      await rm(temp, { force: true });
      if (err instanceof ValidationError) {
        return repoPage(c, ctx, "code", "Release", <div class="flash flash-error" role="alert">{err.message}</div>, 400);
      }
      throw err;
    }
  }));

  app.post(`${R}/releases/:id/assets/:assetId/delete`, withRepo(deps, "write", async (c, ctx) => {
    const release = await ownedRelease(ctx, c.req.param("id") ?? "");
    if (!release) return notFound(c);
    const asset = listAssets(deps.db, release.id).find((item) => String(item.id) === c.req.param("assetId"));
    if (!asset) return notFound(c);
    await deleteAsset(deps, ctx.repo, asset);
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "releases", "tag", encPath(release.tag)));
  }));

  app.get(`${R}/releases`, withRepo(deps, "read", async (c, ctx) => {
    const { owner, name } = ctx.repo;
    const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
    const list = listReleases(deps.db, ctx.repo.id, { includeDrafts: can(ctx.access, "write"), page });
    return repoPage(
      c,
      ctx,
      "code",
      `Releases · ${owner}/${name}`,
      <>
        <div class="d-flex flex-items-center mb-3">
          <h1 class="f3 text-normal flex-auto">Releases</h1>
          {can(ctx.access, "write") && <a class="btn btn-primary" href={repoUrl(owner, name, "releases", "new")}>New release</a>}
        </div>
        <div class="Box">
          {list.items.length === 0 && <div class="Box-row color-fg-muted">No releases yet.</div>}
          {list.items.map((release) => (
            <div class="Box-row d-flex flex-items-center">
              <Octicon name="tag" class="mr-2 color-fg-muted" />
              <a class="flex-auto" href={repoUrl(owner, name, "releases", "tag", encPath(release.tag))}>
                <strong>{release.title}</strong> <span class="text-mono color-fg-muted ml-2">{release.tag}</span>
              </a>
              {release.draft && <span class="Label mr-2">Draft</span>}
              {release.prerelease && <span class="Label Label--attention mr-2">Pre-release</span>}
              <span class="f6 color-fg-muted"><TimeAgo ts={release.publishedAt ?? release.createdAt} /></span>
            </div>
          ))}
        </div>
        <Pagination page={page} total={list.total} perPage={RELEASES_PER_PAGE} href={(p) => `${repoUrl(owner, name, "releases")}?page=${p}`} />
      </>,
    );
  }));

  async function ownedRelease(ctx: RepoCtx, id: string): Promise<Release | null> {
    const numeric = Number(id);
    if (!Number.isInteger(numeric) || numeric < 1) return null;
    const { getReleaseById } = await import("../../services/releases.js");
    const release = getReleaseById(deps.db, numeric);
    return release && release.repoId === ctx.repo.id ? release : null;
  }

  async function releaseView(c: Context<Env>, ctx: RepoCtx, tag: string) {
    const release = getReleaseByTag(deps.db, ctx.repo.id, tag);
    if (!release || !visible(ctx, release)) return notFound(c);
    const { owner, name } = ctx.repo;
    const assets = listAssets(deps.db, release.id);
    const notes = release.body ? renderMarkdown(release.body, { repo: { owner, name, ref: release.tag, dir: "" } }) : "";
    const writer = can(ctx.access, "write");
    return repoPage(
      c,
      ctx,
      "code",
      `${release.title} · ${owner}/${name}`,
      <>
        <div class="d-flex flex-wrap flex-items-center mb-2" style="gap:8px">
          <h1 class="f2 text-normal flex-auto">{release.title}</h1>
          {release.draft && <span class="Label">Draft</span>}
          {release.prerelease && <span class="Label Label--attention">Pre-release</span>}
          {writer && <a class="btn btn-sm" href={repoUrl(owner, name, "releases", "edit", encPath(release.tag))}>Edit</a>}
          {writer && (
            <form method="post" action={repoUrl(owner, name, "releases", "delete")}>
              <CsrfField csrf={c.get("csrf")} />
              <input type="hidden" name="tag" value={release.tag} />
              <button class="btn btn-sm btn-danger" type="submit" data-confirm="Delete this release? The tag is kept.">Delete</button>
            </form>
          )}
        </div>
        <p class="color-fg-muted">
          <a class="text-mono" href={repoUrl(owner, name, "tree", encPath(release.tag))}>{release.tag}</a>
          {" · "}
          {release.author} released this <TimeAgo ts={release.publishedAt ?? release.createdAt} />
          <span class="d-none">{formatDate(release.publishedAt ?? release.createdAt)}</span>
        </p>
        <div class="Box mb-4">
          <div class="Box-header">Assets</div>
          <div class="Box-body">
            <ul class="list-style-none">
              <li class="mb-2"><a href={archiveUrl(owner, name, "tags", release.tag, "zip")}>Source code (zip)</a></li>
              <li class="mb-2"><a href={archiveUrl(owner, name, "tags", release.tag, "tar.gz")}>Source code (tar.gz)</a></li>
              {assets.map((asset) => (
                <li class="d-flex flex-items-center mb-2">
                  <a class="flex-auto" href={repoUrl(owner, name, "releases", "download", encPath(release.tag), encodeURIComponent(asset.name))}>{asset.name}</a>
                  <span class="f6 color-fg-muted mr-3">{formatBytes(asset.size)} · {asset.downloadCount} downloads</span>
                  {writer && (
                    <form method="post" action={repoUrl(owner, name, "releases", String(release.id), "assets", String(asset.id), "delete")}>
                      <CsrfField csrf={c.get("csrf")} />
                      <button class="btn btn-sm btn-danger" type="submit" aria-label={`Delete ${asset.name}`} data-confirm={`Delete ${asset.name}?`}>Delete</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
            {writer && (
              <form class="mt-3" method="post" encType="multipart/form-data" action={`${repoUrl(owner, name, "releases", String(release.id), "assets")}?_csrf=${encodeURIComponent(c.get("csrf"))}`}>
                <label class="d-block mb-2">Attach a file (up to 2 GB)
                  <input class="form-control mt-1" type="file" name="file" required />
                </label>
                <button class="btn btn-sm" type="submit">Upload asset</button>
              </form>
            )}
          </div>
        </div>
        {notes && <div class="markdown-body Box Box-body">{raw(notes)}</div>}
      </>,
    );
  }

  async function sendAsset(c: Context<Env>, ctx: RepoCtx, release: Release, name: string) {
    if (!visible(ctx, release)) return notFound(c);
    const asset = getAssetByName(deps.db, release.id, name);
    if (!asset) return notFound(c);
    const path = releaseAssetPath(deps.config.dataDir, ctx.repo.id, release.id, asset.id);
    const info = await stat(path).catch(() => null);
    if (!info) return notFound(c);
    recordDownload(deps.db, asset.id);
    c.header("content-type", "application/octet-stream");
    c.header("content-disposition", attachmentDisposition(asset.name));
    c.header("content-length", String(info.size));
    c.header("x-content-type-options", "nosniff");
    return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream);
  }
}
