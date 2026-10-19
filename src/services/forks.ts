import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { now, tx } from "../db/db.js";
import type { Deps } from "../deps.js";
import { runGit } from "../git/run.js";
import { removeRepoDir, repoDir } from "../git/storage.js";
import { createDefaultLabels } from "./issues.js";
import { ValidationError } from "./errors.js";
import { getRepo, getRepoById, validateRepoName, type RepoRow } from "./repos.js";
import type { User } from "./users.js";

/** `<name>`, or `<name>-2` and on when that owner already has the name. */
export function forkName(deps: Deps, owner: string, base: string): string {
  const root = validateRepoName(base);
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? root : `${root}-${i}`;
    if (candidate.length > 100) break;
    if (!getRepo(deps.db, owner, candidate)) return candidate;
  }
  throw new ValidationError("Could not find a free name for the fork.");
}

/** Bare-clones the source (hardlinked objects) into `<you>/<name>` with the same visibility. */
export async function forkRepo(deps: Deps, user: User, source: RepoRow): Promise<RepoRow> {
  const name = forkName(deps, user.username, source.name);
  const id = tx(deps.db, () => {
    const res = deps.db
      .prepare(
        `insert into repos (owner_id, name, description, is_private, default_branch, created_at, website, forked_from_id)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(user.id, name, source.description, source.isPrivate ? 1 : 0, source.defaultBranch, now(), source.website, source.id);
    const repoId = Number(res.lastInsertRowid);
    deps.db.prepare("insert into repo_counters (repo_id) values (?)").run(repoId);
    createDefaultLabels(deps.db, repoId);
    return repoId;
  });
  const dest = repoDir(deps.config.dataDir, user.username, name);
  const sourceDir = repoDir(deps.config.dataDir, source.owner, source.name);
  try {
    await mkdir(dirname(dest), { recursive: true });
    await runGit(dirname(dest), ["clone", "-q", "--bare", "--local", sourceDir, dest]);
    await runGit(dest, ["config", "http.receivepack", "true"]);
    await runGit(dest, ["config", "receive.denyNonFastForwards", "false"]);
  } catch (err) {
    deps.db.prepare("delete from repos where id = ?").run(id);
    await removeRepoDir(dest);
    throw err;
  }
  return getRepoById(deps.db, id)!;
}
