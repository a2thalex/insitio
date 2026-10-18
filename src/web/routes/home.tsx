import type { Hono } from "hono";
import type { Deps } from "../../deps.js";
import { listAllVisible, listReposForMember, listStarred, searchRepos, type RepoRow } from "../../services/repos.js";
import { recentOpenIssues } from "../../services/issues.js";
import type { Env } from "../env.js";
import { render } from "../render.js";
import { Avatar, InsitioMark, Octicon, TimeAgo } from "../views/layout.js";
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

export function homeRoutes(deps: Deps, app: Hono<Env>) {
  app.get("/", (c) => {
    const user = c.get("user");
    if (!user) {
      return render(
        c,
        "",
        <div class="constellation">
          <div class="container-md p-responsive py-6 text-center">
            <InsitioMark size={72} />
            <span class="eyebrow mt-4">Private, invite-only git hosting</span>
            <h1 class="f00-light mt-2">Code that stays where it belongs.</h1>
            <p class="f2 serif color-fg-accent mt-1">In situ.</p>
            <p class="f4 color-fg-muted mt-3 mb-5 mx-auto" style="max-width:520px">
              Repositories, issues and pull requests on your own server, for the people you invite.
            </p>
            <a class="btn btn-primary btn-large" href="/login">Sign in</a>
            <p class="color-fg-muted f6 mt-3">Have an invite link? Open it to create your account.</p>
            <div class="d-flex flex-wrap flex-justify-center mt-6 text-left" style="gap:16px">
              {[
                ["01", "Repositories", "Push and clone over HTTPS with personal access tokens. Browse code, history and diffs."],
                ["02", "Issues", "Track work with Markdown discussions, labels and filters."],
                ["03", "Pull requests", "Review changes side by side and merge them on the server."],
              ].map(([n, title, body]) => (
                <div class="Box p-4" style="flex:1 1 220px;max-width:280px">
                  <span class="eyebrow eyebrow-accent">{n}</span>
                  <h2 class="f3 mt-1 mb-2">{title}</h2>
                  <p class="f6 color-fg-muted mb-0">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>,
      );
    }
    const mine = listReposForMember(deps.db, user);
    const starred = listStarred(deps.db, user.id, user);
    const byId = new Map(mine.map((r) => [r.id, r]));
    const activity = recentOpenIssues(deps.db, mine.map((r) => r.id));
    return render(
      c,
      "Dashboard",
      <div class="container-xl p-responsive py-4 d-md-flex">
        <aside class="col-md-4 col-lg-3 pr-md-4 mb-4" aria-label="Your repositories">
          <div class="d-flex flex-items-center flex-justify-between mb-2">
            <h2 class="f5">Top repositories</h2>
            <a class="btn btn-sm btn-primary" href="/new"><Octicon name="repo" class="mr-1" />New</a>
          </div>
          {mine.length === 0 ? (
            <p class="color-fg-muted f6">You don't have any repositories yet.</p>
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
        <section class="flex-auto" aria-label="Recent activity">
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
      </div>,
    );
  });

  app.get("/search", (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const results = q ? searchRepos(deps.db, q, c.get("user")) : listAllVisible(deps.db, c.get("user"));
    return render(
      c,
      q ? `Search: ${q}` : "Explore",
      <div class="container-lg p-responsive py-4">
        <form action="/search" method="get" class="d-flex mb-4">
          <input class="form-control flex-auto mr-2" type="search" name="q" value={q} placeholder="Search repositories" aria-label="Search repositories" />
          <button class="btn" type="submit">Search</button>
        </form>
        <h1 class="f3 text-normal mb-3">{q ? `${results.length} repository results` : "Recently created repositories"}</h1>
        {results.length === 0 ? (
          <div class="blankslate Box">
            <Octicon name="search" size={24} />
            <h3 class="blankslate-heading">No repositories found</h3>
          </div>
        ) : (
          <div class="Box">{results.map((r) => <RepoListItem repo={r} showOwner />)}</div>
        )}
      </div>,
    );
  });
}
