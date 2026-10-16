import type { Context, Hono } from "hono";
import type { Deps } from "../../deps.js";
import { ValidationError } from "../../services/errors.js";
import {
  PER_PAGE, addComment, createIssue, createLabel, deleteLabel, getIssue, labelCounts, listComments, listEvents, listIssues,
  listLabels, participants, setIssueLabels, setIssueState, updateIssue, type Issue,
} from "../../services/issues.js";
import { can } from "../../services/permissions.js";
import type { Env } from "../env.js";
import { field, fields, form, loginRedirect } from "../middleware.js";
import { repoUrl } from "../paths.js";
import type { RepoCtx } from "../repoContext.js";
import { notFound, renderError } from "../render.js";
import { CsrfField, Flash, LabelChip, Octicon, Pagination } from "../views/layout.js";
import { CommentForm, IssueRow, LabelsSidebar, Participants, StateBadge, Timeline } from "../views/issues.js";
import { repoPage, withRepo } from "./code.js";

/** Authors may close/reopen and edit their own issues; writers may for any. */
export function canManage(c: Context<Env>, ctx: RepoCtx, issue: Issue): boolean {
  const user = c.get("user");
  return !!user && (user.id === issue.authorId || can(ctx.access, "write"));
}

function loginHref(c: Context<Env>) {
  return `/login?next=${encodeURIComponent(new URL(c.req.url).pathname)}`;
}

function NewIssueForm({ ctx, csrf, error, title = "", body = "" }: { ctx: RepoCtx; csrf: string; error?: string; title?: string; body?: string }) {
  return (
    <div style="max-width:900px">
      <h1 class="f3 text-normal mb-3">New issue</h1>
      <Flash error={error} />
      <form method="post" action={repoUrl(ctx.repo.owner, ctx.repo.name, "issues")}>
        <CsrfField csrf={csrf} />
        <input class="form-control input-block input-lg mb-3" name="title" placeholder="Title" aria-label="Title" value={title} required autofocus maxlength={256} />
        <textarea class="form-control input-block" name="body" placeholder="Add a description (Markdown supported)" aria-label="Description" style="min-height:220px">{body}</textarea>
        <div class="d-flex flex-justify-end mt-3">
          <button class="btn btn-primary" type="submit">Submit new issue</button>
        </div>
      </form>
    </div>
  );
}

export function issueRoutes(deps: Deps, app: Hono<Env>) {
  const R = "/:owner/:repo";

  app.get(`${R}/issues`, withRepo(deps, "read", (c, ctx) => {
    const { owner, name } = ctx.repo;
    const state = c.req.query("state") === "closed" ? "closed" : "open";
    const q = c.req.query("q") ?? "";
    const labelName = c.req.query("label") ?? "";
    const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
    const labels = listLabels(deps.db, ctx.repo.id);
    const label = labels.find((l) => l.name.toLowerCase() === labelName.toLowerCase());
    if (labelName && !label) return notFound(c, "That label");
    const filter = { isPull: false, labelId: label?.id, q, page };
    const list = listIssues(deps.db, ctx.repo.id, { ...filter, state });
    const open = listIssues(deps.db, ctx.repo.id, { ...filter, state: "open", page: 1 }).total;
    const closed = listIssues(deps.db, ctx.repo.id, { ...filter, state: "closed", page: 1 }).total;
    const href = (p: Record<string, string | number>) =>
      `${repoUrl(owner, name, "issues")}?${new URLSearchParams(Object.entries({ state, q, label: label?.name ?? "", ...p }).filter(([, v]) => v !== "" && v !== undefined).map(([k, v]) => [k, String(v)]))}`;
    return repoPage(
      c,
      ctx,
      "issues",
      `Issues · ${owner}/${name}`,
      <>
        <div class="d-flex flex-wrap flex-items-center mb-3" style="gap:8px">
          <form action={repoUrl(owner, name, "issues")} method="get" class="flex-auto d-flex" role="search" aria-label="Issues">
            <input type="hidden" name="state" value={state} />
            {label && <input type="hidden" name="label" value={label.name} />}
            <input class="form-control flex-auto" type="search" name="q" value={q} placeholder="Search issues" aria-label="Search issues" />
          </form>
          <a class="btn" href={repoUrl(owner, name, "labels")}><Octicon name="tag" class="mr-1" />Labels</a>
          {c.get("user") && <a class="btn btn-primary" href={repoUrl(owner, name, "issues", "new")}>New issue</a>}
        </div>
        {label && (
          <p class="mb-3 f6">
            Filtered by label <LabelChip label={label} /> · <a href={href({ label: "" })}>Clear filter</a>
          </p>
        )}
        <div class="Box">
          <div class="Box-header d-flex flex-items-center">
            <nav class="d-flex" aria-label="Filter issues by state" style="gap:16px">
              <a class={state === "open" ? "Link--primary text-bold" : "Link--secondary"} href={href({ state: "open", page: "" })} aria-current={state === "open" ? "page" : undefined}>
                <Octicon name="issue-opened" class="mr-1" />{open} Open
              </a>
              <a class={state === "closed" ? "Link--primary text-bold" : "Link--secondary"} href={href({ state: "closed", page: "" })} aria-current={state === "closed" ? "page" : undefined}>
                <Octicon name="check" class="mr-1" />{closed} Closed
              </a>
            </nav>
          </div>
          {list.items.length === 0 ? (
            <div class="blankslate">
              <Octicon name="issue-opened" size={24} />
              <h3 class="blankslate-heading">{q || label ? "No results matched your search." : `There aren't any ${state} issues.`}</h3>
            </div>
          ) : (
            list.items.map((i) => <IssueRow ctx={ctx} issue={i} state={i.state} href={repoUrl(owner, name, "issues", String(i.number))} />)
          )}
        </div>
        <Pagination page={page} total={list.total} perPage={PER_PAGE} href={(p) => href({ page: p })} />
      </>,
    );
  }));

  app.get(`${R}/issues/new`, withRepo(deps, "read", (c, ctx) => {
    if (!c.get("user")) return loginRedirect(c);
    return repoPage(c, ctx, "issues", `New issue · ${ctx.repo.owner}/${ctx.repo.name}`, <NewIssueForm ctx={ctx} csrf={c.get("csrf")} />);
  }));

  app.post(`${R}/issues`, withRepo(deps, "read", async (c, ctx) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const f = await form(c);
    try {
      const issue = createIssue(deps.db, ctx.repo.id, user.id, { title: field(f, "title"), body: field(f, "body") });
      return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "issues", String(issue.number)));
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return repoPage(c, ctx, "issues", "New issue", <NewIssueForm ctx={ctx} csrf={c.get("csrf")} error={err.message} title={field(f, "title")} body={field(f, "body")} />, 400);
    }
  }));

  const loadIssue = (c: Context<Env>, ctx: RepoCtx) => {
    const n = Number(c.req.param("n"));
    return Number.isInteger(n) && n > 0 ? getIssue(deps.db, ctx.repo.id, n) : null;
  };

  app.get(`${R}/issues/:n`, withRepo(deps, "read", (c, ctx) => {
    const issue = loadIssue(c, ctx);
    if (!issue) return notFound(c, "This issue");
    const { owner, name } = ctx.repo;
    if (issue.isPull) return c.redirect(repoUrl(owner, name, "pull", String(issue.number)));
    const comments = listComments(deps.db, issue.id);
    const base = repoUrl(owner, name, "issues", String(issue.number));
    return repoPage(
      c,
      ctx,
      "issues",
      `${issue.title} · Issue #${issue.number} · ${owner}/${name}`,
      <>
        <div class="border-bottom pb-3 mb-3">
          <h1 class="f1 text-normal" style="word-break:break-word">
            {issue.title} <span class="color-fg-muted">#{issue.number}</span>
          </h1>
          <div class="d-flex flex-items-center mt-2 color-fg-muted">
            <StateBadge state={issue.state} isPull={false} />
            <span>
              <a class="text-bold Link--secondary" href={`/${issue.author}`}>{issue.author}</a> opened this issue · {comments.length} comment{comments.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <div class="d-md-flex">
          <div class="flex-auto min-width-0 mr-md-4">
            <Timeline ctx={ctx} issue={issue} comments={comments} events={listEvents(deps.db, issue.id)} />
            <CommentForm action={`${base}/comment`} csrf={c.get("csrf")} canToggle={canManage(c, ctx, issue)} state={issue.state} isPull={false} signedIn={!!c.get("user")} loginHref={loginHref(c)} />
          </div>
          <aside class="col-md-3 flex-shrink-0" aria-label="Issue details">
            <LabelsSidebar ctx={ctx} issue={issue} allLabels={listLabels(deps.db, ctx.repo.id)} canEdit={can(ctx.access, "write")} csrf={c.get("csrf")} action={`${base}/labels`} />
            <Participants names={participants(issue, comments)} />
          </aside>
        </div>
      </>,
    );
  }));

  /** Comment, close or reopen — shared by issues and pull requests. */
  const commentHandler = (kind: "issues" | "pull") =>
    withRepo(deps, "read", async (c, ctx) => {
      const user = c.get("user");
      if (!user) return loginRedirect(c);
      const issue = loadIssue(c, ctx);
      if (!issue || issue.isPull !== (kind === "pull")) return notFound(c);
      const f = await form(c);
      const action = field(f, "action");
      const body = field(f, "body");
      if ((action === "close" || action === "reopen") && !canManage(c, ctx, issue)) {
        return renderError(c, 403, "Only the author and collaborators with write access can change this.");
      }
      if (body.trim()) addComment(deps.db, issue.id, user.id, body);
      else if (action === "comment") throw new ValidationError("Comment can't be blank");
      if (action === "close") setIssueState(deps.db, issue.id, "closed", user.id);
      if (action === "reopen") setIssueState(deps.db, issue.id, "open", user.id);
      return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, kind, String(issue.number)));
    });
  app.post(`${R}/issues/:n/comment`, commentHandler("issues"));
  app.post(`${R}/pull/:n/comment`, commentHandler("pull"));

  const labelsHandler = (kind: "issues" | "pull") =>
    withRepo(deps, "write", async (c, ctx) => {
      const issue = loadIssue(c, ctx);
      if (!issue || issue.isPull !== (kind === "pull")) return notFound(c);
      const ids = fields(await form(c), "label").map(Number).filter(Number.isInteger);
      setIssueLabels(deps.db, ctx.repo.id, issue.id, ids);
      return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, kind, String(issue.number)));
    });
  app.post(`${R}/issues/:n/labels`, labelsHandler("issues"));
  app.post(`${R}/pull/:n/labels`, labelsHandler("pull"));

  app.post(`${R}/issues/:n/edit`, withRepo(deps, "read", async (c, ctx) => {
    const issue = loadIssue(c, ctx);
    if (!issue) return notFound(c);
    if (!canManage(c, ctx, issue)) return renderError(c, 403, "You can't edit this issue.");
    const f = await form(c);
    updateIssue(deps.db, issue.id, { title: field(f, "title"), body: field(f, "body") });
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, issue.isPull ? "pull" : "issues", String(issue.number)));
  }));

  const labelsPage = (c: Context<Env>, ctx: RepoCtx, error?: string) => {
    const labels = listLabels(deps.db, ctx.repo.id);
    const counts = labelCounts(deps.db, ctx.repo.id);
    const canEdit = can(ctx.access, "write");
    const { owner, name } = ctx.repo;
    return repoPage(
      c,
      ctx,
      "issues",
      `Labels · ${owner}/${name}`,
      <>
        <h1 class="f3 text-normal mb-3">Labels</h1>
        <Flash error={error} />
        {canEdit && (
          <form method="post" action={repoUrl(owner, name, "labels")} class="Box p-3 mb-3 d-flex flex-wrap flex-items-end" style="gap:8px">
            <CsrfField csrf={c.get("csrf")} />
            <div class="form-group my-0 flex-auto">
              <div class="form-group-header"><label for="label-name">Label name</label></div>
              <div class="form-group-body"><input class="form-control input-block" id="label-name" name="name" required maxlength={50} /></div>
            </div>
            <div class="form-group my-0">
              <div class="form-group-header"><label for="label-color">Color</label></div>
              <div class="form-group-body"><input class="form-control" id="label-color" name="color" type="color" value="#ededed" style="width:80px;height:32px;padding:2px" /></div>
            </div>
            <button class="btn btn-primary" type="submit">Create label</button>
          </form>
        )}
        <div class="Box">
          <div class="Box-header"><h2 class="Box-title">{labels.length} labels</h2></div>
          {labels.map((l) => (
            <div class="Box-row d-flex flex-items-center">
              <span class="col-4"><LabelChip label={l} href={`${repoUrl(owner, name, "issues")}?label=${encodeURIComponent(l.name)}`} /></span>
              <span class="flex-auto f6 color-fg-muted">{counts.get(l.id) ?? 0} open</span>
              {canEdit && (
                <form method="post" action={repoUrl(owner, name, "labels", String(l.id), "delete")}>
                  <CsrfField csrf={c.get("csrf")} />
                  <button class="btn btn-sm btn-danger" type="submit" data-confirm={`Delete the "${l.name}" label?`}>Delete</button>
                </form>
              )}
            </div>
          ))}
        </div>
      </>,
      error ? 400 : 200,
    );
  };

  app.get(`${R}/labels`, withRepo(deps, "read", (c, ctx) => labelsPage(c, ctx)));
  app.post(`${R}/labels`, withRepo(deps, "write", async (c, ctx) => {
    const f = await form(c);
    try {
      createLabel(deps.db, ctx.repo.id, field(f, "name"), field(f, "color"));
      return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "labels"));
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return labelsPage(c, ctx, err.message);
    }
  }));
  app.post(`${R}/labels/:id/delete`, withRepo(deps, "write", (c, ctx) => {
    deleteLabel(deps.db, ctx.repo.id, Number(c.req.param("id")));
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "labels"));
  }));
}
