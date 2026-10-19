import type { Context } from "hono";
import type { Deps } from "../deps.js";
import type { Repo } from "../git/repo.js";
import { countIssues } from "../services/issues.js";
import { accessLevel, can, type Access } from "../services/permissions.js";
import { forkParent, getRepo, gitFor, isStarred, listForks, type RepoRow } from "../services/repos.js";
import { getWatch, watcherCount, type WatchLevel } from "../services/watches.js";
import { getUserByEmail } from "../services/users.js";
import type { Env } from "./env.js";
import { loginRedirect } from "./middleware.js";
import { notFound, renderError } from "./render.js";

export type RepoCtx = {
  repo: RepoRow;
  git: Repo;
  access: Access;
  starred: boolean;
  counts: { issues: number; pulls: number };
  /** People who chose "All activity". */
  watchers: number;
  forks: number;
  watchLevel: WatchLevel;
  /** Set only when the viewer may see the parent repository. */
  forkedFrom: { owner: string; name: string } | null;
  /** Maps a commit author email to a Insitio username when one matches. */
  userForEmail: (email: string) => string | null;
};

/**
 * Resolves :owner/:repo for the current viewer. Hidden repos are a 404, never a 403,
 * so private repo names don't leak. Returns a Response when the request should stop.
 */
export async function loadRepo(deps: Deps, c: Context<Env>, need: Access = "read"): Promise<RepoCtx | Response> {
  const repo = getRepo(deps.db, c.req.param("owner") ?? "", c.req.param("repo") ?? "");
  const user = c.get("user");
  if (!repo) return await notFound(c, "This repository");
  const path = c.req.path;
  if (!repo.issuesEnabled && /\/(issues|milestones)(\/|$)/.test(path)) return await notFound(c, "This repository");
  if (!repo.pullsEnabled && /\/(pulls?|compare)(\/|$)/.test(path)) return await notFound(c, "This repository");
  const access = accessLevel(deps.db, user, repo);
  if (access === "none") return await notFound(c, "This repository");
  const settings = /^\/[^/]+\/[^/]+\/settings(?:\/|$)/.test(path);
  const social = /\/(star|unstar|watch|fork)$/.test(path);
  if (repo.archived && c.req.method !== "GET" && c.req.method !== "HEAD" && !settings && !social) {
    return renderError(c, 403, "This repository is archived.");
  }
  if (!can(access, need)) {
    if (!user) return loginRedirect(c);
    return await renderError(c, 403, "You don't have permission to do that in this repository.");
  }
  const cache = new Map<string, string | null>();
  return {
    repo,
    git: gitFor(deps, repo),
    access,
    starred: user ? isStarred(deps.db, user.id, repo.id) : false,
    counts: {
      issues: countIssues(deps.db, repo.id, false).open,
      pulls: countIssues(deps.db, repo.id, true).open,
    },
    watchers: watcherCount(deps.db, repo.id),
    forks: listForks(deps.db, repo.id, user).length,
    watchLevel: user ? getWatch(deps.db, user.id, repo.id) : "participating",
    forkedFrom: forkParent(deps.db, repo, user),
    userForEmail: (email) => {
      const key = email.toLowerCase();
      if (!cache.has(key)) cache.set(key, getUserByEmail(deps.db, email)?.username ?? null);
      return cache.get(key)!;
    },
  };
}
