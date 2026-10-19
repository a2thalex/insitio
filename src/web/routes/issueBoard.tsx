import type { Hono } from "hono";
import type { Deps } from "../../deps.js";
import {
  assertCanTalk,
  createMilestone,
  deleteMilestone,
  deleteTemplate,
  getMilestone,
  listMilestones,
  listTemplates,
  parseDue,
  recordMentions,
  saveTemplate,
  setAssignees,
  setLocked,
  setMilestone,
  setPinned,
  toggleReaction,
  updateMilestone,
} from "../../services/issueExtras.js";
import { deleteComment, getIssue, listComments, updateComment } from "../../services/issues.js";
import { can } from "../../services/permissions.js";
import { ValidationError } from "../../services/errors.js";
import type { Env } from "../env.js";
import { field, form, loginRedirect } from "../middleware.js";
import { repoUrl } from "../paths.js";
import { notFound, renderError } from "../render.js";
import { CsrfField, Flash, Pagination } from "../views/layout.js";
import { repoPage, withRepo } from "./code.js";

function dueValue(ts: number | null): string {
  return ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "";
}

export function issueBoardRoutes(deps: Deps, app: Hono<Env>) {
  const R = "/:owner/:repo";

  app.get(`${R}/milestones`, withRepo(deps, "read", (c, ctx) => {
    const state = c.req.query("state") === "closed" ? "closed" : "open";
    const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
    const perPage = 30;
    const all = listMilestones(deps.db, ctx.repo.id, state);
    const items = all.slice((page - 1) * perPage, page * perPage);
    const { owner, name } = ctx.repo;
    const href = (p: number) => `${repoUrl(owner, name, "milestones")}?state=${state}&page=${p}`;
    return repoPage(
      c,
      ctx,
      "issues",
      `Milestones · ${owner}/${name}`,
      <>
        <div class="d-flex mb-3">
          <h1 class="f3 text-normal flex-auto">Milestones</h1>
          {can(ctx.access, "write") && <a class="btn btn-primary" href={repoUrl(owner, name, "milestones", "new")}>New milestone</a>}
        </div>
        <nav class="mb-3" aria-label="Filter milestones by state">
          <a class={state === "open" ? "text-bold mr-3" : "mr-3"} href={`${repoUrl(owner, name, "milestones")}?state=open`}>Open</a>
          <a class={state === "closed" ? "text-bold" : ""} href={`${repoUrl(owner, name, "milestones")}?state=closed`}>Closed</a>
        </nav>
        <div class="Box">
          {items.length === 0 && <div class="Box-row color-fg-muted">No {state} milestones.</div>}
          {items.map((m) => (
            <div class="Box-row d-flex">
              <div class="flex-auto">
                <a class="text-bold" href={`${repoUrl(owner, name, "issues")}?milestone=${encodeURIComponent(m.title)}`}>{m.title}</a>
                <div class="f6 color-fg-muted">{m.openCount} open · {m.closedCount} closed{m.dueOn ? ` · due ${dueValue(m.dueOn)}` : ""}</div>
              </div>
              {can(ctx.access, "write") && <a class="btn btn-sm" href={repoUrl(owner, name, "milestones", String(m.number), "edit")}>Edit</a>}
            </div>
          ))}
        </div>
        <Pagination page={page} total={all.length} perPage={perPage} href={href} />
      </>,
    );
  }));

  const milestoneForm = (c: Parameters<typeof repoPage>[0], ctx: Parameters<typeof repoPage>[1], opts: { action: string; title: string; description: string; due: string; state?: "open" | "closed"; error?: string; editing?: boolean }) =>
    repoPage(
      c,
      ctx,
      "issues",
      `${opts.editing ? "Edit" : "New"} milestone`,
      <>
        <h1 class="f3 text-normal mb-3">{opts.editing ? "Edit milestone" : "New milestone"}</h1>
        <Flash error={opts.error} />
        <form method="post" action={opts.action} class="Box p-3">
          <CsrfField csrf={c.get("csrf")} />
          <input class="form-control mb-2" name="title" value={opts.title} aria-label="Title" required maxlength={120} />
          <textarea class="form-control mb-2" name="description" aria-label="Description" rows={5}>{opts.description}</textarea>
          <input class="form-control mb-2" type="date" name="due" value={opts.due} aria-label="Due date" />
          {opts.editing && (
            <select class="form-select mb-2" name="state" aria-label="State">
              <option value="open" selected={opts.state !== "closed"}>Open</option>
              <option value="closed" selected={opts.state === "closed"}>Closed</option>
            </select>
          )}
          <button class="btn btn-primary" type="submit">Save milestone</button>
          {opts.editing && <button class="btn btn-danger ml-2" type="submit" name="action" value="delete" data-confirm="Delete this milestone?">Delete</button>}
        </form>
      </>,
      opts.error ? 400 : 200,
    );

  app.get(`${R}/milestones/new`, withRepo(deps, "write", (c, ctx) => milestoneForm(c, ctx, { action: repoUrl(ctx.repo.owner, ctx.repo.name, "milestones"), title: "", description: "", due: "" })));

  app.post(`${R}/milestones`, withRepo(deps, "write", async (c, ctx) => {
    const f = await form(c);
    try {
      createMilestone(deps.db, ctx.repo.id, { title: field(f, "title"), description: field(f, "description"), dueOn: parseDue(field(f, "due")) });
      return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "milestones"));
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return milestoneForm(c, ctx, { action: repoUrl(ctx.repo.owner, ctx.repo.name, "milestones"), title: field(f, "title"), description: field(f, "description"), due: field(f, "due"), error: err.message });
    }
  }));

  app.get(`${R}/milestones/:n/edit`, withRepo(deps, "write", (c, ctx) => {
    const milestone = getMilestone(deps.db, ctx.repo.id, Number(c.req.param("n")));
    if (!milestone) return notFound(c, "That milestone");
    return milestoneForm(c, ctx, {
      action: repoUrl(ctx.repo.owner, ctx.repo.name, "milestones", String(milestone.number)),
      title: milestone.title,
      description: milestone.description,
      due: dueValue(milestone.dueOn),
      state: milestone.state,
      editing: true,
    });
  }));

  app.post(`${R}/milestones/:n`, withRepo(deps, "write", async (c, ctx) => {
    const milestone = getMilestone(deps.db, ctx.repo.id, Number(c.req.param("n")));
    if (!milestone) return notFound(c, "That milestone");
    const f = await form(c);
    if (field(f, "action") === "delete") {
      deleteMilestone(deps.db, ctx.repo.id, milestone.id);
      return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "milestones"));
    }
    try {
      updateMilestone(deps.db, milestone, {
        title: field(f, "title"),
        description: field(f, "description"),
        dueOn: parseDue(field(f, "due")),
        state: field(f, "state") === "closed" ? "closed" : "open",
      });
      return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "milestones"));
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return milestoneForm(c, ctx, { action: repoUrl(ctx.repo.owner, ctx.repo.name, "milestones", String(milestone.number)), title: field(f, "title"), description: field(f, "description"), due: field(f, "due"), state: milestone.state, editing: true, error: err.message });
    }
  }));

  app.get(`${R}/issues/templates`, withRepo(deps, "write", (c, ctx) => {
    const templates = listTemplates(deps.db, ctx.repo.id);
    return repoPage(
      c,
      ctx,
      "issues",
      "Issue templates",
      <>
        <h1 class="f3 text-normal mb-3">Issue templates</h1>
        <form method="post" action={repoUrl(ctx.repo.owner, ctx.repo.name, "issues", "templates")} class="Box p-3 mb-3">
          <CsrfField csrf={c.get("csrf")} />
          <input class="form-control mb-2" name="name" placeholder="Name" aria-label="Template name" required maxlength={60} />
          <input class="form-control mb-2" name="about" placeholder="About" aria-label="About" maxlength={120} />
          <input class="form-control mb-2" name="title" placeholder="Default title" aria-label="Default title" />
          <textarea class="form-control mb-2" name="body" placeholder="Default body" aria-label="Default body" rows={5}></textarea>
          <button class="btn btn-primary" type="submit">Add template</button>
        </form>
        <div class="Box">
          {templates.map((t) => (
            <div class="Box-row d-flex flex-items-center">
              <div class="flex-auto"><strong>{t.name}</strong><div class="f6 color-fg-muted">{t.about}</div></div>
              <form method="post" action={repoUrl(ctx.repo.owner, ctx.repo.name, "issues", "templates", String(t.id), "delete")}>
                <CsrfField csrf={c.get("csrf")} />
                <button class="btn btn-sm btn-danger" type="submit">Delete</button>
              </form>
            </div>
          ))}
        </div>
      </>,
    );
  }));

  app.post(`${R}/issues/templates`, withRepo(deps, "write", async (c, ctx) => {
    const f = await form(c);
    saveTemplate(deps.db, ctx.repo.id, { name: field(f, "name"), about: field(f, "about"), title: field(f, "title"), body: field(f, "body") });
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "issues", "templates"));
  }));

  app.post(`${R}/issues/templates/:id/delete`, withRepo(deps, "write", async (c, ctx) => {
    deleteTemplate(deps.db, ctx.repo.id, Number(c.req.param("id")));
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "issues", "templates"));
  }));

  const issueOf = (c: Parameters<typeof notFound>[0], ctx: Parameters<typeof repoPage>[1]) => {
    const n = Number(c.req.param("n"));
    return Number.isInteger(n) && n > 0 ? getIssue(deps.db, ctx.repo.id, n) : null;
  };

  app.post(`${R}/issues/:n/assignees`, withRepo(deps, "write", async (c, ctx) => {
    const issue = issueOf(c, ctx);
    if (!issue || issue.isPull) return notFound(c);
    setAssignees(deps.db, ctx.repo, issue.id, field(await form(c), "assignees").split(/[\s,]+/), c.get("user")!.id);
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "issues", String(issue.number)));
  }));

  app.post(`${R}/issues/:n/milestone`, withRepo(deps, "write", async (c, ctx) => {
    const issue = issueOf(c, ctx);
    if (!issue || issue.isPull) return notFound(c);
    const raw = field(await form(c), "milestone");
    const milestone = raw ? getMilestone(deps.db, ctx.repo.id, Number(raw)) : null;
    if (raw && !milestone) throw new ValidationError("That milestone doesn't exist.");
    setMilestone(deps.db, issue.id, milestone?.id ?? null, c.get("user")!.id);
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "issues", String(issue.number)));
  }));

  app.post(`${R}/issues/:n/lock`, withRepo(deps, "write", async (c, ctx) => {
    const issue = issueOf(c, ctx);
    if (!issue) return notFound(c);
    setLocked(deps.db, issue.id, !issue.locked, c.get("user")!.id);
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "issues", String(issue.number)));
  }));

  app.post(`${R}/issues/:n/pin`, withRepo(deps, "write", async (c, ctx) => {
    const issue = issueOf(c, ctx);
    if (!issue || issue.isPull) return notFound(c);
    setPinned(deps.db, ctx.repo.id, issue.id, !issue.pinnedAt, c.get("user")!.id);
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "issues", String(issue.number)));
  }));

  app.post(`${R}/issues/:n/reactions`, withRepo(deps, "read", async (c, ctx) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const issue = issueOf(c, ctx);
    if (!issue) return notFound(c);
    assertCanTalk(issue, ctx.access);
    toggleReaction(deps.db, user.id, "issue", issue.id, field(await form(c), "emoji"));
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "issues", String(issue.number)));
  }));

  app.post(`${R}/issues/:n/comments/:id/reactions`, withRepo(deps, "read", async (c, ctx) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const issue = issueOf(c, ctx);
    if (!issue) return notFound(c);
    assertCanTalk(issue, ctx.access);
    const comment = listComments(deps.db, issue.id).find((item) => item.id === Number(c.req.param("id")));
    if (!comment) return notFound(c);
    toggleReaction(deps.db, user.id, "comment", comment.id, field(await form(c), "emoji"));
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "issues", String(issue.number)));
  }));

  app.post(`${R}/issues/:n/comments/:id`, withRepo(deps, "read", async (c, ctx) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const issue = issueOf(c, ctx);
    if (!issue) return notFound(c);
    const comment = listComments(deps.db, issue.id).find((item) => item.id === Number(c.req.param("id")));
    if (!comment) return notFound(c);
    if (user.id !== comment.authorId && ctx.access !== "admin") return renderError(c, 403, "You can't edit this comment.");
    const f = await form(c);
    if (field(f, "action") === "delete") deleteComment(deps.db, comment.id);
    else {
      updateComment(deps.db, comment.id, field(f, "body"));
      recordMentions(deps.db, user, ctx.repo, field(f, "body"), { kind: "issue", number: issue.number });
    }
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "issues", String(issue.number)));
  }));
}
