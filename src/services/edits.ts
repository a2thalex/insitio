import { EmptyCommitError, PathConflictError, RefMovedError, type Repo, type TreeChange } from "../git/repo.js";
import { assertCommitPath } from "../git/paths.js";
import { GitError } from "../git/run.js";
import { ValidationError } from "./errors.js";
import { authorFor } from "./repos.js";
import type { User } from "./users.js";

/** The branch moved between page load and submit. The caller keeps the user's text. */
export class BranchChangedError extends Error {
  constructor() {
    super("This branch changed while you were editing");
  }
}

export function repoPath(path: string): string {
  try {
    assertCommitPath(path);
  } catch {
    throw new ValidationError("That file path is not allowed.");
  }
  return path;
}

/** Joins a directory from the URL with a filename from an upload. Slashes in the filename are folder paths. */
export function joinRepoPath(dir: string, name: string): string {
  const rel = name.replace(/\\/g, "/").replace(/^\/+/, "");
  return repoPath(dir ? `${dir}/${rel}` : rel);
}

export function defaultCommitMessage(action: "create" | "update" | "delete" | "upload", path: string): string {
  if (action === "upload") return "Add files via upload";
  const base = path.split("/").pop() || path;
  if (action === "create") return `Create ${base}`;
  if (action === "delete") return `Delete ${base}`;
  return `Update ${base}`;
}

export function commitMessage(action: "create" | "update" | "delete" | "upload", path: string, subject: string, body: string): string {
  const title = subject.trim() || defaultCommitMessage(action, path);
  const extra = body.trim();
  const message = extra ? `${title}\n\n${extra}` : title;
  if (message.length > 50_000) throw new ValidationError("Commit message is too long.");
  return message;
}

/** Keeps CRLF when the existing file used it on every line. Otherwise the text is stored as submitted. */
export function applyLineEndings(existing: Buffer | null, text: string): Buffer {
  if (existing && consistentCrlf(existing)) return Buffer.from(text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"), "utf8");
  return Buffer.from(text, "utf8");
}

function consistentCrlf(buf: Buffer): boolean {
  const text = buf.toString("utf8");
  return text.includes("\r\n") && !text.replace(/\r\n/g, "").includes("\n");
}

/**
 * One web edit. `newBranch` empty commits to `branch` only if it still points at `baseSha`.
 * A new branch is created at the resulting commit and must not already exist.
 */
export async function applyCommit(
  git: Repo,
  user: User,
  baseUrl: string,
  input: { branch: string; baseSha: string; newBranch: string; message: string; changes: TreeChange[] },
): Promise<{ sha: string; branch: string }> {
  const author = authorFor(user, baseUrl);
  try {
    if (input.newBranch.trim()) {
      const name = await git.validBranchName(input.newBranch.trim());
      if (!name) throw new ValidationError("That branch name is not allowed.");
      const sha = await git.commitChanges(name, input.changes, input.message, author, { expected: null, parent: input.baseSha });
      return { sha, branch: name };
    }
    const sha = await git.commitChanges(input.branch, input.changes, input.message, author, {
      expected: input.baseSha,
      parent: input.baseSha,
    });
    return { sha, branch: input.branch };
  } catch (err) {
    if (err instanceof RefMovedError) throw new BranchChangedError();
    if (err instanceof PathConflictError) throw new ValidationError(err.message);
    if (err instanceof EmptyCommitError) throw new ValidationError("There are no changes to commit.");
    if (err instanceof GitError && err.stderr.includes("parent not found")) {
      throw new ValidationError("The commit you started from no longer exists.");
    }
    if (err instanceof GitError && err.args[0] === "check-path") throw new ValidationError("That file path is not allowed.");
    throw err;
  }
}
