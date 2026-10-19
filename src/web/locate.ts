import { splitRefAndPath } from "../git/refs.js";
import { GitError, assertSafePath } from "../git/run.js";
import type { RepoCtx } from "./repoContext.js";

export type Located = { ref: string; path: string; sha: string };

/** Splits "<ref>/<path>" using the repo's real branch and tag names. */
export async function locateRef(ctx: RepoCtx, rest: string): Promise<Located | null> {
  const split = splitRefAndPath(rest, await ctx.git.refNames());
  if (!split) return null;
  try {
    assertSafePath(split.path);
    const sha = await ctx.git.resolve(split.ref);
    return sha ? { ...split, sha } : null;
  } catch (err) {
    if (err instanceof GitError) return null;
    throw err;
  }
}
