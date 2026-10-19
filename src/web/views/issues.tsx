import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { Comment, Issue, IssueEvent, Label } from "../../services/issues.js";
import { renderMarkdown } from "../markdown.js";
import type { RepoCtx } from "../repoContext.js";
import { repoUrl } from "../paths.js";
import { Avatar, CsrfField, LabelChip, Octicon, TimeAgo } from "./layout.js";

export type IssueState = "open" | "closed" | "merged";

const STATE = {
  open: { cls: "State--open", icon: "issue-opened", prIcon: "git-pull-request", label: "Open" },
  closed: { cls: "State--closed", icon: "issue-closed", prIcon: "git-pull-request-closed", label: "Closed" },
  merged: { cls: "State--merged", icon: "git-merge", prIcon: "git-merge", label: "Merged" },
} as const;

export function StateBadge({ state, isPull }: { state: IssueState; isPull: boolean }) {
  const s = STATE[state];
  return (
    <span class={`State ${s.cls} mr-2`} title={`Status: ${s.label}`}>
      <Octicon name={isPull ? s.prIcon : s.icon} class="mr-1" />
      {s.label}
    </span>
  );
}

/** Small state icon for list rows; closed issues are "done" purple like GitHub's completed state. */
export function StateIcon({ state, isPull }: { state: IssueState; isPull: boolean }) {
  const s = STATE[state];
  const color = state === "open" ? "color-fg-success" : state === "merged" || !isPull ? "color-fg-done" : "color-fg-danger";
  return <Octicon name={isPull ? s.prIcon : s.icon} class={color} />;
}

export function issueMarkdown(ctx: RepoCtx, md: string) {
  return renderMarkdown(md, { repo: { owner: ctx.repo.owner, name: ctx.repo.name, ref: ctx.repo.defaultBranch, dir: "" } });
}

function CommentBox({ ctx, author, createdAt, body, isIssueAuthor, verb = "commented", extra }: { ctx: RepoCtx; author: string; createdAt: number; body: string; isIssueAuthor: boolean; verb?: string; extra?: Child }) {
  return (
    <div class="timeline-row mb-3">
      <a class="timeline-avatar d-none d-md-block" href={`/${author}`}><Avatar name={author} size={40} /></a>
      <div class="timeline-comment flex-auto min-width-0">
        <div class={`timeline-comment-header d-flex flex-items-center ${isIssueAuthor ? "is-author" : ""}`}>
          <span class="flex-auto">
            <a class="text-bold Link--primary" href={`/${author}`}>{author}</a> {verb} <TimeAgo ts={createdAt} />
          </span>
          {isIssueAuthor && <span class="Label ml-2">Author</span>}
        </div>
        <div class="timeline-comment-body markdown-body comment-body">
          {body.trim() ? raw(issueMarkdown(ctx, body)) : <p class="color-fg-muted"><em>No description provided.</em></p>}
          {extra}
        </div>
      </div>
    </div>
  );
}

const EVENT_TEXT: Record<IssueEvent["kind"], { icon: string; text: string }> = {
  closed: { icon: "issue-closed", text: "closed this" },
  reopened: { icon: "issue-reopened", text: "reopened this" },
  merged: { icon: "git-merge", text: "merged commit" },
  head_deleted: { icon: "git-branch", text: "deleted the branch" },
  locked: { icon: "lock", text: "locked this conversation" },
  unlocked: { icon: "unlock", text: "unlocked this conversation" },
  pinned: { icon: "pin", text: "pinned this" },
  unpinned: { icon: "pin", text: "unpinned this" },
  assigned: { icon: "person", text: "assigned" },
  unassigned: { icon: "person", text: "unassigned" },
  milestoned: { icon: "milestone", text: "added this to" },
  demilestoned: { icon: "milestone", text: "removed this from a milestone" },
  mentioned: { icon: "bookmark", text: "mentioned this in" },
};

function EventItem({ ctx, event }: { ctx: RepoCtx; event: IssueEvent }) {
  const t = EVENT_TEXT[event.kind];
  return (
    <div class="TimelineItem ml-md-6">
      <div class={`TimelineItem-badge ${event.kind}`}>
        <Octicon name={t.icon} />
      </div>
      <div class="TimelineItem-body">
        {event.actor && <a class="text-bold Link--primary mr-1" href={`/${event.actor}`}>{event.actor}</a>}
        {t.text}
        {event.kind === "merged" && event.detail && (
          <a class="text-mono ml-1" href={repoUrl(ctx.repo.owner, ctx.repo.name, "commit", event.detail)}>{event.detail.slice(0, 7)}</a>
        )}
        {event.kind === "closed" && event.detail === "not_planned" && " as not planned"}
        {(event.kind === "assigned" || event.kind === "unassigned" || event.kind === "milestoned") && event.detail && ` ${event.detail}`}
        {event.kind === "mentioned" && event.detail.startsWith("commit:") && (
          <a class="text-mono ml-1" href={repoUrl(ctx.repo.owner, ctx.repo.name, "commit", event.detail.slice(7))}>{event.detail.slice(7, 14)}</a>
        )}
        {event.kind === "mentioned" && event.detail.startsWith("issue:") && ` #${event.detail.slice(6)}`}
        {event.kind === "mentioned" && event.detail.startsWith("pull:") && ` pull request #${event.detail.slice(5)}`}{" "}
        <TimeAgo ts={event.createdAt} />
      </div>
    </div>
  );
}

/** The opening post, comments and state events in time order. Extra items (like commits on a PR) can be merged in. */
export function Timeline({ ctx, issue, comments, events, extra = [], openingExtra, commentExtra }: { ctx: RepoCtx; issue: Issue; comments: Comment[]; events: IssueEvent[]; extra?: { at: number; node: Child }[]; openingExtra?: Child; commentExtra?: (comment: Comment) => Child }) {
  const items: { at: number; order: number; node: Child }[] = [
    ...comments.map((cm) => ({
      at: cm.createdAt,
      order: 1,
      node: <CommentBox ctx={ctx} author={cm.author} createdAt={cm.createdAt} body={cm.body} isIssueAuthor={cm.author === issue.author} extra={commentExtra?.(cm)} />,
    })),
    ...events.map((e) => ({ at: e.createdAt, order: 2, node: <EventItem ctx={ctx} event={e} /> })),
    ...extra.map((x) => ({ at: x.at, order: 0, node: x.node })),
  ].sort((a, b) => a.at - b.at || a.order - b.order);
  return (
    <div>
      <CommentBox ctx={ctx} author={issue.author} createdAt={issue.createdAt} body={issue.body} isIssueAuthor={true} verb="opened this" extra={openingExtra} />
      {items.map((i) => i.node)}
    </div>
  );
}

export function CommentForm({ action, csrf, canToggle, state, isPull, signedIn, loginHref, locked = false, canWrite = false }: { action: string; csrf: string; canToggle: boolean; state: "open" | "closed"; isPull: boolean; signedIn: boolean; loginHref: string; locked?: boolean; canWrite?: boolean }) {
  if (!signedIn) {
    return (
      <div class="Box p-3 text-center color-fg-muted mt-3">
        <a href={loginHref}>Sign in</a> to join this conversation.
      </div>
    );
  }
  if (locked && !canWrite) {
    return <div class="flash mt-3" role="status">This conversation has been locked.</div>;
  }
  const noun = isPull ? "pull request" : "issue";
  return (
    <form method="post" action={action} class="mt-4 border-top pt-4">
      <CsrfField csrf={csrf} />
      <label for="comment-body" class="d-block text-bold mb-2">Add a comment</label>
      <textarea class="form-control input-block" id="comment-body" name="body" placeholder="Leave a comment (Markdown supported)" style="min-height:120px"></textarea>
      <div class="d-flex flex-justify-end mt-2" style="gap:8px">
        {canToggle && state === "open" && !isPull && (
          <select class="form-select" name="reason" aria-label="Close reason">
            <option value="completed">Completed</option>
            <option value="not_planned">Not planned</option>
          </select>
        )}
        {canToggle && (
          <button class="btn" type="submit" name="action" value={state === "open" ? "close" : "reopen"}>
            <Octicon name={state === "open" ? (isPull ? "git-pull-request-closed" : "issue-closed") : "issue-reopened"} class={`mr-1 ${state === "open" ? "color-fg-done" : "color-fg-success"}`} />
            {state === "open" ? `Close ${noun}` : `Reopen ${noun}`}
          </button>
        )}
        <button class="btn btn-primary" type="submit" name="action" value="comment">Comment</button>
      </div>
    </form>
  );
}

export function LabelsSidebar({ ctx, issue, allLabels, canEdit, csrf, action }: { ctx: RepoCtx; issue: Issue; allLabels: Label[]; canEdit: boolean; csrf: string; action: string }) {
  const selected = new Set(issue.labels.map((l) => l.id));
  const base = repoUrl(ctx.repo.owner, ctx.repo.name, issue.isPull ? "pulls" : "issues");
  return (
    <div class="discussion-sidebar-item">
      <div class="d-flex flex-items-center flex-justify-between">
        <div class="discussion-sidebar-heading">Labels</div>
        {canEdit && (
          <details class="details-reset details-overlay position-relative">
            <summary class="btn-octicon" aria-label="Edit labels"><Octicon name="gear" /></summary>
            <div class="dropdown-menu dropdown-menu-sw p-2" style="width:240px;top:24px">
              <form method="post" action={action}>
                <CsrfField csrf={csrf} />
                {allLabels.length === 0 && <p class="color-fg-muted f6 p-2">No labels yet.</p>}
                {allLabels.map((l) => (
                  <label class="d-flex flex-items-center p-1 f6">
                    <input type="checkbox" name="label" value={String(l.id)} checked={selected.has(l.id)} class="mr-2" />
                    <span class="d-inline-block mr-2 rounded-2" style={`width:12px;height:12px;background:${l.color}`}></span>
                    {l.name}
                  </label>
                ))}
                <div class="d-flex flex-justify-between mt-2">
                  <a class="f6 p-1" href={repoUrl(ctx.repo.owner, ctx.repo.name, "labels")}>Edit labels</a>
                  <button class="btn btn-sm btn-primary" type="submit">Apply</button>
                </div>
              </form>
            </div>
          </details>
        )}
      </div>
      {issue.labels.length === 0 ? (
        <span class="color-fg-muted">None yet</span>
      ) : (
        <div class="d-flex flex-wrap" style="gap:4px">
          {issue.labels.map((l) => <LabelChip label={l} href={`${base}?label=${encodeURIComponent(l.name)}`} />)}
        </div>
      )}
    </div>
  );
}

export function Participants({ names }: { names: string[] }) {
  return (
    <div class="discussion-sidebar-item">
      <div class="discussion-sidebar-heading">{names.length} participant{names.length === 1 ? "" : "s"}</div>
      <div class="d-flex flex-wrap" style="gap:4px">
        {names.map((n) => <a href={`/${n}`} title={n}><Avatar name={n} size={26} /></a>)}
      </div>
    </div>
  );
}

export function IssueRow({ ctx, issue, state, href }: { ctx: RepoCtx; issue: Issue; state: IssueState; href: string }) {
  const base = repoUrl(ctx.repo.owner, ctx.repo.name, issue.isPull ? "pulls" : "issues");
  return (
    <div class="Box-row Box-row--hover-gray d-flex">
      <span class="mr-2 mt-1 flex-shrink-0"><StateIcon state={state} isPull={issue.isPull} /></span>
      <div class="flex-auto min-width-0">
        <a class="Link--primary text-bold f5 mr-1" href={href}>{issue.title}</a>
        {!issue.isPull && issue.closeReason === "not_planned" && <span class="Label Label--secondary ml-1">Not planned</span>}
        {!issue.isPull && issue.closeReason === "completed" && state !== "open" && <span class="Label Label--secondary ml-1">Completed</span>}
        {issue.labels.map((l) => <span class="mr-1"><LabelChip label={l} href={`${base}?label=${encodeURIComponent(l.name)}`} /></span>)}
        <div class="f6 color-fg-muted mt-1">
          #{issue.number} {state === "open" ? "opened" : state} <TimeAgo ts={state === "open" ? issue.createdAt : (issue.closedAt ?? issue.updatedAt)} /> by{" "}
          <a class="Link--secondary" href={`/${issue.author}`}>{issue.author}</a>
        </div>
      </div>
      {issue.commentCount > 0 && (
        <a class="Link--secondary f6 ml-3 no-wrap flex-shrink-0" href={href} aria-label={`${issue.commentCount} comments`}>
          <Octicon name="comment" class="mr-1" />
          {issue.commentCount}
        </a>
      )}
    </div>
  );
}
