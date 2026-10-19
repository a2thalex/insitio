import type { Context, Hono } from "hono";
import type { Deps } from "../../deps.js";
import { createBranchFrom, deleteBranchIfAllowed, restoreBranch } from "../../services/branches.js";
import { NotFoundError, ValidationError } from "../../services/errors.js";
import { releaseNamesByTag, TAGS_PER_PAGE } from "../../services/releases.js";
import type { Env } from "../env.js";
import { formatDate } from "../format.js";
import { field, form } from "../middleware.js";
import { archiveUrl, commitUrl, encPath, repoUrl, treeUrl } from "../paths.js";
import { notFound } from "../render.js";
import { Octicon, Pagination, TimeAgo } from "../views/layout.js";
import { repoPage, withRepo } from "./code.js";

export function refRoutes(deps: Deps, app: Hono<Env>) {
  const R = "/:owner/:repo";

  app.post(`${R}/branches`, withRepo(deps, "write", async (c, ctx) => {
    const f = await form(c);
    try {
      await createBranchFrom(ctx.git, field(f, "name"), field(f, "source"));
      return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "branches"));
    } catch (err) {
      if (err instanceof ValidationError) return branchError(c, ctx, err.message);
      throw err;
    }
  }));

  app.post(`${R}/branches/delete`, withRepo(deps, "write", async (c, ctx) => {
    const name = field(await form(c), "name");
    try {
      const sha = await deleteBranchIfAllowed(deps.db, ctx.git, ctx.repo, name);
      const q = new URLSearchParams({ deleted: name, sha });
      return c.redirect(`${repoUrl(ctx.repo.owner, ctx.repo.name, "branches")}?${q}`);
    } catch (err) {
      if (err instanceof ValidationError) return branchError(c, ctx, err.message);
      if (err instanceof NotFoundError) return notFound(c, "That branch");
      throw err;
    }
  }));

  app.post(`${R}/branches/restore`, withRepo(deps, "write", async (c, ctx) => {
    const f = await form(c);
    try {
      await restoreBranch(ctx.git, field(f, "name"), field(f, "sha"));
      return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "branches"));
    } catch (err) {
      if (err instanceof ValidationError) return branchError(c, ctx, err.message);
      throw err;
    }
  }));

  app.get(`${R}/tags`, withRepo(deps, "read", async (c, ctx) => {
    const { owner, name } = ctx.repo;
    const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
    const tags = await ctx.git.tagList();
    const names = releaseNamesByTag(deps.db, ctx.repo.id);
    const slice = tags.slice((page - 1) * TAGS_PER_PAGE, page * TAGS_PER_PAGE);
    return repoPage(
      c,
      ctx,
      "code",
      `Tags · ${owner}/${name}`,
      <>
        <h1 class="f3 text-normal mb-3">Tags</h1>
        <div class="Box">
          {slice.length === 0 && <div class="Box-row color-fg-muted">No tags yet.</div>}
          {slice.map((tag) => {
            const release = names.get(tag.name);
            return (
              <div class="Box-row">
                <div class="d-flex flex-items-center flex-wrap" style="gap:8px">
                  <Octicon name="tag" class="color-fg-muted" />
                  <a class="text-bold" href={treeUrl(owner, name, tag.name)}>{tag.name}</a>
                  {release && <a class="Label Label--secondary" href={repoUrl(owner, name, "releases", "tag", encPath(tag.name))}>{release}</a>}
                  <span class="f6 color-fg-muted ml-auto">
                    <a class="text-mono Link--secondary" href={commitUrl(owner, name, tag.sha)}>{tag.sha.slice(0, 7)}</a>
                    {" · "}
                    <TimeAgo ts={tag.date} />
                    <span class="d-none">{formatDate(tag.date)}</span>
                  </span>
                  <a class="btn btn-sm" href={archiveUrl(owner, name, "tags", tag.name, "zip")}>zip</a>
                  <a class="btn btn-sm" href={archiveUrl(owner, name, "tags", tag.name, "tar.gz")}>tar.gz</a>
                </div>
                {tag.annotated && tag.message && <pre class="f6 color-fg-muted mt-2 mb-0">{tag.message}</pre>}
              </div>
            );
          })}
        </div>
        <Pagination page={page} total={tags.length} perPage={TAGS_PER_PAGE} href={(p) => `${repoUrl(owner, name, "tags")}?page=${p}`} />
      </>,
    );
  }));
}

function branchError(c: Context<Env>, ctx: Parameters<typeof repoPage>[1], message: string) {
  return repoPage(c, ctx, "code", `Branches · ${ctx.repo.owner}/${ctx.repo.name}`, <div class="flash flash-error" role="alert">{message}</div>, 400);
}
