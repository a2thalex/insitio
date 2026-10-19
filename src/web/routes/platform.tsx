import type { Context, Hono } from "hono";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { Deps } from "../../deps.js";
import { GitError } from "../../git/run.js";
import type { TreeEntry } from "../../git/repo.js";
import { assertNotBlocked } from "../../services/account.js";
import { ValidationError } from "../../services/errors.js";
import { can } from "../../services/permissions.js";
import {
  addDiscussionComment,
  addProjectCard,
  createAdvisory,
  createDiscussion,
  createProject,
  discussionComments,
  getDiscussion,
  getProject,
  getWiki,
  issuesOpenedSince,
  listActionRuns,
  listAdvisories,
  listDiscussions,
  listProjects,
  listWiki,
  moveProjectCard,
  recordActionRun,
  saveWiki,
  secretRulesIn,
  setDiscussionState,
  wikiSlug,
} from "../../services/platform.js";
import type { Env } from "../env.js";
import { field, form, loginRedirect } from "../middleware.js";
import { renderMarkdown } from "../markdown.js";
import { blobUrl } from "../paths.js";
import { render, renderError } from "../render.js";
import type { RepoCtx } from "../repoContext.js";
import { CsrfField } from "../views/layout.js";
import { RepoLayout } from "../views/repo.js";
import { withRepo } from "./code.js";

const SKIP_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "pdf", "zip", "gz", "woff", "woff2", "ico"]);

export function platformRoutes(deps: Deps, app: Hono<Env>) {
  const R = "/:owner/:repo";

  app.get(`${R}/wiki`, withRepo(deps, "read", (c, ctx) => {
    const pages = listWiki(deps.db, ctx.repo.id);
    return render(c, "Wiki", page(c, ctx, "wiki", (
      <>
        <div class="d-flex flex-items-center mb-3">
          <h1 class="f2 text-normal flex-auto">Wiki</h1>
          {can(ctx.access, "write") && <a class="btn btn-primary" href={`${base(ctx)}/wiki/home`}>New page</a>}
        </div>
        {pages.length === 0 ? <p class="color-fg-muted">No pages yet.</p> : (
          <div class="Box">{pages.map((item) => <a class="Box-row d-block" href={`${base(ctx)}/wiki/${item.slug}`}>{item.title}</a>)}</div>
        )}
      </>
    )));
  }));

  app.get(`${R}/wiki/:slug`, withRepo(deps, "read", (c, ctx) => {
    const slug = wikiSlug(c.req.param("slug") ?? "");
    const item = getWiki(deps.db, ctx.repo.id, slug);
    const html = item ? renderMarkdown(item.body, { repo: { owner: ctx.repo.owner, name: ctx.repo.name, ref: ctx.repo.defaultBranch, dir: "" } }) : "";
    return render(c, item?.title ?? "Wiki", page(c, ctx, "wiki", (
      <>
        {item ? <div class="Box mb-4"><div class="Box-header">{item.title}</div><div class="Box-body markdown-body">{raw(html)}</div></div> : <p class="color-fg-muted">This page does not exist yet.</p>}
        {can(ctx.access, "write") && (
          <form method="post" action={`${base(ctx)}/wiki/${slug}`}>
            <CsrfField csrf={c.get("csrf")} />
            <input class="form-control mb-2" name="title" aria-label="Title" value={item?.title ?? ""} required />
            <textarea class="form-control mb-2" name="body" aria-label="Body" rows={12}>{item?.body ?? ""}</textarea>
            <button class="btn btn-primary" type="submit">{item ? "Save page" : "Create page"}</button>
          </form>
        )}
      </>
    )));
  }));

  app.post(`${R}/wiki/:slug`, withRepo(deps, "write", async (c, ctx) => {
    const user = c.get("user")!;
    const slug = wikiSlug(c.req.param("slug") ?? "");
    const f = await form(c);
    saveWiki(deps.db, ctx.repo.id, slug, field(f, "title"), field(f, "body"), user.id);
    return c.redirect(`${base(ctx)}/wiki/${slug}`);
  }));

  app.get(`${R}/discussions`, withRepo(deps, "read", (c, ctx) => {
    const threads = listDiscussions(deps.db, ctx.repo.id);
    return render(c, "Discussions", page(c, ctx, "discussions", (
      <>
        <h1 class="f2 text-normal mb-3">Discussions</h1>
        {c.get("user") && (
          <form method="post" action={`${base(ctx)}/discussions`} class="Box p-3 mb-3">
            <CsrfField csrf={c.get("csrf")} />
            <select class="form-select mb-2" name="category" aria-label="Category">
              <option value="general">General</option>
              <option value="ideas">Ideas</option>
              <option value="q-and-a">Q&amp;A</option>
            </select>
            <input class="form-control mb-2" name="title" aria-label="Title" required />
            <textarea class="form-control mb-2" name="body" aria-label="Body" rows={4}></textarea>
            <button class="btn btn-primary" type="submit">Start discussion</button>
          </form>
        )}
        {threads.length === 0 ? <p class="color-fg-muted">No discussions yet.</p> : (
          <div class="Box">{threads.map((thread) => (
            <a class="Box-row d-block" href={`${base(ctx)}/discussions/${thread.number}`}>
              {thread.title} <span class="color-fg-muted">#{thread.number} · {thread.state}</span>
            </a>
          ))}</div>
        )}
      </>
    )));
  }));

  app.post(`${R}/discussions`, withRepo(deps, "read", async (c, ctx) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    assertNotBlocked(deps.db, user.id, ctx.repo.ownerId);
    const f = await form(c);
    const number = createDiscussion(deps.db, ctx.repo, user.id, { category: field(f, "category"), title: field(f, "title"), body: field(f, "body") });
    return c.redirect(`${base(ctx)}/discussions/${number}`);
  }));

  app.get(`${R}/discussions/:n`, withRepo(deps, "read", (c, ctx) => {
    const thread = getDiscussion(deps.db, ctx.repo.id, Number(c.req.param("n")));
    if (!thread) return renderError(c, 404, "This discussion");
    const comments = discussionComments(deps.db, thread.id);
    const user = c.get("user");
    const canClose = user && (user.id === thread.authorId || can(ctx.access, "write"));
    return render(c, thread.title, page(c, ctx, "discussions", (
      <>
        <h1 class="f2 text-normal">{thread.title}</h1>
        <p class="color-fg-muted">#{thread.number} · {thread.category} · {thread.state} · {thread.author}</p>
        <div class="markdown-body mb-4">{raw(renderMarkdown(thread.body))}</div>
        {comments.map((comment) => <div class="Box-row"><strong>{comment.author}</strong><div class="markdown-body">{raw(renderMarkdown(comment.body))}</div></div>)}
        {canClose && (
          <form method="post" action={`${base(ctx)}/discussions/${thread.number}/state`} class="mt-3">
            <CsrfField csrf={c.get("csrf")} />
            <input type="hidden" name="state" value={thread.state === "open" ? "closed" : "open"} />
            <button class="btn btn-sm" type="submit">{thread.state === "open" ? "Close discussion" : "Reopen discussion"}</button>
          </form>
        )}
        {user && (
          <form method="post" action={`${base(ctx)}/discussions/${thread.number}/comment`} class="mt-3">
            <CsrfField csrf={c.get("csrf")} />
            <textarea class="form-control mb-2" name="body" aria-label="Comment" rows={4}></textarea>
            <button class="btn btn-primary" type="submit">Comment</button>
          </form>
        )}
      </>
    )));
  }));

  app.post(`${R}/discussions/:n/comment`, withRepo(deps, "read", async (c, ctx) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    assertNotBlocked(deps.db, user.id, ctx.repo.ownerId);
    const thread = getDiscussion(deps.db, ctx.repo.id, Number(c.req.param("n")));
    if (!thread) return renderError(c, 404, "This discussion");
    addDiscussionComment(deps.db, ctx.repo, thread, user.id, user.username, field(await form(c), "body"));
    return c.redirect(`${base(ctx)}/discussions/${thread.number}`);
  }));

  app.post(`${R}/discussions/:n/state`, withRepo(deps, "read", async (c, ctx) => {
    const user = c.get("user");
    if (!user) return renderError(c, 403, "You don't have permission to do that in this repository.");
    const thread = getDiscussion(deps.db, ctx.repo.id, Number(c.req.param("n")));
    if (!thread) return renderError(c, 404, "This discussion");
    if (user.id !== thread.authorId && !can(ctx.access, "write")) return renderError(c, 403, "You don't have permission to do that in this repository.");
    const state = field(await form(c), "state");
    if (state !== "open" && state !== "closed") throw new ValidationError("Unknown state");
    setDiscussionState(deps.db, ctx.repo.id, thread.number, state);
    return c.redirect(`${base(ctx)}/discussions/${thread.number}`);
  }));

  app.get(`${R}/projects`, withRepo(deps, "read", (c, ctx) => {
    const boards = listProjects(deps.db, ctx.repo.id);
    return render(c, "Projects", page(c, ctx, "projects", (
      <>
        <h1 class="f2 text-normal mb-3">Projects</h1>
        {can(ctx.access, "write") && (
          <form method="post" action={`${base(ctx)}/projects`} class="d-flex mb-3" style="gap:8px">
            <CsrfField csrf={c.get("csrf")} />
            <input class="form-control" name="name" aria-label="Project name" required />
            <button class="btn btn-primary" type="submit">New project</button>
          </form>
        )}
        {boards.length === 0 ? <p class="color-fg-muted">No projects yet.</p> : (
          <div class="Box">{boards.map((board) => <a class="Box-row d-block" href={`${base(ctx)}/projects/${board.id}`}>{board.name}</a>)}</div>
        )}
      </>
    )));
  }));

  app.post(`${R}/projects`, withRepo(deps, "write", async (c, ctx) => {
    const id = createProject(deps.db, ctx.repo.id, field(await form(c), "name"));
    return c.redirect(`${base(ctx)}/projects/${id}`);
  }));

  app.get(`${R}/projects/:id`, withRepo(deps, "read", (c, ctx) => {
    const board = getProject(deps.db, ctx.repo.id, Number(c.req.param("id")));
    if (!board) return renderError(c, 404, "This project");
    return render(c, board.project.name, page(c, ctx, "projects", (
      <>
        <h1 class="f2 text-normal mb-3">{board.project.name}</h1>
        <div class="d-flex flex-wrap" style="gap:16px">
          {board.columns.map((column) => (
            <div class="Box p-3" style="flex:1 1 220px">
              <h2 class="f4">{column.name}</h2>
              {column.cards.map((card) => (
                <div class="Box-row">
                  {card.title}
                  {card.issueNumber ? <a class="ml-2" href={`${base(ctx)}/issues/${card.issueNumber}`}>#{card.issueNumber}</a> : null}
                  {can(ctx.access, "write") && (
                    <form method="post" action={`${base(ctx)}/projects/${board.project.id}/cards/${card.id}`} class="mt-2">
                      <CsrfField csrf={c.get("csrf")} />
                      <select class="form-select" name="column" aria-label={`Move ${card.title}`}>
                        {board.columns.map((choice) => <option value={String(choice.id)} selected={choice.id === column.id}>{choice.name}</option>)}
                      </select>
                      <button class="btn btn-sm mt-1" type="submit">Move</button>
                    </form>
                  )}
                </div>
              ))}
              {can(ctx.access, "write") && (
                <form method="post" action={`${base(ctx)}/projects/${board.project.id}/columns/${column.id}/cards`} class="mt-2">
                  <CsrfField csrf={c.get("csrf")} />
                  <input class="form-control mb-1" name="title" aria-label={`Card in ${column.name}`} />
                  <input class="form-control mb-1" name="issue" aria-label="Issue number" inputmode="numeric" />
                  <button class="btn btn-sm" type="submit">Add card</button>
                </form>
              )}
            </div>
          ))}
        </div>
      </>
    )));
  }));

  app.post(`${R}/projects/:id/columns/:column/cards`, withRepo(deps, "write", async (c, ctx) => {
    const f = await form(c);
    const issue = Number(field(f, "issue"));
    addProjectCard(deps.db, ctx.repo.id, Number(c.req.param("column")), field(f, "title"), Number.isInteger(issue) && issue > 0 ? issue : null);
    return c.redirect(`${base(ctx)}/projects/${c.req.param("id")}`);
  }));

  app.post(`${R}/projects/:id/cards/:card`, withRepo(deps, "write", async (c, ctx) => {
    moveProjectCard(deps.db, ctx.repo.id, Number(c.req.param("card")), Number(field(await form(c), "column")));
    return c.redirect(`${base(ctx)}/projects/${c.req.param("id")}`);
  }));

  app.get(`${R}/security`, withRepo(deps, "read", async (c, ctx) => {
    const advisories = listAdvisories(deps.db, ctx.repo.id, ctx.access === "admin");
    const findings = c.req.query("scan") === "1" && can(ctx.access, "write") ? await scanSecrets(ctx) : [];
    return render(c, "Security", page(c, ctx, "security", (
      <>
        <h1 class="f2 text-normal mb-3">Security</h1>
        <h2 class="f4">Advisories</h2>
        {advisories.length === 0 ? <p class="color-fg-muted">No published advisories.</p> : advisories.map((item) => (
          <div class="Box p-3 mb-2"><strong>{item.title}</strong> <span class="Label ml-2">{item.severity}</span>{item.published ? null : <span class="Label ml-2">Draft</span>}<p class="mb-0">{item.summary}</p></div>
        ))}
        {ctx.access === "admin" && (
          <form method="post" action={`${base(ctx)}/security/advisories`} class="Box p-3 mb-4">
            <CsrfField csrf={c.get("csrf")} />
            <input class="form-control mb-2" name="title" aria-label="Advisory title" required />
            <select class="form-select mb-2" name="severity" aria-label="Severity">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
            <textarea class="form-control mb-2" name="summary" aria-label="Summary" rows={4}></textarea>
            <label class="mr-3"><input type="checkbox" name="published" value="1" /> Publish</label>
            <button class="btn btn-primary" type="submit">Save advisory</button>
          </form>
        )}
        <h2 class="f4">Secret scan</h2>
        <p class="color-fg-muted">Scans up to 40 text files on the default branch. A finding names the file and the rule. It does not show the secret, and Insitio does not run this on a schedule.</p>
        {can(ctx.access, "write") && (
          <form method="post" action={`${base(ctx)}/security/scan`}>
            <CsrfField csrf={c.get("csrf")} />
            <button class="btn" type="submit">Scan default branch</button>
          </form>
        )}
        {c.req.query("scan") === "1" && (findings.length === 0 ? <p>No findings.</p> : (
          <div class="Box mt-3">{findings.map((hit) => <div class="Box-row">{hit.path} <span class="Label ml-2">{hit.rule}</span></div>)}</div>
        ))}
      </>
    )));
  }));

  app.post(`${R}/security/advisories`, withRepo(deps, "admin", async (c, ctx) => {
    const f = await form(c);
    createAdvisory(deps.db, ctx.repo.id, c.get("user")!.id, {
      title: field(f, "title"),
      severity: field(f, "severity"),
      summary: field(f, "summary"),
      published: field(f, "published") === "1",
    });
    return c.redirect(`${base(ctx)}/security`);
  }));

  app.post(`${R}/security/scan`, withRepo(deps, "write", (c, ctx) => c.redirect(`${base(ctx)}/security?scan=1`)));

  app.get(`${R}/actions`, withRepo(deps, "read", async (c, ctx) => {
    const files = await workflowFiles(ctx);
    const runs = listActionRuns(deps.db, ctx.repo.id);
    return render(c, "Actions", page(c, ctx, "actions", (
      <>
        <h1 class="f2 text-normal mb-2">Actions</h1>
        <p class="color-fg-muted">Workflow files are listed from the default branch. Insitio does not run them. A run is a record, from this form or from the API.</p>
        <h2 class="f4">Workflows</h2>
        {files.length === 0 ? <p class="color-fg-muted">No workflow files in <code class="text-mono">.github/workflows</code>.</p> : (
          <div class="Box mb-4">{files.map((name) => <a class="Box-row d-block" href={blobUrl(ctx.repo.owner, ctx.repo.name, ctx.repo.defaultBranch, `.github/workflows/${name}`)}>{name}</a>)}</div>
        )}
        <h2 class="f4">Runs</h2>
        {runs.length === 0 ? <p class="color-fg-muted">No runs recorded.</p> : (
          <div class="Box mb-3">{runs.map((run) => <div class="Box-row">{run.name} <span class="text-mono">{run.headSha.slice(0, 7)}</span> · {run.status}{run.conclusion ? ` · ${run.conclusion}` : ""}</div>)}</div>
        )}
        {can(ctx.access, "write") && (
          <form method="post" action={`${base(ctx)}/actions/runs`} class="Box p-3">
            <CsrfField csrf={c.get("csrf")} />
            <input class="form-control mb-2" name="name" aria-label="Run name" required />
            <input class="form-control mb-2" name="head_sha" aria-label="Commit" required />
            <select class="form-select mb-2" name="status" aria-label="Status">
              <option value="queued">Queued</option>
              <option value="in_progress">In progress</option>
              <option value="completed">Completed</option>
            </select>
            <select class="form-select mb-2" name="conclusion" aria-label="Conclusion">
              <option value="">No conclusion</option>
              <option value="success">Success</option>
              <option value="failure">Failure</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <button class="btn btn-primary" type="submit">Record run</button>
          </form>
        )}
      </>
    )));
  }));

  app.post(`${R}/actions/runs`, withRepo(deps, "write", async (c, ctx) => {
    const f = await form(c);
    const sha = field(f, "head_sha").trim();
    const found = await ctx.git.resolve(sha);
    if (!found) throw new ValidationError("That commit does not exist in this repository.");
    recordActionRun(deps.db, ctx.repo.id, { name: field(f, "name"), headSha: found, status: field(f, "status"), conclusion: field(f, "conclusion") || null });
    return c.redirect(`${base(ctx)}/actions`);
  }));

  app.get(`${R}/insights`, withRepo(deps, "read", async (c, ctx) => {
    let commits: { sha: string; authorName: string; subject: string }[] = [];
    let people: { name: string; commits: number }[] = [];
    try {
      if (await ctx.git.resolve(ctx.repo.defaultBranch)) {
        commits = await ctx.git.log(ctx.repo.defaultBranch, { skip: 0, limit: 10 });
        people = await ctx.git.contributors(ctx.repo.defaultBranch);
      }
    } catch (err) {
      if (!(err instanceof GitError)) throw err;
    }
    const opened = issuesOpenedSince(deps.db, ctx.repo.id, Math.floor(Date.now() / 1000) - 7 * 86400);
    return render(c, "Insights", page(c, ctx, "insights", (
      <>
        <h1 class="f2 text-normal mb-2">Insights</h1>
        <p class="color-fg-muted">Page views are not recorded.</p>
        <p>{ctx.repo.stars} stars · {ctx.forks} forks · {opened} issues opened in seven days · {people.reduce((sum, person) => sum + person.commits, 0) === 0 && commits.length === 0 ? "no commits" : `${people.length} contributors`}</p>
        <h2 class="f4">Contributors</h2>
        {people.length === 0 ? <p class="color-fg-muted">No commits on the default branch.</p> : (
          <div class="Box mb-3">{people.slice(0, 10).map((person) => <div class="Box-row">{person.name} <span class="Counter">{person.commits}</span></div>)}</div>
        )}
        <h2 class="f4">Recent commits</h2>
        {commits.length === 0 ? <p class="color-fg-muted">No commits yet.</p> : (
          <div class="Box">{commits.map((commit) => <div class="Box-row"><span class="text-mono">{commit.sha.slice(0, 7)}</span> {commit.subject} <span class="color-fg-muted">{commit.authorName}</span></div>)}</div>
        )}
      </>
    )));
  }));
}

function base(ctx: RepoCtx): string {
  return `/${ctx.repo.owner}/${ctx.repo.name}`;
}

function page(c: Context<Env>, ctx: RepoCtx, tab: "actions" | "projects" | "wiki" | "discussions" | "security" | "insights", body: Child) {
  return <RepoLayout ctx={ctx} tab={tab} csrf={c.get("csrf")} signedIn={!!c.get("user")}>{body}</RepoLayout>;
}

async function workflowFiles(ctx: RepoCtx): Promise<string[]> {
  try {
    const entries = await ctx.git.tree(ctx.repo.defaultBranch, ".github/workflows");
    return entries.filter((entry) => entry.type === "blob" && /\.ya?ml$/i.test(entry.name)).map((entry) => entry.name);
  } catch (err) {
    if (err instanceof GitError) return [];
    throw err;
  }
}

async function scanSecrets(ctx: RepoCtx): Promise<{ path: string; rule: string }[]> {
  const found: { path: string; rule: string }[] = [];
  let seen = 0;
  async function walk(dir: string): Promise<void> {
    if (seen >= 40 || found.length >= 20) return;
    let entries: TreeEntry[] = [];
    try {
      entries = await ctx.git.tree(ctx.repo.defaultBranch, dir);
    } catch (err) {
      if (err instanceof GitError) return;
      throw err;
    }
    for (const entry of entries) {
      if (seen >= 40 || found.length >= 20) return;
      if (entry.type === "tree") {
        await walk(entry.path);
        continue;
      }
      if (entry.type !== "blob") continue;
      const ext = entry.name.includes(".") ? entry.name.split(".").pop()!.toLowerCase() : "";
      if (SKIP_EXT.has(ext) || (entry.size !== null && entry.size > 200_000)) continue;
      seen += 1;
      const blob = await ctx.git.blob(ctx.repo.defaultBranch, entry.path, 200_000);
      if (blob.content.includes(0)) continue;
      for (const rule of secretRulesIn(blob.content.toString("utf8"))) found.push({ path: entry.path, rule });
    }
  }
  try {
    await walk("");
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
  }
  return found;
}
