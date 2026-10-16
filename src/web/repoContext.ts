import type { Context } from "hono";
import type { Deps } from "../deps.js";
import type { Repo } from "../git/repo.js";
import { countIssues } from "../services/issues.js";
import { accessLevel, can, type Access } from "../services/permissions.js";
import { getRepo, gitFor, isStarred, type RepoRow } from "../services/repos.js";
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
  /** Maps a commit author email to a GitFkd username when one matches. */
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
  const access = accessLevel(deps.db, user, repo);
  if (access === "none") return await notFound(c, "This repository");
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
    userForEmail: (email) => {
      const key = email.toLowerCase();
      if (!cache.has(key)) cache.set(key, getUserByEmail(deps.db, email)?.username ?? null);
      return cache.get(key)!;
    },
  };
}
