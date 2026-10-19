import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import type { Deps } from "../../deps.js";
import {
  applyCommit,
  applyLineEndings,
  BranchChangedError,
  commitMessage,
  joinRepoPath,
  repoPath,
} from "../../services/edits.js";
import { ValidationError } from "../../services/errors.js";
import type { User } from "../../services/users.js";
import type { Env } from "../env.js";
import { locateRef, type Located } from "../locate.js";
import { field, form } from "../middleware.js";
import { readMultipart } from "../multipart.js";
import { blobUrl, encPath, repoUrl, treeUrl } from "../paths.js";
import { notFound } from "../render.js";
import { CodeEditor, CommitForm, UploadForm } from "../views/editor.js";
import { PathBreadcrumbs } from "../views/repo.js";
import { repoPage, withRepo } from "./code.js";

const MAX_EDIT = 1024 * 1024;
const MAX_FILE = 25 * 1024 * 1024;
const MAX_FILES = 100;
const MAX_TOTAL = 100 * 1024 * 1024;

type Action = "create" | "update" | "delete";
type Fields = Record<string, string | string[]>;

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

function parentDir(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

export function editRoutes(deps: Deps, app: Hono<Env>) {
  const R = "/:owner/:repo";

  async function fileAt(ctx: Parameters<typeof locateRef>[0], rest: string): Promise<Located | null> {
    const loc = await locateRef(ctx, rest);
    if (!loc?.path) return null;
    try {
      repoPath(loc.path);
    } catch {
      return null;
    }
    return (await ctx.git.objectType(loc.sha, loc.path)) === "blob" ? loc : null;
  }

  async function dirAt(ctx: Parameters<typeof locateRef>[0], rest: string): Promise<Located | null> {
    const loc = await locateRef(ctx, rest);
    if (!loc) return null;
    if (!loc.path) return loc;
    return (await ctx.git.objectType(loc.sha, loc.path)) === "tree" ? loc : null;
  }

  function finish(c: Context<Env>, ctx: Parameters<typeof repoPage>[1], branch: string, madeBranch: boolean, path: string, asTree: boolean) {
    const { owner, name, defaultBranch } = ctx.repo;
    if (madeBranch) return c.redirect(repoUrl(owner, name, "compare", `${encPath(defaultBranch)}...${encPath(branch)}`));
    return c.redirect(asTree ? treeUrl(owner, name, branch, path) : blobUrl(owner, name, branch, path));
  }

  async function commitOne(
    c: Context<Env>,
    ctx: Parameters<typeof repoPage>[1],
    loc: Located,
    action: Action,
    path: string,
    text: string | null,
    existing: Buffer | null,
    f: Fields,
  ) {
    const user = c.get("user") as User;
    const madeBranch = field(f, "commit_to") === "branch";
    const newBranch = madeBranch ? field(f, "new_branch").trim() : "";
    if (madeBranch && !newBranch) return page(c, ctx, loc, action, text ?? "", "Name the new branch.", f);
    const stored = text === null ? undefined : applyLineEndings(existing, text);
    try {
      const result = await applyCommit(ctx.git, user, deps.config.baseUrl, {
        branch: loc.ref,
        baseSha: field(f, "base_sha"),
        newBranch,
        message: commitMessage(action, path, field(f, "message"), field(f, "description")),
        changes: [action === "delete" ? { path, delete: true } : { path, content: stored }],
      });
      const dest = action === "delete" ? parentDir(path) : path;
      return finish(c, ctx, result.branch, madeBranch, dest, action === "delete");
    } catch (err) {
      if (err instanceof BranchChangedError) {
        const tip = (await ctx.git.branchTip(loc.ref)) ?? loc.sha;
        return page(c, ctx, { ...loc, sha: tip }, action, text ?? "", "This branch changed while you were editing. Your text is still here; review it and commit again.", f, 409);
      }
      if (err instanceof ValidationError) return page(c, ctx, loc, action, text ?? "", err.message, f);
      throw err;
    }
  }

  function page(c: Context<Env>, ctx: Parameters<typeof repoPage>[1], loc: Located, action: Action, text: string, error = "", f?: Fields, status: 200 | 400 | 409 = error ? 400 : 200) {
    const { owner, name } = ctx.repo;
    const verb = action === "create" ? "new" : action === "delete" ? "delete" : "edit";
    const target = repoUrl(owner, name, verb, encPath(loc.ref), (action === "create" ? loc.path : loc.path) && encPath(action === "create" ? loc.path : loc.path));
    const heading = action === "create" ? "Create a new file" : action === "delete" ? `Delete ${loc.path}` : `Edit ${loc.path}`;
    return repoPage(
      c,
      ctx,
      "code",
      `${heading} · ${owner}/${name}`,
      <>
        <div class="mb-3"><PathBreadcrumbs ctx={ctx} gitRef={loc.ref} path={loc.path} last="text" /></div>
        <CommitForm
          action={target}
          csrf={c.get("csrf")}
          branch={loc.ref}
          baseSha={loc.sha}
          message={f ? field(f, "message") : ""}
          description={f ? field(f, "description") : ""}
          error={error || undefined}
        >
          {action === "create" && (
            <label class="d-block mb-3">
              File name
              <input class="form-control text-mono mt-1" name="filename" value={f ? field(f, "filename") : ""} required aria-label="File name" />
            </label>
          )}
          {action === "delete" ? (
            <div class="flash flash-warn">This will delete <strong class="text-mono">{loc.path}</strong>.</div>
          ) : (
            <CodeEditor value={text} />
          )}
        </CommitForm>
      </>,
      status,
    );
  }

  app.get(`${R}/new/:rest{.+}`, withRepo(deps, "write", async (c, ctx) => {
    const loc = await dirAt(ctx, c.req.param("rest") ?? "");
    if (!loc) return notFound(c);
    return page(c, ctx, loc, "create", "");
  }));

  app.post(`${R}/new/:rest{.+}`, withRepo(deps, "write", async (c, ctx) => {
    const loc = await dirAt(ctx, c.req.param("rest") ?? "");
    if (!loc) return notFound(c);
    const f = await form(c);
    let path: string;
    try {
      path = joinRepoPath(loc.path, field(f, "filename").trim());
    } catch (err) {
      if (err instanceof ValidationError) return page(c, ctx, loc, "create", field(f, "content"), err.message, f);
      throw err;
    }
    if (await ctx.git.objectType(loc.sha, path)) return page(c, ctx, loc, "create", field(f, "content"), "A file or folder already exists at that path.", f);
    return commitOne(c, ctx, loc, "create", path, field(f, "content"), null, f);
  }));

  app.get(`${R}/edit/:rest{.+}`, withRepo(deps, "write", async (c, ctx) => {
    const loc = await fileAt(ctx, c.req.param("rest") ?? "");
    if (!loc) return notFound(c);
    const blob = await ctx.git.blob(loc.sha, loc.path, MAX_EDIT);
    if (blob.truncated || isBinary(blob.content)) return notFound(c, "This file can't be edited in the browser");
    return page(c, ctx, loc, "update", blob.content.toString("utf8"));
  }));

  app.post(`${R}/edit/:rest{.+}`, withRepo(deps, "write", async (c, ctx) => {
    const loc = await fileAt(ctx, c.req.param("rest") ?? "");
    if (!loc) return notFound(c);
    const existing = await ctx.git.blob(loc.sha, loc.path, MAX_EDIT);
    if (existing.truncated || isBinary(existing.content)) return notFound(c, "This file can't be edited in the browser");
    const f = await form(c);
    return commitOne(c, ctx, loc, "update", loc.path, field(f, "content"), existing.content, f);
  }));

  app.get(`${R}/delete/:rest{.+}`, withRepo(deps, "write", async (c, ctx) => {
    const loc = await fileAt(ctx, c.req.param("rest") ?? "");
    if (!loc) return notFound(c);
    return page(c, ctx, loc, "delete", "");
  }));

  app.post(`${R}/delete/:rest{.+}`, withRepo(deps, "write", async (c, ctx) => {
    const loc = await fileAt(ctx, c.req.param("rest") ?? "");
    if (!loc) return notFound(c);
    return commitOne(c, ctx, loc, "delete", loc.path, null, null, await form(c));
  }));

  function uploadPage(c: Context<Env>, ctx: Parameters<typeof repoPage>[1], loc: Located, error = "") {
    const { owner, name } = ctx.repo;
    return repoPage(
      c,
      ctx,
      "code",
      `Upload · ${owner}/${name}`,
      <>
        <h1 class="f3 text-normal mb-3">Upload files</h1>
        <UploadForm action={repoUrl(owner, name, "upload", encPath(loc.ref), loc.path && encPath(loc.path))} csrf={c.get("csrf")} branch={loc.ref} baseSha={loc.sha} error={error || undefined} />
      </>,
      error ? 400 : 200,
    );
  }

  app.get(`${R}/upload/:rest{.+}`, withRepo(deps, "write", async (c, ctx) => {
    const loc = await dirAt(ctx, c.req.param("rest") ?? "");
    if (!loc) return notFound(c);
    return uploadPage(c, ctx, loc);
  }));

  app.post(`${R}/upload/:rest{.+}`, withRepo(deps, "write", async (c, ctx) => {
    const loc = await dirAt(ctx, c.req.param("rest") ?? "");
    if (!loc) return notFound(c);
    const dir = await mkdtemp(join(tmpdir(), "insitio-upload-"));
    try {
      if (!c.req.raw.body) throw new ValidationError("Choose a file to upload.");
      const parsed = await readMultipart(c.req.raw.body, c.req.header("content-type") ?? "", {
        dir,
        maxFiles: MAX_FILES,
        maxFileBytes: MAX_FILE,
        maxTotalBytes: MAX_TOTAL,
      });
      const changes: { path: string; content: Buffer }[] = [];
      for (const file of parsed.files) {
        if (!file.filename) continue;
        changes.push({ path: joinRepoPath(loc.path, file.filename), content: await readFile(file.tempPath) });
      }
      if (!changes.length) throw new ValidationError("Choose a file to upload.");
      const madeBranch = parsed.fields.commit_to === "branch";
      const newBranch = madeBranch ? (parsed.fields.new_branch ?? "").trim() : "";
      if (madeBranch && !newBranch) throw new ValidationError("Name the new branch.");
      const result = await applyCommit(ctx.git, c.get("user") as User, deps.config.baseUrl, {
        branch: loc.ref,
        baseSha: parsed.fields.base_sha ?? "",
        newBranch,
        message: commitMessage("upload", changes[0].path, parsed.fields.message ?? "", parsed.fields.description ?? ""),
        changes,
      });
      return finish(c, ctx, result.branch, madeBranch, loc.path, true);
    } catch (err) {
      if (err instanceof BranchChangedError) {
        const tip = (await ctx.git.branchTip(loc.ref)) ?? loc.sha;
        return uploadPage(c, ctx, { ...loc, sha: tip }, "This branch changed while you were editing. Choose the files again and commit them.");
      }
      if (err instanceof ValidationError) return uploadPage(c, ctx, loc, err.message);
      throw err;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }));
}
