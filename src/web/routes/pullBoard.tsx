import type { Hono } from "hono";
import type { DiffFile } from "../../git/diff.js";
import { assertCommitPath } from "../../git/paths.js";
import type { Deps } from "../../deps.js";
import { GitError } from "../../git/run.js";
import { MergeConflictError, RefMovedError } from "../../git/repo.js";
import { listBranchRules } from "../../services/repoAdmin.js";
import { ValidationError } from "../../services/errors.js";
import { assertCanTalk } from "../../services/issueExtras.js";
import { can } from "../../services/permissions.js";
import { assertNotBlocked } from "../../services/account.js";
import { getPull, setPullDraft } from "../../services/pulls.js";
import { diffLineText, pullChanges } from "./pulls.js";
import {
  addLineComment, addReview, deleteLineComment, deletePullTemplate, getLineComment, listPullTemplates, savePullTemplate, setReviewers, updateLineComment,
} from "../../services/pullExtras.js";
import { authorFor } from "../../services/repos.js";
import { applySuggestionToFile, suggestionBlock } from "../../services/suggestions.js";
import type { Env } from "../env.js";
import { field, form, loginRedirect } from "../middleware.js";
import { repoUrl } from "../paths.js";
import { notFound, renderError } from "../render.js";
import { CsrfField } from "../views/layout.js";
import { canManage } from "./issues.js";
import { repoPage, withRepo } from "./code.js";

function onDiff(files: DiffFile[], path: string, side: "left" | "right", line: number): boolean {
  return files.some((file) => {
    if ((side === "left" ? file.oldPath : file.newPath) !== path) return false;
    return file.hunks.some((hunk) => hunk.lines.some((item) => (side === "left" ? item.oldNo : item.newNo) === line));
  });
}

export function pullBoardRoutes(deps: Deps, app: Hono<Env>) {
  const R = "/:owner/:repo";

  app.get(`${R}/pulls/templates`, withRepo(deps, "write", (c, ctx) => {
    const templates = listPullTemplates(deps.db, ctx.repo.id);
    const { owner, name } = ctx.repo;
    return repoPage(
      c,
      ctx,
      "pulls",
      "Pull request templates",
      <>
        <h1 class="f3 text-normal mb-3">Pull request templates</h1>
        <form method="post" action={repoUrl(owner, name, "pulls", "templates")} class="Box p-3 mb-3">
          <CsrfField csrf={c.get("csrf")} />
          <input class="form-control mb-2" name="name" placeholder="Name" aria-label="Template name" required maxlength={60} />
          <input class="form-control mb-2" name="about" placeholder="About" aria-label="About" maxlength={120} />
          <input class="form-control mb-2" name="title" placeholder="Default title" aria-label="Default title" />
          <textarea class="form-control mb-2" name="body" placeholder="Default body" aria-label="Default body" rows={5}></textarea>
          <button class="btn btn-primary" type="submit">Add template</button>
        </form>
        <div class="Box">
          {templates.map((template) => (
            <div class="Box-row d-flex flex-items-center">
              <div class="flex-auto"><strong>{template.name}</strong><div class="f6 color-fg-muted">{template.about}</div></div>
              <form method="post" action={repoUrl(owner, name, "pulls", "templates", String(template.id), "delete")}>
                <CsrfField csrf={c.get("csrf")} />
                <button class="btn btn-sm btn-danger" type="submit">Delete</button>
              </form>
            </div>
          ))}
        </div>
      </>,
    );
  }));

  app.post(`${R}/pulls/templates`, withRepo(deps, "write", async (c, ctx) => {
    const f = await form(c);
    savePullTemplate(deps.db, ctx.repo.id, { name: field(f, "name"), about: field(f, "about"), title: field(f, "title"), body: field(f, "body") });
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "pulls", "templates"));
  }));

  app.post(`${R}/pulls/templates/:id/delete`, withRepo(deps, "write", async (c, ctx) => {
    deletePullTemplate(deps.db, ctx.repo.id, Number(c.req.param("id")));
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "pulls", "templates"));
  }));

  const pullOf = (c: Parameters<typeof notFound>[0], ctx: Parameters<typeof repoPage>[1]) => {
    const n = Number(c.req.param("n"));
    return Number.isInteger(n) && n > 0 ? getPull(deps.db, ctx.repo.id, n) : null;
  };

  app.post(`${R}/pull/:n/draft`, withRepo(deps, "read", async (c, ctx) => {
    const pull = pullOf(c, ctx);
    if (!pull) return notFound(c);
    if (!canManage(c, ctx, pull)) return renderError(c, 403, "You can't change this pull request.");
    setPullDraft(deps.db, pull.id, !pull.draft);
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "pull", String(pull.number)));
  }));

  app.post(`${R}/pull/:n/reviewers`, withRepo(deps, "write", async (c, ctx) => {
    const pull = pullOf(c, ctx);
    if (!pull) return notFound(c);
    setReviewers(deps.db, ctx.repo, pull.id, field(await form(c), "reviewers").split(/[\s,]+/));
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "pull", String(pull.number)));
  }));

  app.post(`${R}/pull/:n/reviews`, withRepo(deps, "read", async (c, ctx) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const pull = pullOf(c, ctx);
    if (!pull) return notFound(c);
    assertCanTalk(pull, ctx.access);
    assertNotBlocked(deps.db, user.id, ctx.repo.ownerId);
    const f = await form(c);
    const raw = field(f, "state");
    const state = raw === "approve" ? "approve" : raw === "changes" ? "changes" : "comment";
    if (state !== "comment" && !can(ctx.access, "write")) return renderError(c, 403, "You need write access to approve or request changes.");
    addReview(deps.db, pull.id, user.id, state, field(f, "body"));
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "pull", String(pull.number)));
  }));

  app.post(`${R}/pull/:n/update`, withRepo(deps, "write", async (c, ctx) => {
    const user = c.get("user")!;
    const pull = pullOf(c, ctx);
    if (!pull || pull.state !== "open" || pull.mergedAt) return notFound(c);
    const message = `Merge branch '${pull.baseRef}' into ${pull.headRef}`;
    try {
      await ctx.git.merge(pull.headRef, pull.baseRef, message, authorFor(user));
    } catch (err) {
      if (err instanceof MergeConflictError) return renderError(c, 409, "This branch has conflicts that must be resolved before merging.");
      if (err instanceof RefMovedError) return renderError(c, 409, "The branch changed while updating. Reload and try again.");
      if (err instanceof GitError) return renderError(c, 409, "This branch is already up to date.");
      throw err;
    }
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "pull", String(pull.number)));
  }));

  app.post(`${R}/pull/:n/line-comments`, withRepo(deps, "read", async (c, ctx) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const pull = pullOf(c, ctx);
    if (!pull) return notFound(c);
    assertCanTalk(pull, ctx.access);
    assertNotBlocked(deps.db, user.id, ctx.repo.ownerId);
    const f = await form(c);
    const path = field(f, "path");
    const side = field(f, "side") === "left" ? "left" : field(f, "side") === "right" ? "right" : "";
    const line = Number(field(f, "line"));
    try {
      assertCommitPath(path);
    } catch {
      throw new ValidationError("That path can't be commented on.");
    }
    if (!side || !Number.isInteger(line) || line < 1) throw new ValidationError("Choose a line in the diff.");
    const diff = await pullChanges(ctx, pull);
    const lineText = diffLineText(diff.files, path, side, line);
    if (lineText === null || !onDiff(diff.files, path, side, line)) throw new ValidationError("That line is not in the diff.");
    const commitSha = pull.mergeCommit ?? (await ctx.git.resolve(pull.headRef)) ?? "";
    addLineComment(deps.db, pull.id, user.id, { path, side, line, body: field(f, "body"), commitSha, lineText });
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "pull", String(pull.number), "files"));
  }));

  app.post(`${R}/pull/:n/line-comments/:id`, withRepo(deps, "read", async (c, ctx) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const pull = pullOf(c, ctx);
    if (!pull) return notFound(c);
    const comment = getLineComment(deps.db, pull.id, Number(c.req.param("id")));
    if (!comment) return notFound(c);
    if (user.id !== comment.userId && ctx.access !== "admin") return renderError(c, 403, "You can't edit this comment.");
    const f = await form(c);
    if (field(f, "action") === "delete") deleteLineComment(deps.db, comment.id);
    else updateLineComment(deps.db, comment.id, field(f, "body"));
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "pull", String(pull.number), "files"));
  }));

  app.post(`${R}/pull/:n/line-comments/:id/apply`, withRepo(deps, "write", async (c, ctx) => {
    const user = c.get("user")!;
    await form(c);
    const pull = pullOf(c, ctx);
    if (!pull) return notFound(c);
    if (pull.mergedAt) return renderError(c, 409, "This pull request was merged.");
    if (listBranchRules(deps.db, ctx.repo.id).some((rule) => rule.branch === pull.headRef) && ctx.access !== "admin") {
      return renderError(c, 403, "This branch is protected.");
    }
    const comment = getLineComment(deps.db, pull.id, Number(c.req.param("id")));
    if (!comment || comment.side !== "right") return renderError(c, 400, "Only a suggestion on the new side can be applied.");
    const suggestion = suggestionBlock(comment.body);
    if (suggestion === null) throw new ValidationError("That comment has no suggestion.");
    try {
      assertCommitPath(comment.path);
    } catch {
      throw new ValidationError("That path can't be changed.");
    }
    const head = await ctx.git.resolve(pull.headRef);
    if (!head) throw new ValidationError("The head branch is gone.");
    const dir = comment.path.includes("/") ? comment.path.slice(0, comment.path.lastIndexOf("/")) : "";
    const baseName = comment.path.slice(dir.length ? dir.length + 1 : 0);
    let mode = "";
    try {
      mode = (await ctx.git.tree(head, dir)).find((entry) => entry.name === baseName)?.mode ?? "";
    } catch (err) {
      if (!(err instanceof GitError)) throw err;
    }
    if (mode !== "100644") throw new ValidationError("Suggestions can only be applied to regular files.");
    let blob;
    try {
      blob = await ctx.git.blob(head, comment.path, 1_000_000);
    } catch (err) {
      if (err instanceof GitError) throw new ValidationError("That file is not on the head branch.");
      throw err;
    }
    if (blob.truncated || blob.content.includes(0)) throw new ValidationError("That file can't be edited from a suggestion.");
    const next = applySuggestionToFile(blob.content.toString("utf8"), comment.line, comment.lineText, suggestion);
    try {
      await ctx.git.commitFiles(pull.headRef, { [comment.path]: next }, `Apply suggestion on ${comment.path}`, authorFor(user), undefined, head);
    } catch (err) {
      if (err instanceof RefMovedError) return renderError(c, 409, "The branch changed while applying. Reload and try again.");
      throw err;
    }
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "pull", String(pull.number), "files"));
  }));
}
