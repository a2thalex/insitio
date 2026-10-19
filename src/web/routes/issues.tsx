import type { Context, Hono } from "hono";
import type { Deps } from "../../deps.js";
import { ValidationError } from "../../services/errors.js";
import { assertCanTalk, listMilestones, listTemplates, reactionSummary, recordMentions, REACTION_GLYPH, REACTIONS, type ReactionEmoji } from "../../services/issueExtras.js";
import { assertNotBlocked, listSavedReplies, savedReplyBody } from "../../services/account.js";
import { deliverWebhooks } from "../../services/repoAdmin.js";
import {
  PER_PAGE, addComment, createIssue, createLabel, deleteLabel, getIssue, labelCounts, listComments, listEvents, listIssues, listPinned,
  listLabels, participants, setIssueLabels, setIssueState, updateIssue, type CloseReason, type Issue,
} from "../../services/issues.js";
import { can } from "../../services/permissions.js";
import { getUserByName } from "../../services/users.js";
import { getPull } from "../../services/pulls.js";
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

function ReactionBar({ action, csrf, summary }: { action: string; csrf: string; summary: { emoji: ReactionEmoji; count: number; mine: boolean }[] }) {
  return (
    <form method="post" action={action} class="d-flex flex-wrap mt-2" style="gap:4px">
      <CsrfField csrf={csrf} />
      {REACTIONS.map((emoji) => {
        const row = summary.find((item) => item.emoji === emoji);
        return (
          <button class={`btn btn-sm ${row?.mine ? "selected" : ""}`} type="submit" name="emoji" value={emoji} aria-pressed={row?.mine ? "true" : "false"} aria-label={`${REACTION_GLYPH[emoji]} ${row?.count ?? 0}`}>
            {REACTION_GLYPH[emoji]} {row?.count ? row.count : ""}
          </button>
        );
      })}
    </form>
  );
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

  app.get(`${R}/issues`, withRepo(deps, "read", async (c, ctx) => {
    const { owner, name } = ctx.repo;
    const state = c.req.query("state") === "closed" ? "closed" : "open";
    const q = c.req.query("q") ?? "";
    const labelName = c.req.query("label") ?? "";
    const query = new URL(c.req.url).searchParams;
    const assigneeName = query.has("no:assignee") ? "none" : (c.req.query("assignee") ?? "");
    const milestoneName = query.has("no:milestone") ? "none" : (c.req.query("milestone") ?? "");
    const rawReason = c.req.query("reason");
    const reason: CloseReason | undefined = rawReason === "not_planned" ? "not_planned" : rawReason === "completed" ? "completed" : undefined;
    const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
    const labels = listLabels(deps.db, ctx.repo.id);
    const label = labels.find((l) => l.name.toLowerCase() === labelName.toLowerCase());
    if (labelName && !label) return notFound(c, "That label");
    const milestones = listMilestones(deps.db, ctx.repo.id, "all");
    const milestone = milestoneName && milestoneName !== "none" ? milestones.find((m) => m.title.toLowerCase() === milestoneName.toLowerCase()) : undefined;
    if (milestoneName && milestoneName !== "none" && !milestone) return notFound(c, "That milestone");
    const assignee = assigneeName && assigneeName !== "none" ? getUserByName(deps.db, assigneeName) : undefined;
    if (assigneeName && assigneeName !== "none" && !assignee) return notFound(c, "That user");
    const filter = {
      isPull: false as const,
      labelId: label?.id,
      q,
      page,
      assigneeId: assigneeName === "none" ? "none" as const : assignee?.id,
      milestoneId: milestoneName === "none" ? "none" as const : milestone?.id,
      reason,
    };
    const list = listIssues(deps.db, ctx.repo.id, { ...filter, state });
    const open = listIssues(deps.db, ctx.repo.id, { ...filter, state: "open", page: 1 }).total;
    const closed = listIssues(deps.db, ctx.repo.id, { ...filter, state: "closed", page: 1 }).total;
    const pinned = listPinned(deps.db, ctx.repo.id);
    const href = (p: Record<string, string | number>) =>
      `${repoUrl(owner, name, "issues")}?${new URLSearchParams(Object.entries({ state, q, label: label?.name ?? "", assignee: assigneeName, milestone: milestoneName, reason: reason ?? "", ...p }).filter(([, v]) => v !== "" && v !== undefined).map(([k, v]) => [k, String(v)]))}`;
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
          <a class="btn" href={repoUrl(owner, name, "milestones")}><Octicon name="milestone" class="mr-1" />Milestones</a>
          {c.get("user") && <a class="btn btn-primary" href={repoUrl(owner, name, "issues", "new")}>New issue</a>}
        </div>
        {label && (
          <p class="mb-3 f6">
            Filtered by label <LabelChip label={label} /> · <a href={href({ label: "" })}>Clear filter</a>
          </p>
        )}
        {pinned.length > 0 && !q && !label && !assigneeName && !milestoneName && !reason && (
          <div class="Box mb-3">
            <div class="Box-header">Pinned</div>
            {pinned.map((i) => <IssueRow ctx={ctx} issue={i} state={i.state} href={repoUrl(owner, name, "issues", String(i.number))} />)}
          </div>
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
    const templates = listTemplates(deps.db, ctx.repo.id);
    const chosen = templates.find((t) => String(t.id) === (c.req.query("template") ?? ""));
    if (templates.length && !chosen && c.req.query("blank") !== "1") {
      return repoPage(
        c,
        ctx,
        "issues",
        `New issue · ${ctx.repo.owner}/${ctx.repo.name}`,
        <div>
          <h1 class="f3 text-normal mb-3">Choose a template</h1>
          <div class="Box">
            {templates.map((t) => (
              <a class="Box-row d-block" href={`${repoUrl(ctx.repo.owner, ctx.repo.name, "issues", "new")}?template=${t.id}`}>
                <strong>{t.name}</strong>
                {t.about && <div class="f6 color-fg-muted">{t.about}</div>}
              </a>
            ))}
            <a class="Box-row d-block" href={`${repoUrl(ctx.repo.owner, ctx.repo.name, "issues", "new")}?blank=1`}>Open a blank issue</a>
          </div>
        </div>,
      );
    }
    return repoPage(c, ctx, "issues", `New issue · ${ctx.repo.owner}/${ctx.repo.name}`, <NewIssueForm ctx={ctx} csrf={c.get("csrf")} title={chosen?.title ?? ""} body={chosen?.body ?? ""} />);
  }));

  app.post(`${R}/issues`, withRepo(deps, "read", async (c, ctx) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const f = await form(c);
    try {
      assertNotBlocked(deps.db, user.id, ctx.repo.ownerId);
      const issue = createIssue(deps.db, ctx.repo.id, user.id, { title: field(f, "title"), body: field(f, "body") });
      recordMentions(deps.db, user, ctx.repo, `${field(f, "title")}\n${field(f, "body")}`, { kind: "issue", number: issue.number });
      await deliverWebhooks(deps, ctx.repo, "issues", { action: "opened", number: issue.number, title: issue.title });
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
            {issue.closeReason === "completed" && <span class="Label mr-2">Completed</span>}
            {issue.closeReason === "not_planned" && <span class="Label mr-2">Not planned</span>}
            {issue.locked && <span class="Label mr-2">Locked</span>}
            <span>
              <a class="text-bold Link--secondary" href={`/${issue.author}`}>{issue.author}</a> opened this issue · {comments.length} comment{comments.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <div class="d-md-flex">
          <div class="flex-auto min-width-0 mr-md-4">
            <Timeline
              ctx={ctx}
              issue={issue}
              comments={comments}
              events={listEvents(deps.db, issue.id)}
              openingExtra={
                <>
                  {canManage(c, ctx, issue) && (
                    <details class="mt-2">
                      <summary class="btn btn-sm">Edit</summary>
                      <form method="post" action={`${base}/edit`} class="mt-2">
                        <CsrfField csrf={c.get("csrf")} />
                        <input class="form-control mb-2" name="title" value={issue.title} aria-label="Title" required maxlength={256} />
                        <textarea class="form-control" name="body" rows={6} aria-label="Description">{issue.body}</textarea>
                        <button class="btn btn-sm btn-primary mt-2" type="submit">Save</button>
                      </form>
                    </details>
                  )}
                  <ReactionBar action={`${base}/reactions`} csrf={c.get("csrf")} summary={reactionSummary(deps.db, "issue", issue.id, c.get("user")?.id ?? null)} />
                </>
              }
              commentExtra={(comment) => {
                const viewer = c.get("user");
                const editable = !!viewer && (viewer.id === comment.authorId || ctx.access === "admin");
                return (
                  <>
                    <ReactionBar action={`${base}/comments/${comment.id}/reactions`} csrf={c.get("csrf")} summary={reactionSummary(deps.db, "comment", comment.id, viewer?.id ?? null)} />
                    {editable && (
                      <details class="mt-2">
                        <summary class="btn btn-sm">Edit</summary>
                        <form method="post" action={`${base}/comments/${comment.id}`} class="mt-2">
                          <CsrfField csrf={c.get("csrf")} />
                          <textarea class="form-control" name="body" rows={4}>{comment.body}</textarea>
                          <div class="d-flex mt-2" style="gap:8px">
                            <button class="btn btn-sm btn-primary" type="submit" name="action" value="edit">Update comment</button>
                            <button class="btn btn-sm btn-danger" type="submit" name="action" value="delete" data-confirm="Delete this comment?">Delete</button>
                          </div>
                        </form>
                      </details>
                    )}
                  </>
                );
              }}
            />
            <CommentForm action={`${base}/comment`} csrf={c.get("csrf")} canToggle={canManage(c, ctx, issue)} state={issue.state} isPull={false} signedIn={!!c.get("user")} loginHref={loginHref(c)} locked={issue.locked} canWrite={can(ctx.access, "write")} replies={c.get("user") ? listSavedReplies(deps.db, c.get("user")!.id) : []} />
          </div>
          <aside class="col-md-3 flex-shrink-0" aria-label="Issue details">
            <LabelsSidebar ctx={ctx} issue={issue} allLabels={listLabels(deps.db, ctx.repo.id)} canEdit={can(ctx.access, "write")} csrf={c.get("csrf")} action={`${base}/labels`} />
            <div class="discussion-sidebar-item">
              <div class="discussion-sidebar-heading">Assignees</div>
              {issue.assignees.length === 0 ? <span class="color-fg-muted">No one assigned</span> : issue.assignees.map((a) => <div><a href={`/${a.username}`}>{a.username}</a></div>)}
              {can(ctx.access, "write") && (
                <form method="post" action={`${base}/assignees`} class="mt-2">
                  <CsrfField csrf={c.get("csrf")} />
                  <input class="form-control input-sm mb-1" name="assignees" aria-label="Assignees" value={issue.assignees.map((a) => a.username).join(" ")} />
                  <button class="btn btn-sm" type="submit">Save assignees</button>
                </form>
              )}
            </div>
            <div class="discussion-sidebar-item">
              <div class="discussion-sidebar-heading">Milestone</div>
              <form method="post" action={`${base}/milestone`}>
                <CsrfField csrf={c.get("csrf")} />
                <select class="form-select" name="milestone" aria-label="Milestone" disabled={!can(ctx.access, "write")}>
                  <option value="">No milestone</option>
                  {listMilestones(deps.db, ctx.repo.id, "all").map((m) => <option value={String(m.number)} selected={issue.milestoneId === m.id}>{m.title}</option>)}
                </select>
                {can(ctx.access, "write") && <button class="btn btn-sm mt-2" type="submit">Save</button>}
              </form>
            </div>
            {can(ctx.access, "write") && (
              <div class="discussion-sidebar-item d-flex" style="gap:8px">
                <form method="post" action={`${base}/lock`}><CsrfField csrf={c.get("csrf")} /><button class="btn btn-sm" type="submit">{issue.locked ? "Unlock" : "Lock"} conversation</button></form>
                <form method="post" action={`${base}/pin`}><CsrfField csrf={c.get("csrf")} /><button class="btn btn-sm" type="submit">{issue.pinnedAt ? "Unpin" : "Pin"}</button></form>
              </div>
            )}
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
      assertNotBlocked(deps.db, user.id, ctx.repo.ownerId);
      let body = field(f, "body");
      if (!body.trim() && field(f, "reply")) body = savedReplyBody(deps.db, user.id, Number(field(f, "reply"))) ?? "";
      if (action === "close" || action === "reopen") {
        if (!canManage(c, ctx, issue)) return renderError(c, 403, "Only the author and collaborators with write access can change this.");
        if (issue.isPull && getPull(deps.db, ctx.repo.id, issue.number)?.mergedAt) {
          return renderError(c, 409, "This pull request was merged, so it can't be closed or reopened.");
        }
      }
      if (body.trim()) {
        assertCanTalk(issue, ctx.access);
        addComment(deps.db, issue.id, user.id, body);
        recordMentions(deps.db, user, ctx.repo, body, { kind: issue.isPull ? "pull" : "issue", number: issue.number });
      } else if (action === "comment") throw new ValidationError("Comment can't be blank");
      const reason = field(f, "reason") === "not_planned" ? "not_planned" : "completed";
      if (action === "close") setIssueState(deps.db, issue.id, "closed", user.id, issue.isPull ? undefined : reason);
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
    const user = c.get("user");
    if (!user || !canManage(c, ctx, issue)) return renderError(c, 403, "You can't edit this issue.");
    const f = await form(c);
    updateIssue(deps.db, issue.id, { title: field(f, "title"), body: field(f, "body") });
    recordMentions(deps.db, user, ctx.repo, `${field(f, "title")}\n${field(f, "body")}`, { kind: issue.isPull ? "pull" : "issue", number: issue.number });
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
