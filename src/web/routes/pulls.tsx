import type { Context, Hono } from "hono";
import type { Child } from "hono/jsx";
import type { Deps } from "../../deps.js";
import type { DiffFile } from "../../git/diff.js";
import { MergeConflictError, RefMovedError, type Commit, type Mergeability } from "../../git/repo.js";
import { ValidationError } from "../../services/errors.js";
import { PER_PAGE, listComments, listEvents, listLabels, participants } from "../../services/issues.js";
import { can } from "../../services/permissions.js";
import { createPull, getPull, listPulls, markMerged, type Pull } from "../../services/pulls.js";
import { authorFor } from "../../services/repos.js";
import type { Env } from "../env.js";
import { field, form, loginRedirect } from "../middleware.js";
import { blobUrl, commitUrl, encPath, repoUrl, treeUrl } from "../paths.js";
import type { RepoCtx } from "../repoContext.js";
import { notFound, renderError } from "../render.js";
import { CsrfField, Flash, Octicon, Pagination, TimeAgo } from "../views/layout.js";
import { DiffView, Diffstat } from "../views/diff.js";
import { CommentForm, IssueRow, LabelsSidebar, Participants, StateBadge, Timeline, type IssueState } from "../views/issues.js";
import { CommitAuthor, RefPicker } from "../views/repo.js";
import { canManage } from "./issues.js";
import { repoPage, withRepo } from "./code.js";

type Changes = { commits: Commit[]; files: DiffFile[]; truncated: boolean };

function pullState(p: Pull): IssueState {
  return p.mergedAt ? "merged" : p.state;
}

/** A PR's commits and diff; after a merge they come from the merge commit's parents so they stay visible. */
async function pullChanges(ctx: RepoCtx, p: Pull): Promise<Changes> {
  const [base, head] = p.mergeCommit ? [`${p.mergeCommit}^1`, `${p.mergeCommit}^2`] : [p.baseRef, p.headRef];
  const cmp = await ctx.git.compare(base, head);
  return { commits: cmp.commits, files: cmp.files, truncated: cmp.diffTruncated };
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

function MergeBox({ ctx, pull, status, canMerge, csrf, signedIn }: { ctx: RepoCtx; pull: Pull; status: Mergeability | "merged" | "closed"; canMerge: boolean; csrf: string; signedIn: boolean }) {
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
        {status === "clean" && canMerge ? (
          <form method="post" action={`${base}/merge`}>
            <CsrfField csrf={csrf} />
            <button class="btn btn-primary" type="submit">Merge pull request</button>
            <span class="f6 color-fg-muted ml-2">Creates a merge commit on <BranchName name={pull.baseRef} />.</span>
          </form>
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
    const defaultTitle = cmp?.commits.length === 1 ? cmp.commits[0].subject : headRef.replace(/[-_/]+/g, " ").replace(/^\w/, (s) => s.toUpperCase());
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
          ) : c.get("user") ? (
            <form method="post" action={repoUrl(owner, name, "pulls")} class="Box p-3 mb-4">
              <CsrfField csrf={c.get("csrf")} />
              <input type="hidden" name="base" value={baseRef} />
              <input type="hidden" name="head" value={headRef} />
              <Flash error={error} />
              <input class="form-control input-block input-lg mb-2" name="title" value={values?.title ?? defaultTitle} aria-label="Title" required maxlength={256} />
              <textarea class="form-control input-block" name="body" placeholder="Describe your changes (Markdown supported)" aria-label="Description" style="min-height:140px">{values?.body ?? ""}</textarea>
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
      const pull = createPull(deps.db, ctx.repo.id, user.id, { ...values, baseRef: base, headRef: head });
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

    let content: Child;
    if (tab === "conversation") {
      const status = state === "merged" ? "merged" : state === "closed" ? "closed" : await ctx.git.mergeability(pull.baseRef, pull.headRef);
      const extra = changes.commits.map((cm) => ({
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
      }));
      content = (
        <div class="d-md-flex">
          <div class="flex-auto min-width-0 mr-md-4">
            <Timeline ctx={ctx} issue={pull} comments={comments} events={listEvents(deps.db, pull.id)} extra={extra} />
            <MergeBox ctx={ctx} pull={pull} status={status} canMerge={can(ctx.access, "write")} csrf={c.get("csrf")} signedIn={!!c.get("user")} />
            <CommentForm
              action={`${base}/comment`}
              csrf={c.get("csrf")}
              canToggle={state !== "merged" && canManage(c, ctx, pull)}
              state={pull.state}
              isPull={true}
              signedIn={!!c.get("user")}
              loginHref={`/login?next=${encodeURIComponent(base)}`}
            />
          </div>
          <aside class="col-md-3 flex-shrink-0" aria-label="Pull request details">
            <LabelsSidebar ctx={ctx} issue={pull} allLabels={listLabels(deps.db, ctx.repo.id)} canEdit={can(ctx.access, "write")} csrf={c.get("csrf")} action={`${base}/labels`} />
            <Participants names={participants(pull, comments)} />
          </aside>
        </div>
      );
    } else if (tab === "commits") {
      content = <div class="Box"><CommitList ctx={ctx} commits={changes.commits} /></div>;
    } else {
      const ref = pull.mergeCommit ?? pull.headRef;
      content = <DiffView files={changes.files} truncated={changes.truncated} viewFileHref={(f) => (f.status === "deleted" ? null : blobUrl(owner, name, ref, f.newPath))} />;
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
    const message = `Merge pull request #${pull.number} from ${ctx.repo.owner}/${pull.headRef}\n\n${pull.title}`;
    try {
      const sha = await ctx.git.merge(pull.baseRef, pull.headRef, message, authorFor(user));
      markMerged(deps.db, pull.id, user.id, sha);
    } catch (err) {
      if (err instanceof MergeConflictError) return renderError(c, 409, "This branch has conflicts that must be resolved before merging.");
      if (err instanceof RefMovedError) return renderError(c, 409, "The base branch changed while merging. Reload and try again.");
      throw err;
    }
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "pull", String(pull.number)));
  }));
}
