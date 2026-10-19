import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBlame, parseShortlog, type BlameHunk } from "./blame.js";
import { GIT_ENV, GitError, assertSafePath, assertSafeRef, runGit } from "./run.js";
import { assertCommitPath } from "./paths.js";
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

/** The resulting tree would contain both a file and a directory at one path. */
export class PathConflictError extends Error {
  constructor(readonly path: string) {
    super(`A path can't be both a file and a folder (${path})`);
  }
}

/** The edit produced the same tree as its parent. */
export class EmptyCommitError extends Error {
  constructor() {
    super("There are no changes to commit");
  }
}

export type TreeChange = { path: string; content?: Buffer; delete?: boolean };

export type TagInfo = {
  name: string;
  /** The commit the tag points at. */
  sha: string;
  /** Committer date of that commit, unix seconds. */
  date: number;
  annotated: boolean;
  /** Tag message for an annotated tag; empty for a lightweight tag. */
  message: string;
};

export type Contributor = { name: string; email: string; commits: number };

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

function assertNoPathConflict(paths: string[]): void {
  const sorted = [...paths].sort();
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1] || sorted[i].startsWith(`${sorted[i - 1]}/`)) throw new PathConflictError(sorted[i - 1]);
  }
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

  /** Messages of up to 100 commits reachable from `to` and not from `from`. */
  async commitMessages(from: string | null, to: string): Promise<{ sha: string; subject: string; body: string }[]> {
    if (from && !/^[0-9a-f]{40}$/i.test(from)) throw new GitError(["log"], 1, "bad range");
    if (!/^[0-9a-f]{40}$/i.test(to)) throw new GitError(["log"], 1, "bad range");
    const range = from ? `${from}..${to}` : to;
    const { stdout } = await this.git(["log", "--reverse", "--format=%H%x1f%s%x1f%b%x1e", "--max-count=100", range]);
    return stdout
      .toString("utf8")
      .split("\x1e")
      .map((record) => record.replace(/^\n+/, ""))
      .filter(Boolean)
      .map((record) => {
        const [sha, subject, body] = record.split("\x1f");
        return { sha, subject: subject ?? "", body: (body ?? "").trim() };
      })
      .filter((commit) => /^[0-9a-f]{40}$/i.test(commit.sha));
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
  async commitFiles(branch: string, files: Record<string, string>, message: string, author: Author, from?: string, expected?: string): Promise<string> {
    assertSafeRef(branch);
    const existing = expected ?? (await this.resolve(branch));
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

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const res = await this.git(["merge-base", "--is-ancestor", ancestor, descendant], { okCodes: [0, 1] });
    return res.code === 0;
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
  async merge(base: string, head: string, message: string, author: Author, pinned?: { base: string; head: string }): Promise<string> {
    assertSafeRef(base);
    const [b, h] = await Promise.all([this.resolve(base), this.resolve(head)]);
    if (!b || !h) throw new GitError(["merge"], 128, "branch not found");
    if (pinned && (b !== pinned.base || h !== pinned.head)) throw new RefMovedError(base);
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

  /** One commit on `base` with the merged tree and no second parent. */
  async squash(base: string, head: string, message: string, author: Author, pinned?: { base: string; head: string }): Promise<string> {
    assertSafeRef(base);
    const [b, h] = await Promise.all([this.resolve(base), this.resolve(head)]);
    if (!b || !h) throw new GitError(["merge"], 128, "branch not found");
    if (pinned && (b !== pinned.base || h !== pinned.head)) throw new RefMovedError(base);
    const anc = await this.git(["merge-base", "--is-ancestor", h, b], { okCodes: [0, 1] });
    if (anc.code === 0) throw new GitError(["merge"], 1, "nothing to merge");
    const mt = await this.git(["merge-tree", "--write-tree", "--no-messages", b, h], { okCodes: [0, 1] });
    if (mt.code === 1) throw new MergeConflictError();
    const tree = mt.stdout.toString().split("\n")[0].trim();
    const sha = (await this.git(["commit-tree", tree, "-p", b, "-m", message], { env: authorEnv(author) })).stdout.toString().trim();
    await this.updateRef(base, sha, b);
    return sha;
  }

  /**
   * Replays up to 100 commits from `head` onto `base`. A fast-forward moves the ref.
   * The ref stays put if any replayed commit conflicts.
   */
  async rebase(base: string, head: string, committer: Author, pinned?: { base: string; head: string }): Promise<string> {
    assertSafeRef(base);
    const [b, h] = await Promise.all([this.resolve(base), this.resolve(head)]);
    if (!b || !h) throw new GitError(["rebase"], 128, "branch not found");
    if (pinned && (b !== pinned.base || h !== pinned.head)) throw new RefMovedError(base);
    const headInBase = await this.git(["merge-base", "--is-ancestor", h, b], { okCodes: [0, 1] });
    if (headInBase.code === 0) throw new GitError(["rebase"], 1, "nothing to merge");
    const baseInHead = await this.git(["merge-base", "--is-ancestor", b, h], { okCodes: [0, 1] });
    if (baseInHead.code === 0) {
      await this.updateRef(base, h, b);
      return h;
    }
    const log = await this.git([
      "log",
      "--reverse",
      "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b%x1e",
      "--max-count=101",
      `${b}..${h}`,
    ]);
    const commits = log.stdout
      .toString("utf8")
      .split("\x1e")
      .map((record) => record.replace(/^\n+/, ""))
      .filter(Boolean)
      .map((record) => {
        const [sha, parents, name, email, at, subject, body] = record.split("\x1f");
        return {
          sha,
          parents: (parents ?? "").split(" ").filter(Boolean),
          name: name ?? "",
          email: email ?? "",
          at: at ?? "",
          subject: subject ?? "",
          body: body ?? "",
        };
      })
      .filter((commit) => /^[0-9a-f]{40}$/i.test(commit.sha));
    if (commits.length > 100) throw new GitError(["rebase"], 1, "more than 100 commits to rebase");
    if (commits.some((commit) => commit.parents.length > 1)) throw new GitError(["rebase"], 1, "rebase cannot replay a merge commit");
    let onto = b;
    for (const commit of commits) {
      const parent = commit.parents[0];
      if (!/^[0-9a-f]{40}$/i.test(parent)) throw new GitError(["rebase"], 1, "a commit has no parent");
      const mt = await this.git(
        ["merge-tree", "--write-tree", "--no-messages", `--merge-base=${parent}`, onto, commit.sha],
        { okCodes: [0, 1] },
      );
      if (mt.code === 1) throw new MergeConflictError();
      const tree = mt.stdout.toString().split("\n")[0].trim();
      const message = commit.body.trim() ? `${commit.subject}\n\n${commit.body.trim()}` : commit.subject;
      onto = (
        await this.git(["commit-tree", tree, "-p", onto, "-m", message], {
          env: {
            GIT_AUTHOR_NAME: commit.name,
            GIT_AUTHOR_EMAIL: commit.email,
            GIT_AUTHOR_DATE: `${commit.at} +0000`,
            GIT_COMMITTER_NAME: committer.name,
            GIT_COMMITTER_EMAIL: committer.email,
          },
        })
      ).stdout.toString().trim();
    }
    await this.updateRef(base, onto, b);
    return onto;
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

  /** True when refs/heads/name or refs/tags/name exists, without peeling it to a commit. */
  async hasRef(kind: "heads" | "tags", name: string): Promise<boolean> {
    assertSafeRef(name);
    const { code } = await this.git(["show-ref", "--verify", "--quiet", `refs/${kind}/${name}`], { okCodes: [0, 1] });
    return code === 0;
  }

  /** The commit a branch points at, or null. Does not resolve tags of the same name. */
  async branchTip(branch: string): Promise<string | null> {
    assertSafeRef(branch);
    const { stdout, code } = await this.git(["rev-parse", "--verify", "-q", "--end-of-options", `refs/heads/${branch}`], {
      okCodes: [0, 1, 128],
    });
    return code === 0 ? stdout.toString().trim() : null;
  }

  /** A branch name git itself would accept, or null. */
  async validBranchName(name: string): Promise<string | null> {
    if (!name || name.length > 250 || name.startsWith("-") || /[\0\n\r ~^:?*\[\\]/.test(name) || name.includes("..") || name.includes("@{")) {
      return null;
    }
    const { stdout, code } = await this.git(["check-ref-format", "--branch", name], { okCodes: [0, 1, 128] });
    if (code !== 0) return null;
    const out = stdout.toString().trim();
    return out === name ? out : null;
  }

  /** Creates `name` at `from` (branch, tag or sha). Fails if the branch already exists. */
  async createBranch(name: string, from: string): Promise<string> {
    const valid = await this.validBranchName(name);
    if (!valid) throw new GitError(["branch"], 1, "invalid branch name");
    const sha = await this.resolve(from);
    if (!sha) throw new GitError(["branch"], 128, "source not found");
    if (await this.branchTip(name)) throw new RefMovedError(name);
    await this.updateRef(name, sha, ZERO_SHA);
    return sha;
  }

  /** Deletes a branch only if it still points at `expectedSha`. */
  async deleteBranch(name: string, expectedSha: string): Promise<void> {
    assertSafeRef(name);
    if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new GitError(["branch"], 1, "bad sha");
    try {
      await this.git(["update-ref", "-d", `refs/heads/${name}`, expectedSha]);
    } catch (err) {
      if (err instanceof GitError) throw new RefMovedError(name);
      throw err;
    }
  }

  /** Annotated tag. Returns the commit sha it points at. */
  async createTag(name: string, target: string, message: string, author: Author): Promise<string> {
    if (!name || name.length > 250 || name.startsWith("-") || /[\0\n\r ~^:?*\[\\]/.test(name) || name.includes("..") || name.includes("@{")) {
      throw new GitError(["tag"], 1, "invalid tag name");
    }
    const check = await this.git(["check-ref-format", `refs/tags/${name}`], { okCodes: [0, 1] });
    if (check.code !== 0) throw new GitError(["tag"], 1, "invalid tag name");
    const sha = await this.resolve(target);
    if (!sha) throw new GitError(["tag"], 128, "target not found");
    const exists = await this.git(["show-ref", "--verify", "--quiet", `refs/tags/${name}`], { okCodes: [0, 1] });
    if (exists.code === 0) throw new GitError(["tag"], 1, "tag exists");
    await this.git(["tag", "-a", name, sha, "-m", message], { env: authorEnv(author) });
    return sha;
  }

  async tagList(): Promise<TagInfo[]> {
    // Real separators, not %xNN: for-each-ref on some Git builds prints %xNN literally.
    const format = ["%(refname:short)", "%(objecttype)", "%(*objectname)", "%(objectname)", "%(*committerdate:unix)", "%(committerdate:unix)", "%(contents:subject)", "%(contents:body)"].join(FS) + RS;
    const { stdout } = await this.git(["for-each-ref", "--sort=-creatordate", `--format=${format}`, "refs/tags"]);
    const out: TagInfo[] = [];
    for (const rec of stdout.toString("utf8").split(RS)) {
      const text = rec.replace(/^\n+/, "");
      if (!text.trim()) continue;
      const [name, type, peeled, objectName, peeledDate, committerDate, subject, body] = text.split(FS);
      const annotated = type === "tag";
      const sha = (annotated ? peeled : objectName) || objectName;
      const date = Number((annotated && peeledDate ? peeledDate : committerDate) || 0);
      const message = annotated ? [subject, (body ?? "").replace(/\s+$/, "")].filter(Boolean).join("\n\n") : "";
      if (name && /^[0-9a-f]{40}$/.test(sha)) out.push({ name, sha, date, annotated, message });
    }
    return out;
  }

  /** Every blob in the tree, with its size. */
  async listFiles(rev: string): Promise<{ path: string; size: number }[]> {
    assertSafeRef(rev);
    const sha = await this.resolve(rev);
    if (!sha) return [];
    const { stdout } = await this.git(["ls-tree", "-r", "-l", "-z", sha]);
    const out: { path: string; size: number }[] = [];
    for (const rec of stdout.toString("utf8").split("\0")) {
      if (!rec) continue;
      const tab = rec.indexOf("\t");
      if (tab < 0) continue;
      const meta = rec.slice(0, tab).split(/\s+/);
      if (meta[1] !== "blob") continue;
      out.push({ path: rec.slice(tab + 1), size: Number(meta[3]) || 0 });
    }
    return out;
  }

  async blame(rev: string, path: string): Promise<BlameHunk[]> {
    assertSafeRef(rev);
    assertSafePath(path);
    const sha = await this.resolve(rev);
    if (!sha) throw new GitError(["blame"], 128, "unknown revision");
    const { stdout, truncated } = await this.git(["blame", "--line-porcelain", sha, "--", path], { maxBytes: 8 * 1024 * 1024 });
    if (truncated) throw new GitError(["blame"], 1, "blame too large");
    return parseBlame(stdout.toString("utf8"));
  }

  /** Commit counts by author, as `git shortlog -sne`, most commits first. */
  async contributors(rev: string): Promise<Contributor[]> {
    assertSafeRef(rev);
    const sha = await this.resolve(rev);
    if (!sha) return [];
    const { stdout } = await this.git(["shortlog", "-sne", sha], { okCodes: [0, 1] });
    return parseShortlog(stdout.toString("utf8"));
  }

  /**
   * Commits `changes` onto `branch` without a worktree. `expected` is the sha the branch must
   * still have (null when the branch must not exist yet). `parent` is the tree the change is
   * based on. The ref is updated with compare-and-swap.
   */
  async commitChanges(
    branch: string,
    changes: TreeChange[],
    message: string,
    author: Author,
    opts: { expected: string | null; parent: string | null },
  ): Promise<string> {
    assertSafeRef(branch);
    if (!changes.length || !message.trim()) throw new EmptyCommitError();
    for (const change of changes) assertCommitPath(change.path);
    const current = await this.branchTip(branch);
    if (opts.expected === null) {
      if (current) throw new RefMovedError(branch);
    } else if (current !== opts.expected) {
      throw new RefMovedError(branch);
    }
    let parentSha: string | null = null;
    if (opts.parent) {
      parentSha = await this.resolve(opts.parent);
      if (!parentSha) throw new GitError(["commit"], 128, "parent not found");
    }
    const paths = new Set(parentSha ? (await this.listFiles(parentSha)).map((file) => file.path) : []);
    for (const change of changes) {
      if (change.delete) paths.delete(change.path);
      else paths.add(change.path);
    }
    assertNoPathConflict([...paths]);

    const tmp = await mkdtemp(join(tmpdir(), "insitio-index-"));
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    try {
      if (parentSha) await this.git(["read-tree", parentSha], { env });
      for (const change of changes) {
        if (change.delete) continue;
        const blob = (await this.git(["hash-object", "-w", "--stdin"], { input: change.content ?? Buffer.alloc(0) })).stdout.toString().trim();
        const mode = await this.indexMode(env, change.path);
        // --index-info does not need a work tree, and the path is not parsed as an option.
        await this.git(["update-index", "--index-info"], { env, input: `${mode} ${blob}\t${change.path}\n` });
      }
      for (const change of changes) {
        if (!change.delete) continue;
        await this.git(["update-index", "--index-info"], { env, input: `0 ${"0".repeat(40)}\t${change.path}\n` });
      }
      const tree = (await this.git(["write-tree"], { env })).stdout.toString().trim();
      if (parentSha) {
        const parentTree = (await this.git(["rev-parse", `${parentSha}^{tree}`])).stdout.toString().trim();
        if (parentTree === tree) throw new EmptyCommitError();
      }
      const sha = (
        await this.git(["commit-tree", tree, ...(parentSha ? ["-p", parentSha] : []), "-m", message], { env: authorEnv(author) })
      ).stdout.toString().trim();
      await this.updateRef(branch, sha, opts.expected ?? ZERO_SHA);
      return sha;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  private async indexMode(env: Record<string, string>, path: string): Promise<string> {
    const { stdout } = await this.git(["ls-files", "-s", "--", path], { env, okCodes: [0, 1] });
    return stdout.toString().startsWith("100755 ") ? "100755" : "100644";
  }
}
