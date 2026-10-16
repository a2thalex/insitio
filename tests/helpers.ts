import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { openDb } from "../src/db/db.js";
import { migrate } from "../src/db/schema.js";
import type { Config } from "../src/config.js";
import type { Deps } from "../src/deps.js";

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "gitfkd-test-"));
}

/** Fresh deps: an in-memory database and a temporary data directory. */
export function testDeps(overrides: Partial<Config> = {}): Deps {
  const db = openDb(":memory:");
  migrate(db);
  const dataDir = tmpDir();
  mkdirSync(join(dataDir, "repos"));
  return { db, config: { dataDir, port: 0, baseUrl: "http://localhost:3000", allowUserInvites: false, ...overrides } };
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

export type TestCommit = {
  /** File contents to write; null deletes the file. */
  files: Record<string, string | null>;
  message: string;
  /** Branch to commit on; created from the current branch if missing. */
  branch?: string;
};

/** Builds a working repo from the commits and returns a bare clone of it. */
export function makeRepoWithCommits(dir: string, commits: TestCommit[]): string {
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  for (const c of commits) {
    if (c.branch) {
      const exists = git(work, "branch", "--list", c.branch).trim() !== "";
      git(work, "switch", "-q", ...(exists ? [c.branch] : ["-c", c.branch]));
    }
    for (const [path, content] of Object.entries(c.files)) {
      const full = join(work, path);
      if (content === null) {
        if (existsSync(full)) rmSync(full);
      } else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
    }
    git(work, "add", "-A");
    git(work, "commit", "-q", "--allow-empty", "-m", c.message);
  }
  git(work, "switch", "-q", "main");
  const bare = join(dir, "repo.git");
  git(dir, "clone", "-q", "--bare", work, bare);
  return bare;
}
