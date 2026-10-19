import type { Context, Hono } from "hono";
import type { Deps } from "../../deps.js";
import { repoAnalysis } from "../../services/analyze.js";
import { ValidationError } from "../../services/errors.js";
import { forkRepo } from "../../services/forks.js";
import { listForks, normalizeWebsite, searchRepos, updateAbout } from "../../services/repos.js";
import { parseTopics, setTopics } from "../../services/topics.js";
import { listWatchers, setWatch } from "../../services/watches.js";
import type { Env } from "../env.js";
import { field, form, loginRedirect, safeNext } from "../middleware.js";
import { repoUrl } from "../paths.js";
import { notFound, render } from "../render.js";
import { Avatar, Octicon } from "../views/layout.js";
import { RepoListItem } from "../views/repoList.js";
import { repoPage, withRepo } from "./code.js";

function backTo(c: Context<Env>, deps: Deps, fallback: string): string {
  const header = c.req.header("referer");
  if (!header) return fallback;
  try {
    const url = new URL(header);
    if (url.origin === new URL(deps.config.baseUrl).origin) return safeNext(url.pathname + url.search);
  } catch {
    // ignore a referer that is not a URL
  }
  return fallback;
}

export function socialRoutes(deps: Deps, app: Hono<Env>) {
  const R = "/:owner/:repo";

  app.post(`${R}/fork`, withRepo(deps, "read", async (c, ctx) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const fork = await forkRepo(deps, user, ctx.repo);
    return c.redirect(repoUrl(fork.owner, fork.name));
  }));

  app.get(`${R}/forks`, withRepo(deps, "read", async (c, ctx) => {
    const forks = listForks(deps.db, ctx.repo.id, c.get("user"));
    const { owner, name } = ctx.repo;
    return repoPage(
      c,
      ctx,
      "code",
      `Forks · ${owner}/${name}`,
      <>
        <h1 class="f3 text-normal mb-3">Forks</h1>
        {forks.length === 0 ? (
          <div class="blankslate Box"><h3 class="blankslate-heading">No forks yet.</h3></div>
        ) : (
          <div class="Box">{forks.map((repo) => <RepoListItem repo={repo} showOwner />)}</div>
        )}
      </>,
    );
  }));

  app.post(`${R}/watch`, withRepo(deps, "read", async (c, ctx) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    setWatch(deps.db, user.id, ctx.repo.id, field(await form(c), "level"));
    return c.redirect(backTo(c, deps, repoUrl(ctx.repo.owner, ctx.repo.name)));
  }));

  app.get(`${R}/watchers`, withRepo(deps, "read", async (c, ctx) => {
    const people = listWatchers(deps.db, ctx.repo.id);
    return repoPage(
      c,
      ctx,
      "code",
      `Watchers · ${ctx.repo.owner}/${ctx.repo.name}`,
      <>
        <h1 class="f3 text-normal mb-3">Watchers</h1>
        {people.length === 0 ? (
          <div class="blankslate Box"><h3 class="blankslate-heading">No one is watching every event yet.</h3></div>
        ) : (
          <ul class="Box list-style-none">
            {people.map((person) => (
              <li class="Box-row d-flex flex-items-center">
                <Avatar name={person.username} size={24} class="mr-2" />
                <a href={`/${person.username}`}>{person.username}</a>
                {person.displayName && <span class="color-fg-muted ml-2">{person.displayName}</span>}
              </li>
            ))}
          </ul>
        )}
      </>,
    );
  }));

  app.post(`${R}/about`, withRepo(deps, "admin", async (c, ctx) => {
    const f = await form(c);
    const home = repoUrl(ctx.repo.owner, ctx.repo.name);
    try {
      const website = normalizeWebsite(field(f, "website"));
      const topics = parseTopics(field(f, "topics"));
      updateAbout(deps.db, ctx.repo.id, { description: field(f, "description"), website });
      setTopics(deps.db, ctx.repo.id, topics);
      return c.redirect(home);
    } catch (err) {
      if (err instanceof ValidationError) return c.redirect(`${home}?error=${encodeURIComponent(err.message)}`);
      throw err;
    }
  }));

  app.get(`${R}/graphs/contributors`, withRepo(deps, "read", async (c, ctx) => {
    const ref = await ctx.git.resolve(ctx.repo.defaultBranch);
    if (!ref) return notFound(c);
    const analysis = await repoAnalysis(deps, ctx.repo, ref);
    const { owner, name } = ctx.repo;
    return repoPage(
      c,
      ctx,
      "code",
      `Contributors · ${owner}/${name}`,
      <>
        <h1 class="f3 text-normal mb-3">Contributors</h1>
        <ul class="Box list-style-none">
          {analysis.contributors.length === 0 && <li class="Box-row color-fg-muted">No commits yet.</li>}
          {analysis.contributors.map((person) => {
            const username = ctx.userForEmail(person.email);
            return (
              <li class="Box-row d-flex flex-items-center">
                <Avatar name={username ?? person.name} size={24} class="mr-2" />
                {username ? <a class="text-bold" href={`/${username}`}>{username}</a> : <span class="text-bold">{person.name}</span>}
                <span class="color-fg-muted ml-2 text-mono f6">{person.email}</span>
                <span class="ml-auto">{person.commits} commit{person.commits === 1 ? "" : "s"}</span>
              </li>
            );
          })}
        </ul>
      </>,
    );
  }));

  app.get("/topics/:topic", (c) => {
    const topic = (c.req.param("topic") ?? "").toLowerCase();
    if (!/^[a-z0-9-]{1,50}$/.test(topic)) return notFound(c, "This topic");
    const repos = searchRepos(deps.db, `topic:${topic}`, c.get("user"));
    return render(
      c,
      `Topic: ${topic}`,
      <div class="container-lg p-responsive py-4">
        <h1 class="f3 text-normal mb-3"><Octicon name="hash" class="mr-2" />{topic}</h1>
        {repos.length === 0 ? (
          <div class="blankslate Box"><h3 class="blankslate-heading">No repositories with this topic.</h3></div>
        ) : (
          <div class="Box">{repos.map((repo) => <RepoListItem repo={repo} showOwner />)}</div>
        )}
      </div>,
    );
  });
}
