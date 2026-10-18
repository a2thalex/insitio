import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_ENV, GitError, assertSafePath, assertSafeRef, runGit } from "./run.js";
import { parseUnifiedDiff, type DiffFile } from "./diff.js";

export class MergeConflictError extends Error {
  constructor() {
    super("The branches have conflicts that must be resolved");
  }
}

export class RefMovedError extends Error {
  constructor(ref: string) {
    super(`${ref} changed during the operation; try again`);
  }
}

export type Author = { name: string; email: string };
export type Mergeability = "clean" | "conflict" | "up_to_date" | "missing";

const ZERO_SHA = "0".repeat(40);

function authorEnv(a: Author): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: a.name,
    GIT_AUTHOR_EMAIL: a.email,
    GIT_COMMITTER_NAME: a.name,
    GIT_COMMITTER_EMAIL: a.email,
  };
}

export type Commit = {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  /** Author date, unix seconds. */
  date: number;
  subject: string;
  body: string;
};

export type Branch = { name: string; sha: string; date: number };
export type TreeEntry = {
  name: string;
  path: string;
  type: "tree" | "blob" | "commit";
  mode: string;
  size: number | null;
  oid: string;
};

const FS = "\x1f";
const RS = "\x1e";
const COMMIT_FORMAT = ["%H", "%an", "%ae", "%at", "%s", "%b"].join("%x1f");
const MAX_DIFF_BYTES = 8 * 1024 * 1024;

function parseCommit(record: string): Commit {
  const [sha, authorName, authorEmail, date, subject, body] = record.split(FS);
  return {
    sha,
    shortSha: sha.slice(0, 7),
    authorName,
    authorEmail,
    date: Number(date),
    subject,
    body: (body ?? "").trim(),
  };
}

function parseCommits(out: string): Commit[] {
  return out
    .split(RS)
    .map((r) => r.replace(/^\n+/, ""))
    .filter((r) => r.length > 0)
    .map(parseCommit);
}

/** A bare repository on disk, accessed through the git CLI. */
export class Repo {
  constructor(readonly dir: string) {}

  protected git(args: string[], opts?: Parameters<typeof runGit>[2]) {
    return runGit(this.dir, args, opts);
  }

  async isEmpty(): Promise<boolean> {
    const { stdout } = await this.git(["for-each-ref", "--count=1", "--format=%(refname)", "refs/heads"]);
    return stdout.toString().trim() === "";
  }

  async branches(): Promise<Branch[]> {
    const { stdout } = await this.git([
      "for-each-ref",
      "--sort=-committerdate",
      `--format=%(refname:short)${"%1f"}%(objectname)${"%1f"}%(committerdate:unix)`,
      "refs/heads",
    ]);
    return stdout
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [name, sha, date] = l.split(FS);
        return { name, sha, date: Number(date) };
      });
  }

  async tags(): Promise<string[]> {
    const { stdout } = await this.git(["for-each-ref", "--sort=-creatordate", "--format=%(refname:short)", "refs/tags"]);
    return stdout.toString().split("\n").filter(Boolean);
  }

  /** Branch and tag names, for splitting URL paths. */
  async refNames(): Promise<string[]> {
    const [b, t] = await Promise.all([this.branches(), this.tags()]);
    return [...b.map((x) => x.name), ...t];
  }

  async defaultBranch(): Promise<string> {
    const { stdout } = await this.git(["symbolic-ref", "--short", "HEAD"]);
    return stdout.toString().trim();
  }

  async setHead(branch: string): Promise<void> {
    assertSafeRef(branch);
    await this.git(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  }

  /** Resolves a branch, tag or commit id to a full commit sha, or null. */
  async resolve(ref: string): Promise<string | null> {
    assertSafeRef(ref);
    const { stdout, code } = await this.git(["rev-parse", "--verify", "-q", "--end-of-options", `${ref}^{commit}`], {
      okCodes: [0, 1, 128],
    });
    return code === 0 ? stdout.toString().trim() : null;
  }

  async objectType(ref: string, path: string): Promise<"tree" | "blob" | "commit" | null> {
    assertSafeRef(ref);
    assertSafePath(path);
    const { stdout, code } = await this.git(["cat-file", "-t", `${ref}:${path}`], { okCodes: [0, 1, 128] });
    if (code !== 0) return null;
    const t = stdout.toString().trim();
    return t === "tree" || t === "blob" || t === "commit" ? t : null;
  }

  /** Lists one directory: trees first, then submodules, then blobs, each in git order. */
  async tree(ref: string, path: string): Promise<TreeEntry[]> {
    assertSafeRef(ref);
    assertSafePath(path);
    const { stdout } = await this.git(["ls-tree", "-z", "-l", `${ref}:${path}`]);
    const order = { tree: 0, commit: 1, blob: 2 };
    return stdout
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((rec): TreeEntry => {
        const tab = rec.indexOf("\t");
        const [mode, type, oid, size] = rec.slice(0, tab).split(/\s+/);
        const name = rec.slice(tab + 1);
        return {
          name,
          path: path ? `${path}/${name}` : name,
          type: type as TreeEntry["type"],
          mode,
          size: size === "-" ? null : Number(size),
          oid,
        };
      })
      .sort((a, b) => order[a.type] - order[b.type]);
  }

  async blob(ref: string, path: string, maxBytes: number): Promise<{ content: Buffer; size: number; truncated: boolean }> {
    assertSafeRef(ref);
    assertSafePath(path);
    const spec = `${ref}:${path}`;
    const size = Number((await this.git(["cat-file", "-s", spec])).stdout.toString().trim());
    const { stdout, truncated } = await this.git(["cat-file", "blob", spec], { maxBytes });
    return { content: stdout, size, truncated };
  }

  async log(ref: string, opts: { path?: string; skip: number; limit: number }): Promise<Commit[]> {
    assertSafeRef(ref);
    if (opts.path) assertSafePath(opts.path);
    const sha = await this.resolve(ref);
    if (!sha) return [];
    const args = ["log", `--format=${COMMIT_FORMAT}%x1e`, `--skip=${opts.skip}`, `--max-count=${opts.limit}`, sha];
    if (opts.path) args.push("--", opts.path);
    return parseCommits((await this.git(args)).stdout.toString());
  }

  async commitCount(ref: string): Promise<number> {
    const sha = await this.resolve(ref);
    if (!sha) return 0;
    return Number((await this.git(["rev-list", "--count", sha])).stdout.toString().trim());
  }

  /** A commit with its parents and its diff against the first parent. */
  async commit(ref: string): Promise<Commit & { parents: string[]; files: DiffFile[]; diffTruncated: boolean }> {
    const sha = await this.resolve(ref);
    if (!sha) throw new GitError(["show"], 128, `unknown commit ${ref}`);
    const meta = (await this.git(["log", "-1", `--format=%P%x1e${COMMIT_FORMAT}`, sha])).stdout.toString();
    const sep = meta.indexOf(RS);
    const parents = meta.slice(0, sep).trim().split(" ").filter(Boolean);
    const commit = parseCommit(meta.slice(sep + 1).replace(/\n$/, ""));
    const diffArgs = parents.length
      ? ["diff-tree", "-p", "-M", "--no-color", "--no-ext-diff", parents[0], sha]
      : ["diff-tree", "-p", "-M", "--no-color", "--no-ext-diff", "--root", sha];
    const { stdout, truncated } = await this.git(diffArgs, { maxBytes: MAX_DIFF_BYTES });
    return { ...commit, parents, files: parseUnifiedDiff(stdout.toString()), diffTruncated: truncated };
  }

  /** Commits files onto a branch without a worktree; a missing branch starts from `from` (or as a root commit). */
  async commitFiles(branch: string, files: Record<string, string>, message: string, author: Author, from?: string): Promise<string> {
    assertSafeRef(branch);
    const existing = await this.resolve(branch);
    const parent = existing ?? (from ? await this.resolve(from) : null);
    const tmp = await mkdtemp(join(tmpdir(), "insitio-index-"));
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    try {
      if (parent) await this.git(["read-tree", parent], { env });
      for (const [path, content] of Object.entries(files)) {
        assertSafePath(path);
        const blob = (await this.git(["hash-object", "-w", "--stdin"], { input: content })).stdout.toString().trim();
        await this.git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
      }
      const tree = (await this.git(["write-tree"], { env })).stdout.toString().trim();
      const commitArgs = ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message];
      const sha = (await this.git(commitArgs, { env: authorEnv(author) })).stdout.toString().trim();
      await this.updateRef(branch, sha, existing ?? ZERO_SHA);
      return sha;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  private async updateRef(branch: string, sha: string, expectedOld: string): Promise<void> {
    try {
      await this.git(["update-ref", `refs/heads/${branch}`, sha, expectedOld]);
    } catch (err) {
      if (err instanceof GitError) throw new RefMovedError(branch);
      throw err;
    }
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const { stdout, code } = await this.git(["merge-base", a, b], { okCodes: [0, 1] });
    return code === 0 ? stdout.toString().trim() : null;
  }

  /** Commits on head but not base (oldest first) and the diff from their merge base. */
  async compare(base: string, head: string): Promise<{ mergeBase: string | null; commits: Commit[]; files: DiffFile[]; diffTruncated: boolean }> {
    const [b, h] = await Promise.all([this.resolve(base), this.resolve(head)]);
    if (!b || !h) return { mergeBase: null, commits: [], files: [], diffTruncated: false };
    const mergeBase = await this.mergeBase(b, h);
    const log = await this.git(["log", "--reverse", `--format=${COMMIT_FORMAT}%x1e`, "--max-count=250", `${b}..${h}`]);
    const diff = await this.git(["diff-tree", "-p", "-M", "--no-color", "--no-ext-diff", mergeBase ?? b, h], {
      maxBytes: MAX_DIFF_BYTES,
    });
    return {
      mergeBase,
      commits: parseCommits(log.stdout.toString()),
      files: parseUnifiedDiff(diff.stdout.toString()),
      diffTruncated: diff.truncated,
    };
  }

  async mergeability(base: string, head: string): Promise<Mergeability> {
    const [b, h] = await Promise.all([this.resolve(base), this.resolve(head)]);
    if (!b || !h) return "missing";
    const anc = await this.git(["merge-base", "--is-ancestor", h, b], { okCodes: [0, 1] });
    if (anc.code === 0) return "up_to_date";
    const { code } = await this.git(["merge-tree", "--write-tree", "--no-messages", b, h], { okCodes: [0, 1] });
    return code === 0 ? "clean" : "conflict";
  }

  /** Creates a merge commit of head into base, like GitHub's "Create a merge commit". */
  async merge(base: string, head: string, message: string, author: Author): Promise<string> {
    assertSafeRef(base);
    const [b, h] = await Promise.all([this.resolve(base), this.resolve(head)]);
    if (!b || !h) throw new GitError(["merge"], 128, "branch not found");
    const anc = await this.git(["merge-base", "--is-ancestor", h, b], { okCodes: [0, 1] });
    if (anc.code === 0) throw new GitError(["merge"], 1, "nothing to merge");
    const mt = await this.git(["merge-tree", "--write-tree", "--no-messages", b, h], { okCodes: [0, 1] });
    if (mt.code === 1) throw new MergeConflictError();
    const tree = mt.stdout.toString().split("\n")[0].trim();
    const sha = (
      await this.git(["commit-tree", tree, "-p", b, "-p", h, "-m", message], { env: authorEnv(author) })
    ).stdout.toString().trim();
    await this.updateRef(base, sha, b);
    return sha;
  }

  /** Case-insensitive fixed-string search over text files at a ref. */
  async grep(ref: string, query: string, limit: number): Promise<{ path: string; lines: { no: number; text: string }[] }[]> {
    const sha = await this.resolve(ref);
    if (!sha || !query) return [];
    const { stdout } = await this.git(
      ["grep", "-z", "-n", "-I", "-i", "-F", "--max-count=20", "-e", query, sha, "--"],
      { okCodes: [0, 1], maxBytes: 4 * 1024 * 1024 },
    );
    const results: { path: string; lines: { no: number; text: string }[] }[] = [];
    let total = 0;
    for (const rec of stdout.toString().split("\n")) {
      if (!rec) continue;
      const [file, no, ...rest] = rec.split("\0");
      const path = file.slice(sha.length + 1);
      let entry = results.at(-1);
      if (!entry || entry.path !== path) {
        if (results.length >= limit) break;
        entry = { path, lines: [] };
        results.push(entry);
      }
      entry.lines.push({ no: Number(no), text: rest.join("\0").slice(0, 500) });
      if (++total >= limit * 20) break;
    }
    return results;
  }

  /**
   * The most recent commit touching each named child of dirPath, found by walking
   * history once and stopping as soon as every name is seen.
   */
  lastCommitsFor(ref: string, dirPath: string, names: string[], maxCommits = 5000): Promise<Record<string, Commit>> {
    assertSafeRef(ref);
    assertSafePath(dirPath);
    return new Promise((resolve, reject) => {
      const wanted = new Set(names);
      const found: Record<string, Commit> = {};
      const prefix = dirPath ? dirPath + "/" : "";
      const args = [
        "-c", "core.quotepath=off",
        "log", `--format=${RS}%H${FS}%an${FS}%ae${FS}%at${FS}%s`, "--name-only", `--max-count=${maxCommits}`,
        "--end-of-options", ref, "--", dirPath || ".",
      ];
      const child = spawn("git", args, { cwd: this.dir, env: { ...process.env, ...GIT_ENV }, windowsHide: true });
      let buf = "";
      let stderr = "";
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        child.kill();
        resolve(found);
      };
      const consume = (record: string) => {
        const nl = record.indexOf("\n");
        const header = nl === -1 ? record : record.slice(0, nl);
        const commit = parseCommit(header + FS);
        for (const p of (nl === -1 ? "" : record.slice(nl + 1)).split("\n")) {
          if (!p || !p.startsWith(prefix)) continue;
          const name = p.slice(prefix.length).split("/")[0];
          if (wanted.has(name)) {
            found[name] = commit;
            wanted.delete(name);
          }
        }
        if (wanted.size === 0) finish();
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        if (done) return;
        buf += d;
        const parts = buf.split(RS);
        buf = parts.pop() ?? "";
        for (const part of parts) if (part) consume(part);
      });
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => {
        if (done) return;
        if (buf) consume(buf);
        if (code === 0 || done) finish();
        else reject(new GitError(args, code, stderr));
      });
    });
  }
}
