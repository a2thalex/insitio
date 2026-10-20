import type { Hono } from "hono";
import type { Deps } from "../../deps.js";
import { listNotifications, markNotificationsRead } from "../../services/notifications.js";
import { explorePublic } from "../../services/parity.js";
import { listAllVisible, listReposForMember, listStarred, searchRepos, type RepoRow } from "../../services/repos.js";
import { searchCode, searchIssues, searchUsers } from "../../services/search.js";
import { recentOpenIssues } from "../../services/issues.js";
import type { Env } from "../env.js";
import { form, loginRedirect } from "../middleware.js";
import { blobUrl } from "../paths.js";
import { render } from "../render.js";
import { InstallSteps } from "./downloads.js";
import { Avatar, CsrfField, InsitioMark, Octicon, TimeAgo } from "../views/layout.js";
import { RepoListItem } from "../views/repoList.js";

function RepoLink({ repo }: { repo: RepoRow }) {
  return (
    <li class="d-flex flex-items-center py-1">
      <Avatar name={repo.owner} size={16} class="mr-2" />
      <a class="Link--primary text-bold css-truncate css-truncate-target" style="max-width:220px" href={`/${repo.owner}/${repo.name}`}>
        {repo.owner}/{repo.name}
      </a>
      {repo.isPrivate && <Octicon name="lock" class="ml-1 color-fg-muted" size={12} />}
    </li>
  );
}

function Shelf({ title, href, link, children }: { title: string; href?: string; link?: string; children?: any }) {
  return (
    <section aria-label={title}>
      <div class="home-head">
        <h2>{title}</h2>
        {href && link ? <a href={href}>{link}</a> : null}
      </div>
      {children}
    </section>
  );
}

export function homeRoutes(deps: Deps, app: Hono<Env>) {
  app.get("/explore", (c) => {
    const found = explorePublic(deps.db);
    return render(c, "Explore", (
      <div class="container-lg p-responsive py-4">
        <h1 class="f2 text-normal">Explore</h1>
        <h2 class="f4">Repositories</h2>
        <div class="Box mb-4">{found.repos.map((repo) => <a class="Box-row d-block" href={`/${repo.owner}/${repo.name}`}>{repo.owner}/{repo.name}</a>)}</div>
        <h2 class="f4">Issues</h2>
        <div class="Box mb-4">{found.issues.map((issue) => <a class="Box-row d-block" href={`/${issue.owner}/${issue.name}/issues/${issue.number}`}>{issue.owner}/{issue.name}#{issue.number} {issue.title}</a>)}</div>
        <h2 class="f4">Gists</h2>
        <div class="Box mb-4">{found.gists.map((gist) => <a class="Box-row d-block" href={`/gists/${gist.id}`}>{gist.description || gist.id} <span class="color-fg-muted">{gist.owner}</span></a>)}</div>
        <h2 class="f4" id="discussions">Discussions</h2>
        <div class="Box">{found.discussions.map((thread) => <a class="Box-row d-block" href={`/${thread.owner}/${thread.name}/discussions/${thread.number}`}>{thread.owner}/{thread.name}#{thread.number} {thread.title}</a>)}</div>
      </div>
    ));
  });

  app.get("/", (c) => {
    const user = c.get("user");
    if (!user) {
      const recent = listAllVisible(deps.db, null, 8);
      const found = explorePublic(deps.db);
      return render(
        c,
        "",
        <>
        <div class="home">
          <div class="home-mast">
            <div class="home-intro">
              <InsitioMark size={36} />
              <h1>Insitio</h1>
              <p class="lede">A private git host. Repositories stay on this server, and only the people you invite can get in.</p>
              <div class="home-actions">
                <a class="btn btn-primary btn-large" href="/login">Sign in</a>
                <a class="btn btn-large" href="/explore">Explore</a>
              </div>
              <p class="gate-note">Accounts start from an invite link. There is no open sign-up. <a href="#install">Install directions</a> are below.</p>
            </div>
            <ul class="home-facts">
              <li><strong>Public or private.</strong> A new repository is public unless you choose private. A private one stays hidden.</li>
              <li><strong>Invite only.</strong> There is no open sign-up on this server.</li>
              <li><strong>Code, issues, and reviews.</strong> Pull requests, wiki pages, discussions, and project boards live on each repository.</li>
              <li><strong>Your tools.</strong> Use git, or install <a href="#install">nsit</a> and run <code class="text-mono">nsit auth login</code>.</li>
            </ul>
          </div>
          <div class="home-index">
            <div>
              <Shelf title="Public repositories" href="/explore" link="See all">
                {recent.length === 0 ? (
                  <div class="home-empty">
                    <p>Nothing on this server is public yet.</p>
                    <p>After you sign in, a new repository is public unless you choose private. Private repositories stay off this page.</p>
                  </div>
                ) : (
                  <div class="Box">{recent.map((repo) => <RepoListItem repo={repo} showOwner />)}</div>
                )}
              </Shelf>
              {recent.length > 0 && (
                <div class="home-clone">
                  <h2>Clone</h2>
                  {recent.slice(0, 4).map((repo) => (
                    <p><code class="text-mono">git clone {deps.config.baseUrl}/{repo.owner}/{repo.name}.git</code></p>
                  ))}
                </div>
              )}
            </div>
            <div class="home-rail">
              <Shelf title="Public issues" href="/explore" link="See all">
                {found.issues.length === 0 ? (
                  <div class="home-empty"><p>No public issues yet.</p></div>
                ) : (
                  <div class="Box">{found.issues.slice(0, 8).map((issue) => (
                    <a class="Box-row d-block" href={`/${issue.owner}/${issue.name}/issues/${issue.number}`}>
                      <span class="text-bold">{issue.title}</span>
                      <span class="d-block f6 color-fg-muted">{issue.owner}/{issue.name}#{issue.number}</span>
                    </a>
                  ))}</div>
                )}
              </Shelf>
              <Shelf title="Gists" href="/gists" link="Open gists">
                {found.gists.length === 0 ? (
                  <div class="home-empty"><p>No public gists yet.</p></div>
                ) : (
                  <div class="Box">{found.gists.slice(0, 8).map((gist) => (
                    <a class="Box-row d-block" href={`/gists/${gist.id}`}>
                      <span class="text-bold">{gist.description || gist.id}</span>
                      <span class="d-block f6 color-fg-muted">{gist.owner}</span>
                    </a>
                  ))}</div>
                )}
              </Shelf>
              <Shelf title="Discussions" href="/explore#discussions" link="See all">
                {found.discussions.length === 0 ? (
                  <div class="home-empty"><p>No public discussions yet.</p></div>
                ) : (
                  <div class="Box">{found.discussions.slice(0, 8).map((thread) => (
                    <a class="Box-row d-block" href={`/${thread.owner}/${thread.name}/discussions/${thread.number}`}>
                      <span class="text-bold">{thread.title}</span>
                      <span class="d-block f6 color-fg-muted">{thread.owner}/{thread.name}, {thread.category}</span>
                    </a>
                  ))}</div>
                )}
              </Shelf>
            </div>
          </div>
        </div>
        <section class="install" id="install" aria-label="Install">
          <h2>Install</h2>
          <InstallSteps baseUrl={deps.config.baseUrl} />
        </section>
        </>,
      );
    }
    const mine = listReposForMember(deps.db, user);
    const starred = listStarred(deps.db, user.id, user);
    const byId = new Map(mine.map((r) => [r.id, r]));
    const activity = recentOpenIssues(deps.db, mine.map((r) => r.id));
    const others = listAllVisible(deps.db, user, 12).filter((repo) => !byId.has(repo.id));
    return render(
      c,
      "Dashboard",
      <div class="container-xl p-responsive py-4">
        <div class="home-links mb-4">
          <a class="btn btn-sm btn-primary" href="/new">New repository</a>
          <a class="btn btn-sm" href="/explore">Explore</a>
          <a class="btn btn-sm" href="/gists">Gists</a>
          <a class="btn btn-sm" href="/notifications">Notifications</a>
          <a class="btn btn-sm" href="/download">Install nsit</a>
        </div>
        <div class="d-md-flex">
        <aside class="col-md-4 col-lg-3 pr-md-4 mb-4" aria-label="Your repositories">
          <div class="d-flex flex-items-center flex-justify-between mb-2">
            <h2 class="f5">Top repositories</h2>
            <a class="btn btn-sm btn-primary" href="/new"><Octicon name="repo" class="mr-1" />New</a>
          </div>
          {mine.length === 0 ? (
            <p class="color-fg-muted f6">You don't have any repositories yet. <a href="/download">Install nsit</a>, then run <code class="text-mono">nsit auth login</code> and <code class="text-mono">nsit repo create name</code>.</p>
          ) : (
            <ul class="list-style-none">{mine.slice(0, 20).map((r) => <RepoLink repo={r} />)}</ul>
          )}
          {starred.length > 0 && (
            <>
              <h2 class="f5 mt-4 mb-2">Starred</h2>
              <ul class="list-style-none">{starred.slice(0, 10).map((r) => <RepoLink repo={r} />)}</ul>
            </>
          )}
        </aside>
        <div class="flex-auto">
        <section aria-label="Recent activity">
          <h2 class="f4 text-normal mb-3">Open issues and pull requests in your repositories</h2>
          {activity.length === 0 ? (
            <div class="blankslate Box">
              <Octicon name="issue-opened" size={24} />
              <h3 class="blankslate-heading">Nothing open right now</h3>
              <p>New issues and pull requests in your repositories will show up here.</p>
            </div>
          ) : (
            <div class="Box">
              {activity.map((i) => {
                const repo = byId.get(i.repoId)!;
                const path = `/${repo.owner}/${repo.name}/${i.isPull ? "pull" : "issues"}/${i.number}`;
                return (
                  <div class="Box-row d-flex">
                    <Octicon name={i.isPull ? "git-pull-request" : "issue-opened"} class="color-fg-success mr-2 mt-1" />
                    <div class="flex-auto">
                      <a class="Link--secondary f6" href={`/${repo.owner}/${repo.name}`}>{repo.owner}/{repo.name}</a>
                      <div><a class="Link--primary text-bold" href={path}>{i.title}</a></div>
                      <div class="f6 color-fg-muted">#{i.number} opened by {i.author} · updated <TimeAgo ts={i.updatedAt} /></div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        {mine.length > 0 && (
          <section class="mt-4" aria-label="Your repositories">
            <h2 class="f4 text-normal mb-2">Your repositories</h2>
            <div class="Box">{mine.slice(0, 6).map((repo) => <RepoListItem repo={repo} showOwner />)}</div>
          </section>
        )}
        {others.length > 0 && (
          <section class="mt-4" aria-label="On this server">
            <h2 class="f4 text-normal mb-2">On this server</h2>
            <div class="Box">{others.slice(0, 6).map((repo) => <RepoListItem repo={repo} showOwner />)}</div>
          </section>
        )}
        {mine.length === 0 && (
          <div class="Box mt-3">
            <div class="Box-row">
              <a class="text-bold" href="/new">Create a repository</a>
              <p class="mb-0 color-fg-muted">A new repository is public unless you choose private.</p>
            </div>
            <div class="Box-row">
              <a class="text-bold" href="/download">Install nsit</a>
              <p class="mb-0 color-fg-muted">Then run <code class="text-mono">nsit auth login</code> and <code class="text-mono">nsit repo create name</code>.</p>
            </div>
            <div class="Box-row">
              <a class="text-bold" href="/explore">See what is already public</a>
            </div>
          </div>
        )}
        </div>
        </div>
      </div>,
    );
  });

  app.get("/notifications", (c) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const notes = listNotifications(deps.db, user.id);
    return render(
      c,
      "Notifications",
      <div class="container-md p-responsive py-4">
        <div class="d-flex flex-items-center mb-3">
          <h1 class="f2 text-normal flex-auto">Notifications</h1>
          <form method="post" action="/notifications/read">
            <CsrfField csrf={c.get("csrf")} />
            <button class="btn btn-sm" type="submit">Mark all read</button>
          </form>
        </div>
        {notes.length === 0 ? (
          <div class="blankslate Box"><h3 class="blankslate-heading">No notifications</h3></div>
        ) : (
          <div class="Box">
            {notes.map((note) => (
              <a class={`Box-row d-block ${note.readAt ? "color-fg-muted" : ""}`} href={note.url}>
                {note.title}
                <span class="f6 d-block">{note.reason}</span>
              </a>
            ))}
          </div>
        )}
      </div>,
    );
  });

  app.post("/notifications/read", async (c) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    await form(c);
    markNotificationsRead(deps.db, user.id);
    return c.redirect("/notifications");
  });

  app.get("/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const type = c.req.query("type") ?? "repos";
    const viewer = c.get("user");
    const repos = q && type === "repos" ? searchRepos(deps.db, q, viewer) : type === "repos" ? listAllVisible(deps.db, viewer) : [];
    const issues = q && type === "issues" ? searchIssues(deps.db, q, viewer) : [];
    const users = q && type === "users" ? searchUsers(deps.db, q) : [];
    const codeRepos = () => {
      const seen = new Set<number>();
      const repos = viewer ? [...listReposForMember(deps.db, viewer), ...listAllVisible(deps.db, viewer)] : listAllVisible(deps.db, null);
      return repos.filter((repo) => {
        if (seen.has(repo.id)) return false;
        seen.add(repo.id);
        return true;
      });
    };
    const code = q && type === "code" ? await searchCode(deps, q, codeRepos()) : [];
    const tab = (name: string, label: string) => (
      <a class={type === name ? "text-bold mr-3" : "mr-3"} href={`/search?q=${encodeURIComponent(q)}&type=${name}`}>{label}</a>
    );
    return render(
      c,
      q ? `Search: ${q}` : "Explore",
      <div class="container-lg p-responsive py-4">
        <form action="/search" method="get" class="d-flex mb-3">
          <input type="hidden" name="type" value={type} />
          <input class="form-control flex-auto mr-2" type="search" name="q" value={q} placeholder="Search" aria-label="Search" />
          <button class="btn" type="submit">Search</button>
        </form>
        <nav class="mb-3" aria-label="Search type">{tab("repos", "Repositories")}{tab("issues", "Issues")}{tab("users", "Users")}{tab("code", "Code")}</nav>
        <h1 class="f3 text-normal mb-3">{q ? "Results" : "Recently created repositories"}</h1>
        {type === "repos" && (repos.length === 0 ? <div class="blankslate Box"><h3 class="blankslate-heading">No repositories found</h3></div> : <div class="Box">{repos.map((r) => <RepoListItem repo={r} showOwner />)}</div>)}
        {type === "issues" && (issues.length === 0 ? <div class="blankslate Box"><h3 class="blankslate-heading">No issues found</h3></div> : <div class="Box">{issues.map((hit) => <a class="Box-row d-block" href={`/${hit.owner}/${hit.name}/${hit.isPull ? "pull" : "issues"}/${hit.number}`}>{hit.owner}/{hit.name}#{hit.number} {hit.title}</a>)}</div>)}
        {type === "users" && (users.length === 0 ? <div class="blankslate Box"><h3 class="blankslate-heading">No people found</h3></div> : <div class="Box">{users.map((hit) => <a class="Box-row d-block" href={`/${hit.username}`}>{hit.username}{hit.kind === "org" ? " · organization" : ""}</a>)}</div>)}
        {type === "code" && (code.length === 0 ? <div class="blankslate Box"><h3 class="blankslate-heading">No code found</h3></div> : <div class="Box">{code.map((hit) => <a class="Box-row d-block" href={blobUrl(hit.owner, hit.name, hit.ref, hit.path)}><span class="text-mono f6">{hit.owner}/{hit.name}:{hit.path}:{hit.line}</span><div>{hit.text}</div></a>)}</div>)}
      </div>,
    );
  });
}
