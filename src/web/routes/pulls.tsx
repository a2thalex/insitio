import type { Context, Hono } from "hono";
import type { Child } from "hono/jsx";
import type { Deps } from "../../deps.js";
import type { DiffFile } from "../../git/diff.js";
import { GitError } from "../../git/run.js";
import { MergeConflictError, RefMovedError, type Commit, type Mergeability } from "../../git/repo.js";
import { ValidationError } from "../../services/errors.js";
import { PER_PAGE, listComments, listEvents, listLabels, participants } from "../../services/issues.js";
import { can } from "../../services/permissions.js";
import { createPull, getPull, listPulls, markMerged, type Pull } from "../../services/pulls.js";
import { applyClosingReferences, assertCanTalk, recordMentions } from "../../services/issueExtras.js";
import {
  currentReviews, listLineComments, listPullTemplates, listReviews, listReviewers, listStatuses, unmetChecks,
} from "../../services/pullExtras.js";
import { authorFor } from "../../services/repos.js";
import type { Env } from "../env.js";
import { raw } from "hono/html";
import { field, form, loginRedirect } from "../middleware.js";
import { blobUrl, commitUrl, encPath, repoUrl, treeUrl } from "../paths.js";
import type { RepoCtx } from "../repoContext.js";
import { notFound, renderError } from "../render.js";
import { CsrfField, Flash, Octicon, Pagination, TimeAgo } from "../views/layout.js";
import { DiffView, Diffstat } from "../views/diff.js";
import { CommentForm, IssueRow, LabelsSidebar, Participants, StateBadge, Timeline, issueMarkdown, type IssueState } from "../views/issues.js";
import { CommitAuthor, RefPicker } from "../views/repo.js";
import { canManage } from "./issues.js";
import { repoPage, withRepo } from "./code.js";

type Changes = { commits: Commit[]; files: DiffFile[]; truncated: boolean };

function pullState(p: Pull): IssueState {
  return p.mergedAt ? "merged" : p.state;
}

/** A PR's commits and diff. A merge commit uses its two parents. A squash or rebase uses the base it was computed from. */
export async function pullChanges(ctx: RepoCtx, p: Pull): Promise<Changes> {
  let base = p.baseRef;
  let head = p.headRef;
  if (p.mergeCommit) {
    const meta = await ctx.git.commit(p.mergeCommit);
    if (meta.parents.length >= 2) {
      base = `${p.mergeCommit}^1`;
      head = `${p.mergeCommit}^2`;
    } else {
      base = p.mergeBaseSha ?? meta.parents[0] ?? p.baseRef;
      head = p.mergeCommit;
    }
  }
  const cmp = await ctx.git.compare(base, head);
  return { commits: cmp.commits, files: cmp.files, truncated: cmp.diffTruncated };
}

export function diffLineText(files: DiffFile[], path: string, side: "left" | "right", line: number): string | null {
  for (const file of files) {
    if ((side === "left" ? file.oldPath : file.newPath) !== path) continue;
    for (const hunk of file.hunks) {
      for (const item of hunk.lines) {
        if ((side === "left" ? item.oldNo : item.newNo) === line) return item.text;
      }
    }
  }
  return null;
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function BranchName({ name }: { name: string }) {
  return <span class="branch-name">{name}</span>;
}

function CommitList({ ctx, commits }: { ctx: RepoCtx; commits: Commit[] }) {
  const { owner, name } = ctx.repo;
  if (commits.length === 0) return <div class="Box-row color-fg-muted">No commits.</div>;
  return (
    <>
      {commits.map((cm) => (
        <div class="Box-row d-flex flex-items-center">
          <Octicon name="git-commit" class="color-fg-muted mr-2" />
          <div class="flex-auto min-width-0">
            <a class="Link--primary text-bold" href={commitUrl(owner, name, cm.sha)}>{cm.subject}</a>
            <div class="f6 color-fg-muted mt-1"><CommitAuthor ctx={ctx} commit={cm} size={16} /> committed <TimeAgo ts={cm.date} /></div>
          </div>
          <a class="text-mono f6 Link--secondary ml-3" href={commitUrl(owner, name, cm.sha)}>{cm.shortSha}</a>
          <a class="btn btn-sm ml-2" href={treeUrl(owner, name, cm.sha)} aria-label="Browse repository at this point"><Octicon name="code" /></a>
        </div>
      ))}
    </>
  );
}

function MergeBox({ ctx, pull, status, canMerge, csrf, signedIn, blocked }: { ctx: RepoCtx; pull: Pull; status: Mergeability | "merged" | "closed"; canMerge: boolean; csrf: string; signedIn: boolean; blocked?: string }) {
  const base = repoUrl(ctx.repo.owner, ctx.repo.name, "pull", String(pull.number));
  if (status === "merged") {
    return (
      <div class="merge-box is-merged p-3 d-flex flex-items-center mt-3">
        <Octicon name="git-merge" size={24} class="color-fg-done mr-3" />
        <div>
          <strong>Pull request successfully merged and closed</strong>
          <div class="f6 color-fg-muted">
            The <BranchName name={pull.headRef} /> branch was merged into <BranchName name={pull.baseRef} />.
          </div>
        </div>
      </div>
    );
  }
  if (status === "closed") {
    return (
      <div class="merge-box p-3 d-flex flex-items-center mt-3">
        <Octicon name="git-pull-request-closed" size={24} class="color-fg-danger mr-3" />
        <strong>This pull request is closed.</strong>
      </div>
    );
  }
  const messages: Record<Mergeability, { cls: string; icon: string; title: string; detail: string }> = {
    clean: { cls: "is-clean", icon: "check-circle", title: "This branch has no conflicts with the base branch", detail: "Merging can be performed automatically." },
    conflict: { cls: "is-conflict", icon: "alert", title: "This branch has conflicts that must be resolved", detail: "Merge the base branch into this branch locally, fix the conflicts and push." },
    up_to_date: { cls: "", icon: "check-circle", title: "This branch has no new commits", detail: "Everything on this branch is already in the base branch." },
    missing: { cls: "is-conflict", icon: "alert", title: "A branch of this pull request no longer exists", detail: "Restore the branch to merge it." },
  };
  const m = messages[status];
  return (
    <div class={`merge-box ${m.cls} mt-3`}>
      <div class="p-3 d-flex flex-items-start border-bottom">
        <Octicon name={m.icon} size={24} class={`mr-3 ${status === "clean" ? "color-fg-success" : "color-fg-attention"}`} />
        <div>
          <strong>{m.title}</strong>
          <div class="f6 color-fg-muted">{m.detail}</div>
        </div>
      </div>
      <div class="p-3">
        {status === "clean" && canMerge && !blocked ? (
          <form method="post" action={`${base}/merge`}>
            <CsrfField csrf={csrf} />
            <select class="form-select mb-2" name="method" aria-label="Merge method">
              <option value="merge">Create a merge commit</option>
              <option value="squash">Squash and merge</option>
              <option value="rebase">Rebase and merge</option>
            </select>
            {pull.headRef !== ctx.repo.defaultBranch && (
              <label class="d-block mb-2"><input type="checkbox" name="delete_branch" value="1" class="mr-1" />Delete branch</label>
            )}
            <button class="btn btn-primary" type="submit">Merge pull request</button>
          </form>
        ) : status === "clean" && blocked ? (
          <p class="mb-0">{blocked}</p>
        ) : status === "clean" ? (
          <span class="f6 color-fg-muted">{signedIn ? "Only those with write access to this repository can merge pull requests." : "Sign in to merge."}</span>
        ) : (
          <button class="btn btn-primary" type="button" disabled>Merge pull request</button>
        )}
      </div>
    </div>
  );
}

export function pullRoutes(deps: Deps, app: Hono<Env>) {
  const R = "/:owner/:repo";

  app.get(`${R}/pulls`, withRepo(deps, "read", (c, ctx) => {
    const { owner, name } = ctx.repo;
    const state = c.req.query("state") === "closed" ? "closed" : "open";
    const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
    const list = listPulls(deps.db, ctx.repo.id, { state, page });
    const open = listPulls(deps.db, ctx.repo.id, { state: "open", page: 1 }).total;
    const closed = listPulls(deps.db, ctx.repo.id, { state: "closed", page: 1 }).total;
    const href = (s: string, p = 1) => `${repoUrl(owner, name, "pulls")}?state=${s}${p > 1 ? `&page=${p}` : ""}`;
    return repoPage(
      c,
      ctx,
      "pulls",
      `Pull requests · ${owner}/${name}`,
      <>
        <div class="d-flex flex-items-center mb-3">
          <h1 class="f3 text-normal flex-auto">Pull requests</h1>
          {c.get("user") && <a class="btn btn-primary" href={repoUrl(owner, name, "compare")}>New pull request</a>}
        </div>
        <div class="Box">
          <div class="Box-header d-flex">
            <nav class="d-flex" aria-label="Filter pull requests by state" style="gap:16px">
              <a class={state === "open" ? "Link--primary text-bold" : "Link--secondary"} href={href("open")} aria-current={state === "open" ? "page" : undefined}>
                <Octicon name="git-pull-request" class="mr-1" />{open} Open
              </a>
              <a class={state === "closed" ? "Link--primary text-bold" : "Link--secondary"} href={href("closed")} aria-current={state === "closed" ? "page" : undefined}>
                <Octicon name="check" class="mr-1" />{closed} Closed
              </a>
            </nav>
          </div>
          {list.items.length === 0 ? (
            <div class="blankslate">
              <Octicon name="git-pull-request" size={24} />
              <h3 class="blankslate-heading">There aren't any {state} pull requests.</h3>
              <p>Push a branch, then compare it with the default branch to open one.</p>
            </div>
          ) : (
            list.items.map((p) => <IssueRow ctx={ctx} issue={p} state={pullState(p)} href={repoUrl(owner, name, "pull", String(p.number))} />)
          )}
        </div>
        <Pagination page={page} total={list.total} perPage={PER_PAGE} href={(p) => href(state, p)} />
      </>,
    );
  }));

  async function comparePage(c: Context<Env>, ctx: RepoCtx, baseRef: string, headRef: string, error?: string, values?: { title: string; body: string }) {
    const { owner, name } = ctx.repo;
    const branches = (await ctx.git.branches()).map((b) => b.name);
    const known = branches.includes(baseRef) && branches.includes(headRef);
    const cmp = known && baseRef !== headRef ? await ctx.git.compare(baseRef, headRef) : null;
    const status = cmp ? await ctx.git.mergeability(baseRef, headRef) : null;
    const existing = cmp ? listPulls(deps.db, ctx.repo.id, { state: "open", page: 1 }).items.find((p) => p.baseRef === baseRef && p.headRef === headRef) : undefined;
    const compareHref = (b: string, h: string) => repoUrl(owner, name, "compare", `${encPath(b)}...${encPath(h)}`);
    const templates = listPullTemplates(deps.db, ctx.repo.id);
    const chosen = templates.find((template) => String(template.id) === (c.req.query("template") ?? ""));
    const showChooser = templates.length > 0 && !chosen && c.req.query("blank") !== "1" && !values;
    const defaultTitle = chosen?.title || (cmp?.commits.length === 1 ? cmp.commits[0].subject : headRef.replace(/[-_/]+/g, " ").replace(/^\w/, (s) => s.toUpperCase()));
    const defaultBody = chosen?.body ?? "";
    let body: Child;
    if (!known) body = <div class="blankslate Box"><h3 class="blankslate-heading">Choose two branches to see what changed.</h3></div>;
    else if (baseRef === headRef) body = <div class="blankslate Box"><h3 class="blankslate-heading">Choose different branches to compare.</h3></div>;
    else if (cmp!.commits.length === 0) {
      body = (
        <div class="blankslate Box">
          <h3 class="blankslate-heading">There isn't anything to compare.</h3>
          <p><BranchName name={baseRef} /> is up to date with all commits from <BranchName name={headRef} />.</p>
        </div>
      );
    } else {
      body = (
        <>
          {existing ? (
            <div class="flash mb-3">
              A pull request for these branches is already open: <a href={repoUrl(owner, name, "pull", String(existing.number))}>#{existing.number} {existing.title}</a>
            </div>
          ) : c.get("user") && showChooser ? (
            <div class="Box mb-4">
              <div class="Box-header">Choose a template</div>
              {templates.map((template) => (
                <a class="Box-row d-block" href={`${compareHref(baseRef, headRef)}?template=${template.id}`}>
                  <strong>{template.name}</strong>
                  {template.about && <div class="f6 color-fg-muted">{template.about}</div>}
                </a>
              ))}
              <a class="Box-row d-block" href={`${compareHref(baseRef, headRef)}?blank=1`}>Open a blank pull request</a>
            </div>
          ) : c.get("user") ? (
            <form method="post" action={repoUrl(owner, name, "pulls")} class="Box p-3 mb-4">
              <CsrfField csrf={c.get("csrf")} />
              <input type="hidden" name="base" value={baseRef} />
              <input type="hidden" name="head" value={headRef} />
              <Flash error={error} />
              <input class="form-control input-block input-lg mb-2" name="title" value={values?.title ?? defaultTitle} aria-label="Title" required maxlength={256} />
              <textarea class="form-control input-block" name="body" placeholder="Describe your changes (Markdown supported)" aria-label="Description" style="min-height:140px">{values?.body ?? defaultBody}</textarea>
              <label class="d-block mt-2"><input type="checkbox" name="draft" value="1" class="mr-1" />Create as draft</label>
              <div class="d-flex flex-justify-end mt-2">
                <button class="btn btn-primary" type="submit">Create pull request</button>
              </div>
            </form>
          ) : null}
          <div class="Box mb-4">
            <div class="Box-header py-2 f6"><Octicon name="git-commit" class="mr-1" />{plural(cmp!.commits.length, "commit")}</div>
            <CommitList ctx={ctx} commits={cmp!.commits} />
          </div>
          <DiffView files={cmp!.files} truncated={cmp!.diffTruncated} viewFileHref={(f) => (f.status === "deleted" ? null : blobUrl(owner, name, headRef, f.newPath))} />
        </>
      );
    }
    return repoPage(
      c,
      ctx,
      "pulls",
      `Comparing ${baseRef}...${headRef} · ${owner}/${name}`,
      <>
        <h1 class="f3 text-normal mb-1">{cmp && cmp.commits.length ? "Open a pull request" : "Compare changes"}</h1>
        <p class="color-fg-muted mb-3">Choose two branches to see what's changed or to start a new pull request.</p>
        <div class="Box color-bg-subtle p-2 mb-3 d-flex flex-wrap flex-items-center" style="gap:8px">
          <Octicon name="git-compare" class="color-fg-muted" />
          <span class="f6 color-fg-muted">base:</span>
          <RefPicker current={baseRef} branches={branches} tags={[]} hrefFor={(b) => compareHref(b, headRef)} />
          <Octicon name="arrow-left" class="color-fg-muted" />
          <span class="f6 color-fg-muted">compare:</span>
          <RefPicker current={headRef} branches={branches} tags={[]} hrefFor={(h) => compareHref(baseRef, h)} />
          {status && cmp!.commits.length > 0 && (
            <span class={`f6 ml-2 ${status === "clean" ? "color-fg-success" : "color-fg-danger"}`}>
              <Octicon name={status === "clean" ? "check" : "x"} class="mr-1" />
              {status === "clean" ? "Able to merge." : "Can't automatically merge."}
              <span class="color-fg-muted"> {status === "clean" ? "These branches can be automatically merged." : "You can still create the pull request."}</span>
            </span>
          )}
        </div>
        {body}
      </>,
      error ? 400 : 200,
    );
  }

  app.get(`${R}/compare`, withRepo(deps, "read", async (c, ctx) => {
    const branches = await ctx.git.branches();
    const base = ctx.repo.defaultBranch;
    const head = branches.find((b) => b.name !== base)?.name ?? base;
    return comparePage(c, ctx, base, head);
  }));

  app.get(`${R}/compare/:spec{.+}`, withRepo(deps, "read", (c, ctx) => {
    const spec = c.req.param("spec") ?? "";
    const i = spec.indexOf("...");
    const [base, head] = i === -1 ? [ctx.repo.defaultBranch, spec] : [spec.slice(0, i), spec.slice(i + 3)];
    return comparePage(c, ctx, base, head);
  }));

  app.post(`${R}/pulls`, withRepo(deps, "read", async (c, ctx) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const f = await form(c);
    const base = field(f, "base");
    const head = field(f, "head");
    const values = { title: field(f, "title"), body: field(f, "body") };
    try {
      const branches = (await ctx.git.branches()).map((b) => b.name);
      if (!branches.includes(base) || !branches.includes(head)) throw new ValidationError("Both branches must exist in this repository");
      if (base !== head && (await ctx.git.compare(base, head)).commits.length === 0) {
        throw new ValidationError(`${base} is already up to date with ${head}`);
      }
      const pull = createPull(deps.db, ctx.repo.id, user.id, { ...values, baseRef: base, headRef: head, draft: field(f, "draft") === "1" });
      return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "pull", String(pull.number)));
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return comparePage(c, ctx, base, head, err.message, values);
    }
  }));

  type Tab = "conversation" | "commits" | "files";

  async function pullPage(c: Context<Env>, ctx: RepoCtx, tab: Tab) {
    const n = Number(c.req.param("n"));
    const pull = Number.isInteger(n) && n > 0 ? getPull(deps.db, ctx.repo.id, n) : null;
    const { owner, name } = ctx.repo;
    if (!pull) {
      const issueNumber = Number.isInteger(n) && n > 0 ? n : 0;
      return issueNumber ? c.redirect(repoUrl(owner, name, "issues", String(issueNumber))) : notFound(c);
    }
    const changes = await pullChanges(ctx, pull);
    const comments = listComments(deps.db, pull.id);
    const state = pullState(pull);
    const base = repoUrl(owner, name, "pull", String(pull.number));
    const additions = changes.files.reduce((s, f) => s + f.additions, 0);
    const deletions = changes.files.reduce((s, f) => s + f.deletions, 0);
    const tabItem = (t: Tab, href: string, icon: string, label: string, count: number) => (
      <a class="tabnav-tab" href={href} aria-current={tab === t ? "page" : undefined}>
        <Octicon name={icon} class="mr-1" />
        {label} <span class="Counter">{count}</span>
      </a>
    );

    const reviews = listReviews(deps.db, pull.id);
    const reviewers = listReviewers(deps.db, pull.id);
    const headSha = await ctx.git.resolve(pull.headRef);
    const statuses = headSha ? listStatuses(deps.db, ctx.repo.id, headSha) : [];
    const unmet = headSha ? unmetChecks(deps.db, ctx.repo.id, headSha) : [];
    const viewer = c.get("user");
    const canWrite = can(ctx.access, "write");
    const reviewLabel = (reviewState: string) => reviewState === "approve" ? "approved these changes" : reviewState === "changes" ? "requested changes" : "reviewed";

    let content: Child;
    if (tab === "conversation") {
      const status = state === "merged" ? "merged" : state === "closed" ? "closed" : await ctx.git.mergeability(pull.baseRef, pull.headRef);
      const baseSha = await ctx.git.resolve(pull.baseRef);
      const behind = !!baseSha && !!headSha && !(await ctx.git.isAncestor(baseSha, headSha));
      const blocked = pull.draft ? "This pull request is still a draft." : unmet.length ? `Required checks have not passed: ${unmet.join(", ")}` : undefined;
      const extra = [
        ...changes.commits.map((cm) => ({
          at: cm.date,
          node: (
            <div class="TimelineItem TimelineItem--condensed ml-md-6">
              <div class="TimelineItem-badge"><Octicon name="git-commit" /></div>
              <div class="TimelineItem-body d-flex">
                <a class="Link--secondary flex-auto css-truncate css-truncate-target" style="max-width:none" href={commitUrl(owner, name, cm.sha)}>{cm.subject}</a>
                <a class="text-mono f6 Link--secondary ml-2" href={commitUrl(owner, name, cm.sha)}>{cm.shortSha}</a>
              </div>
            </div>
          ),
        })),
        ...reviews.map((review) => ({
          at: review.createdAt,
          node: (
            <div class="TimelineItem ml-md-6">
              <div class="TimelineItem-badge"><Octicon name={review.state === "approve" ? "check" : "comment"} /></div>
              <div class="TimelineItem-body">
                <a class="text-bold" href={`/${review.username}`}>{review.username}</a> {reviewLabel(review.state)}
                {review.body.trim() && <div class="markdown-body mt-2">{raw(issueMarkdown(ctx, review.body))}</div>}
              </div>
            </div>
          ),
        })),
      ];
      content = (
        <div class="d-md-flex">
          <div class="flex-auto min-width-0 mr-md-4">
            <Timeline ctx={ctx} issue={pull} comments={comments} events={listEvents(deps.db, pull.id)} extra={extra} />
            {state === "open" && behind && canWrite && (
              <form method="post" action={`${base}/update`} class="mt-3">
                <CsrfField csrf={c.get("csrf")} />
                <button class="btn" type="submit">Update branch</button>
              </form>
            )}
            <MergeBox ctx={ctx} pull={pull} status={status} canMerge={canWrite} csrf={c.get("csrf")} signedIn={!!viewer} blocked={blocked} />
            {viewer && state === "open" && (
              <form method="post" action={`${base}/reviews`} class="Box p-3 mt-3">
                <CsrfField csrf={c.get("csrf")} />
                <label class="d-block text-bold mb-2" for="review-body">Review</label>
                <textarea class="form-control mb-2" id="review-body" name="body" rows={4} placeholder="Leave a review (Markdown supported)"></textarea>
                <select class="form-select mb-2" name="state" aria-label="Review decision">
                  <option value="comment">Comment</option>
                  {canWrite && <option value="approve">Approve</option>}
                  {canWrite && <option value="changes">Request changes</option>}
                </select>
                <button class="btn btn-primary" type="submit">Submit review</button>
              </form>
            )}
            <CommentForm
              action={`${base}/comment`}
              csrf={c.get("csrf")}
              canToggle={state !== "merged" && canManage(c, ctx, pull)}
              state={pull.state}
              isPull={true}
              signedIn={!!viewer}
              loginHref={`/login?next=${encodeURIComponent(base)}`}
              locked={pull.locked}
              canWrite={canWrite}
            />
          </div>
          <aside class="col-md-3 flex-shrink-0" aria-label="Pull request details">
            <LabelsSidebar ctx={ctx} issue={pull} allLabels={listLabels(deps.db, ctx.repo.id)} canEdit={canWrite} csrf={c.get("csrf")} action={`${base}/labels`} />
            <div class="discussion-sidebar-item">
              <div class="discussion-sidebar-heading">Reviewers</div>
              {reviewers.length === 0 ? <span class="color-fg-muted">No reviews requested</span> : reviewers.map((reviewer) => {
                const decision = currentReviews(reviews).find((review) => review.userId === reviewer.id);
                return <div>{reviewer.username}{decision ? ` · ${reviewLabel(decision.state)}` : ""}</div>;
              })}
              {canWrite && (
                <form method="post" action={`${base}/reviewers`} class="mt-2">
                  <CsrfField csrf={c.get("csrf")} />
                  <input class="form-control input-sm mb-1" name="reviewers" aria-label="Reviewers" value={reviewers.map((reviewer) => reviewer.username).join(" ")} />
                  <button class="btn btn-sm" type="submit">Save reviewers</button>
                </form>
              )}
            </div>
            {statuses.length > 0 && (
              <div class="discussion-sidebar-item">
                <div class="discussion-sidebar-heading">Checks</div>
                {statuses.map((status) => <div class="f6">{status.context}: {status.state}</div>)}
              </div>
            )}
            <Participants names={participants(pull, comments)} />
          </aside>
        </div>
      );
    } else if (tab === "commits") {
      content = <div class="Box"><CommitList ctx={ctx} commits={changes.commits} /></div>;
    } else {
      const ref = pull.mergeCommit ?? pull.headRef;
      const notes = listLineComments(deps.db, pull.id);
      const current = (note: (typeof notes)[number]) => diffLineText(changes.files, note.path, note.side, note.line) === note.lineText;
      const stale = notes.filter((note) => !current(note));
      const noteOn = (path: string, side: "left" | "right", line: number, text: string) =>
        notes.filter((note) => note.path === path && note.side === side && note.line === line && note.lineText === text);
      content = (
        <>
        {stale.length > 0 && (
          <div class="Box mb-3">
            <div class="Box-header">Outdated</div>
            {stale.map((note) => (
              <div class="Box-row">
                <a class="text-bold" href={`/${note.username}`}>{note.username}</a>
                <span class="f6 color-fg-muted ml-2">{note.path}:{note.line}</span>
                <div class="markdown-body">{raw(issueMarkdown(ctx, note.body))}</div>
              </div>
            ))}
          </div>
        )}
        <DiffView
          files={changes.files}
          truncated={changes.truncated}
          viewFileHref={(f) => (f.status === "deleted" ? null : blobUrl(owner, name, ref, f.newPath))}
          lineExtra={(file, line) => {
            const spots = [
              line.oldNo ? { side: "left" as const, line: line.oldNo, path: file.oldPath } : null,
              line.newNo ? { side: "right" as const, line: line.newNo, path: file.newPath } : null,
            ].filter((spot): spot is { side: "left" | "right"; line: number; path: string } => !!spot);
            const shown = spots.flatMap((spot) => noteOn(spot.path, spot.side, spot.line, line.text).map((note) => ({ ...note, side: spot.side })));
            if (!shown.length && !viewer) return null;
            return (
              <>
                {shown.map((note) => (
                  <div class="mb-2">
                    <a class="text-bold" href={`/${note.username}`}>{note.username}</a>
                    <div class="markdown-body">{raw(issueMarkdown(ctx, note.body))}</div>
                    {viewer && (viewer.id === note.userId || ctx.access === "admin") && (
                      <form method="post" action={`${base}/line-comments/${note.id}`} class="mt-1">
                        <CsrfField csrf={c.get("csrf")} />
                        <textarea class="form-control mb-1" name="body" rows={3}>{note.body}</textarea>
                        <button class="btn btn-sm" type="submit" name="action" value="edit">Update</button>
                        <button class="btn btn-sm btn-danger ml-1" type="submit" name="action" value="delete">Delete</button>
                      </form>
                    )}
                  </div>
                ))}
                {viewer && spots[0] && (
                  <details>
                    <summary class="f6">Comment</summary>
                    <form method="post" action={`${base}/line-comments`} class="mt-1">
                      <CsrfField csrf={c.get("csrf")} />
                      <input type="hidden" name="path" value={spots[0].path} />
                      <input type="hidden" name="side" value={spots[0].side} />
                      <input type="hidden" name="line" value={String(spots[0].line)} />
                      <textarea class="form-control mb-1" name="body" rows={3} aria-label="Line comment"></textarea>
                      <button class="btn btn-sm" type="submit">Comment</button>
                    </form>
                  </details>
                )}
              </>
            );
          }}
        />
        </>
      );
    }

    return repoPage(
      c,
      ctx,
      "pulls",
      `${pull.title} · Pull Request #${pull.number} · ${owner}/${name}`,
      <>
        <div class="mb-3">
          <h1 class="f1 text-normal" style="word-break:break-word">
            {pull.title} <span class="color-fg-muted">#{pull.number}</span>
          </h1>
          <div class="d-flex flex-wrap flex-items-center mt-2 color-fg-muted">
            <StateBadge state={state} isPull={true} />
            {pull.draft && <span class="Label mr-2">Draft</span>}
            {state === "open" && canManage(c, ctx, pull) && (
              <form method="post" action={`${base}/draft`} class="mr-2">
                <CsrfField csrf={c.get("csrf")} />
                <button class="btn btn-sm" type="submit">{pull.draft ? "Ready for review" : "Convert to draft"}</button>
              </form>
            )}
            {state === "merged" ? (
              <span>
                <a class="text-bold Link--secondary" href={`/${pull.mergedBy}`}>{pull.mergedBy}</a> merged {plural(changes.commits.length, "commit")} into{" "}
                <BranchName name={pull.baseRef} /> from <BranchName name={pull.headRef} /> <TimeAgo ts={pull.mergedAt!} />
              </span>
            ) : (
              <span>
                <a class="text-bold Link--secondary" href={`/${pull.author}`}>{pull.author}</a> wants to merge {plural(changes.commits.length, "commit")} into{" "}
                <BranchName name={pull.baseRef} /> from <BranchName name={pull.headRef} />
              </span>
            )}
          </div>
        </div>
        <div class="tabnav d-flex flex-items-end">
          <nav class="tabnav-tabs flex-auto" aria-label="Pull request tabs">
            {tabItem("conversation", base, "comment-discussion", "Conversation", comments.length)}
            {tabItem("commits", `${base}/commits`, "git-commit", "Commits", changes.commits.length)}
            {tabItem("files", `${base}/files`, "file-diff", "Files changed", changes.files.length)}
          </nav>
          <span class="f6 pb-2"><Diffstat additions={additions} deletions={deletions} /></span>
        </div>
        {content}
      </>,
    );
  }

  app.get(`${R}/pull/:n`, withRepo(deps, "read", (c, ctx) => pullPage(c, ctx, "conversation")));
  app.get(`${R}/pull/:n/commits`, withRepo(deps, "read", (c, ctx) => pullPage(c, ctx, "commits")));
  app.get(`${R}/pull/:n/files`, withRepo(deps, "read", (c, ctx) => pullPage(c, ctx, "files")));

  app.post(`${R}/pull/:n/merge`, withRepo(deps, "write", async (c, ctx) => {
    const user = c.get("user")!;
    const pull = getPull(deps.db, ctx.repo.id, Number(c.req.param("n")));
    if (!pull) return notFound(c);
    if (pull.state !== "open" || pull.mergedAt) return renderError(c, 409, "This pull request is already closed.");
    if (pull.draft) return renderError(c, 409, "This pull request is still a draft.");
    const [baseBefore, headBefore] = await Promise.all([ctx.git.resolve(pull.baseRef), ctx.git.resolve(pull.headRef)]);
    if (!baseBefore || !headBefore) return renderError(c, 409, "A branch of this pull request no longer exists.");
    const unmet = unmetChecks(deps.db, ctx.repo.id, headBefore);
    if (unmet.length) return renderError(c, 409, `Required checks have not passed: ${unmet.join(", ")}`);
    const f = await form(c);
    const method = field(f, "method");
    const mergeMessage = `Merge pull request #${pull.number} from ${ctx.repo.owner}/${pull.headRef}\n\n${pull.title}`;
    const squashMessage = pull.body.trim() ? `${pull.title}\n\n${pull.body.trim()}` : pull.title;
    const pinned = { base: baseBefore, head: headBefore };
    try {
      const sha = method === "squash"
        ? await ctx.git.squash(pull.baseRef, pull.headRef, squashMessage, authorFor(user), pinned)
        : method === "rebase"
          ? await ctx.git.rebase(pull.baseRef, pull.headRef, authorFor(user), pinned)
          : await ctx.git.merge(pull.baseRef, pull.headRef, mergeMessage, authorFor(user), pinned);
      markMerged(deps.db, pull.id, user.id, sha, baseBefore);
      const text = `${pull.title}\n${pull.body}\n${method === "squash" ? squashMessage : mergeMessage}`;
      applyClosingReferences(deps.db, user, ctx.repo, text, `pull request #${pull.number}`);
      recordMentions(deps.db, user, ctx.repo, text, { kind: "pull", number: pull.number });
      if (baseBefore && pull.baseRef === ctx.repo.defaultBranch) {
        const landed = await ctx.git.commitMessages(baseBefore, sha);
        for (const commit of landed) {
          applyClosingReferences(deps.db, user, ctx.repo, `${commit.subject}\n${commit.body}`, commit.sha.slice(0, 7));
        }
      }
      if (field(f, "delete_branch") === "1" && pull.headRef !== ctx.repo.defaultBranch && headBefore) {
        try {
          await ctx.git.deleteBranch(pull.headRef, headBefore);
        } catch {
          // The merge stands. A branch that moved is left in place.
        }
      }
    } catch (err) {
      if (err instanceof MergeConflictError) return renderError(c, 409, "This branch has conflicts that must be resolved before merging.");
      if (err instanceof RefMovedError) return renderError(c, 409, "The base branch changed while merging. Reload and try again.");
      if (err instanceof GitError && /nothing to merge|more than 100|merge commit/.test(err.stderr)) return renderError(c, 409, err.stderr);
      throw err;
    }
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "pull", String(pull.number)));
  }));
}
