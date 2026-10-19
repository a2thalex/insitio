import { GitError } from "./run.js";

/** A path that may be written into a git tree. Rejects escapes, `.git`, and empty segments. */
export function assertCommitPath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /[\0-\x1f\x7f\\]/.test(path) ||
    path.split("/").some((s) => s === "" || s === "." || s === ".." || s === ".git")
  ) {
    throw new GitError(["check-path"], null, `invalid path: ${JSON.stringify(path)}`);
  }
}

/** `<repo>-<ref>/`, with characters git would dislike in a prefix turned into dashes. */
export function archivePrefix(repoName: string, ref: string): string {
  const slug = `${repoName}-${ref}`.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${(slug || "archive").slice(0, 200)}/`;
}
