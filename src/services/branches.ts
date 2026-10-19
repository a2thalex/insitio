import type { DatabaseSync } from "node:sqlite";
import { GitError } from "../git/run.js";
import { RefMovedError, type Repo } from "../git/repo.js";
import { NotFoundError, ValidationError } from "./errors.js";
import type { RepoRow } from "./repos.js";

type PullHit = { number: number };

export function openPullsForBranch(db: DatabaseSync, repoId: number, branch: string): PullHit[] {
  return db
    .prepare(
      `select i.number as number from issues i join pulls p on p.issue_id = i.id
       where i.repo_id = ? and i.is_pull = 1 and i.state = 'open' and p.head_ref = ?
       order by i.number`,
    )
    .all(repoId, branch) as PullHit[];
}

export async function createBranchFrom(git: Repo, name: string, source: string): Promise<void> {
  const valid = await git.validBranchName(name.trim());
  if (!valid) throw new ValidationError("That branch name is not allowed.");
  if (!(await git.resolve(source.trim()))) throw new ValidationError("That branch, tag or commit doesn't exist.");
  try {
    await git.createBranch(valid, source.trim());
  } catch (err) {
    if (err instanceof RefMovedError) throw new ValidationError(`A branch named ${valid} already exists.`);
    if (err instanceof GitError) throw new ValidationError("That branch could not be created.");
    throw err;
  }
}

/** Deletes the branch and returns the sha it pointed at, so the page can offer Restore. */
export async function deleteBranchIfAllowed(db: DatabaseSync, git: Repo, repo: RepoRow, name: string): Promise<string> {
  if (name === repo.defaultBranch) throw new ValidationError("The default branch can't be deleted.");
  const sha = await git.branchTip(name);
  if (!sha) throw new NotFoundError();
  const pulls = openPullsForBranch(db, repo.id, name);
  if (pulls.length) {
    const which = pulls.map((pull) => `#${pull.number}`).join(", ");
    throw new ValidationError(`Branch ${name} is used by pull request ${which} and can't be deleted.`);
  }
  try {
    await git.deleteBranch(name, sha);
  } catch (err) {
    if (err instanceof RefMovedError) throw new ValidationError("This branch changed while you were looking at it. Reload and try again.");
    throw err;
  }
  return sha;
}

export async function restoreBranch(git: Repo, name: string, sha: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/i.test(sha) || !(await git.resolve(sha))) throw new ValidationError("That commit no longer exists.");
  const valid = await git.validBranchName(name);
  if (!valid) throw new ValidationError("That branch name is not allowed.");
  try {
    await git.createBranch(valid, sha);
  } catch (err) {
    if (err instanceof RefMovedError) throw new ValidationError(`A branch named ${valid} already exists.`);
    throw err;
  }
}
