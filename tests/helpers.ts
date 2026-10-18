import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db/db.js";
import { migrate } from "../src/db/schema.js";
import {
  DEFAULT_GIT_DRAIN_IDLE_MS,
  DEFAULT_GIT_DRAIN_MAX_BYTES,
  DEFAULT_HEADERS_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type Config,
} from "../src/config.js";
import type { Deps } from "../src/deps.js";
import { buildApp } from "../src/app.js";
import { createInsitioServer } from "../src/server.js";
import { createSession, createUser, type User } from "../src/services/users.js";

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "insitio-test-"));
}

/** Fresh deps: an in-memory database and a temporary data directory. */
export function testDeps(overrides: Partial<Config> = {}): Deps {
  const db = openDb(":memory:");
  migrate(db);
  const dataDir = tmpDir();
  mkdirSync(join(dataDir, "repos"));
  return {
    db,
    config: {
      dataDir,
      port: 0,
      host: undefined,
      baseUrl: "http://localhost:3000",
      allowUserInvites: false,
      trustedProxies: [],
      releaseRepo: "a2thalex/insitio",
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      headersTimeoutMs: DEFAULT_HEADERS_TIMEOUT_MS,
      gitDrainMaxBytes: DEFAULT_GIT_DRAIN_MAX_BYTES,
      gitDrainIdleMs: DEFAULT_GIT_DRAIN_IDLE_MS,
      ...overrides,
    },
  };
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

export type Who = { cookie: string; csrf: string };

/** An app over fresh deps, with request helpers that carry cookies and CSRF tokens. */
export function testApp(overrides: Partial<Config> = {}) {
  const deps = testDeps(overrides);
  const app = buildApp(deps);
  const anon: Who = { cookie: "gfk_csrf=test-csrf-token", csrf: "test-csrf-token" };
  const loginAs = (user: User): Who => {
    const s = createSession(deps.db, user.id);
    return { cookie: `gfk_session=${s.id}`, csrf: s.csrf };
  };
  const user = (username: string, extra: { isAdmin?: boolean } = {}) =>
    createUser(deps.db, { username, password: "longenough", email: `${username}@example.com`, ...extra });
  const get = (path: string, who?: Who) => app.request(path, { headers: who ? { cookie: who.cookie } : {} });
  const post = (path: string, fields: Record<string, string | string[]> = {}, who: Who = anon) => {
    const body = new URLSearchParams();
    body.append("_csrf", who.csrf);
    for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    return app.request(path, {
      method: "POST",
      headers: { cookie: who.cookie, "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  };
  return { deps, app, anon, loginAs, user, get, post };
}

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

// ---- a real server and the real `nsit` binary, for the end-to-end tests ----------

export type Insitio = {
  deps: Deps;
  server: Server;
  /** `http://127.0.0.1:<port>`: what to pass to `nsit --host`. */
  base: string;
  close: () => Promise<void>;
};

/**
 * A real Insitio server on 127.0.0.1 and a free port. `config.baseUrl` is set to that
 * address once it is known, so the URLs the API hands out (`verification_uri`,
 * `clone_url`) lead back to this server instead of to the default `localhost:3000`.
 */
export async function startInsitio(overrides: Omit<Partial<Config>, "baseUrl"> = {}): Promise<Insitio> {
  const deps = testDeps(overrides);
  const server = createInsitioServer(deps);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  deps.config.baseUrl = base;
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return { deps, server, base, close };
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
let nsitBuild: Promise<string> | undefined;

/**
 * Path to the debug `nsit` binary, built with cargo on first use and then remembered, so a
 * test file builds it once. The first build compiles the vendored libgit2 and takes minutes:
 * call this from a `beforeAll` with a generous timeout. Cargo itself is a no-op when nothing
 * changed, so other test files that call it again only pay for that check.
 */
export function nsitBin(): Promise<string> {
  nsitBuild ??= buildNsit();
  return nsitBuild;
}

function buildNsit(): Promise<string> {
  return new Promise((resolve, reject) => {
    // `rustup` puts cargo in ~/.cargo/bin; a shell that was not set up for it still works.
    const env: NodeJS.ProcessEnv = { ...process.env };
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = [join(homedir(), ".cargo", "bin"), env[pathKey] ?? ""].join(delimiter);
    // In CI the build must use exactly the versions in Cargo.lock (the other cargo steps there say --locked
    // too); on a developer's machine a lock file that needs updating is just updated.
    const locked = process.env.CI ? ["--locked"] : [];
    const child = spawn(
      process.env.CARGO || "cargo",
      ["build", ...locked, "--manifest-path", join(repoRoot, "cli", "Cargo.toml"), "--message-format=json-render-diagnostics"],
      { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-8000)));
    child.on("error", (err) =>
      reject(new Error(`cannot run cargo (${err.message}): install Rust from https://rustup.rs to run the nsit end-to-end tests`)),
    );
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`cargo build of nsit failed (exit ${code}):\n${stderr}`));
      // The binary's path comes from cargo, so CARGO_TARGET_DIR and friends are honoured.
      for (const line of stdout.split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          const message = JSON.parse(line);
          if (message.reason === "compiler-artifact" && message.target?.name === "nsit" && message.target.kind?.includes("bin") && message.executable) {
            return resolve(message.executable);
          }
        } catch {
          // not one of cargo's JSON lines
        }
      }
      resolve(join(repoRoot, "cli", "target", "debug", process.platform === "win32" ? "nsit.exe" : "nsit"));
    });
  });
}

export type NsitOptions = {
  /** Where nsit runs. Default: a fresh empty temporary directory, never the directory of the test run. */
  cwd?: string;
  /** Extra environment variables; `undefined` removes one. Applied after the isolation below. */
  env?: Record<string, string | undefined>;
  /** Becomes NSIT_CONFIG_DIR. Default: a fresh temporary directory per run. */
  configDir?: string;
  /** Text written to stdin, followed by end-of-file. */
  input?: string;
  /** "open": stdin is a pipe nobody writes to or closes, so a read blocks. Default: no input at all. */
  stdin?: "ignore" | "open";
  /**
   * The process is killed, and the call rejects, after this long. Default 20 s: below vitest's
   * `testTimeout` (30 s in vitest.config.ts), so a hung `nsit` fails with its own output and is
   * never left running behind a test that already timed out. A test that needs longer (the
   * device flow waits a poll interval) passes a larger value here and a larger per-test timeout.
   */
  timeoutMs?: number;
};

/** The default for `NsitOptions.timeoutMs`; keep it below `testTimeout` in vitest.config.ts. */
export const NSIT_TIMEOUT_MS = 20_000;

export type NsitResult = { code: number | null; stdout: string; stderr: string };

export type NsitProcess = {
  /** Everything written to stderr so far. */
  stderr: () => string;
  /** Resolves with the match once stderr matches; rejects if nsit exits first or `ms` pass. */
  waitForStderr: (pattern: RegExp, ms?: number) => Promise<RegExpMatchArray>;
  done: Promise<NsitResult>;
  kill: () => void;
};

/**
 * The environment `nsit` runs in under test: nothing from the developer's own setup (any
 * NSIT_* variable, so a real NSIT_TOKEN or NSIT_HOST) gets in, the OS credential store is
 * switched off, and the config lives in `configDir`.
 */
function nsitEnv(configDir: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^nsit_/i.test(key)) delete env[key];
  env.NSIT_NO_KEYCHAIN = "1";
  env.NO_COLOR = "1";
  env.NSIT_CONFIG_DIR = configDir;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Starts `nsit` and returns at once, for tests that must act while it runs (approving a
 * device-code login). It is spawned asynchronously on purpose: the server under test lives
 * in this process, so nothing here may block the event loop.
 */
export async function startNsit(args: string[], opts: NsitOptions = {}): Promise<NsitProcess> {
  const bin = await nsitBin();
  const stdin = opts.input !== undefined || opts.stdin === "open" ? "pipe" : "ignore";
  const child = spawn(bin, args, {
    // Never this project's own repository (the working directory of the test run): a command that
    // acts on "the repository here" (pull, push, commit) must not be able to reach it by a test that
    // forgot to name a directory. `-C <dir>` and `cwd` are how a test says where nsit runs.
    cwd: opts.cwd ?? tmpDir(),
    env: nsitEnv(opts.configDir ?? tmpDir(), opts.env),
    stdio: [stdin, "pipe", "pipe"],
    windowsHide: true,
  });
  if (opts.input !== undefined) child.stdin!.end(opts.input);
  // A closed stdin pipe (nsit exited without reading it) must not crash the test process.
  child.stdin?.on("error", () => {});

  let stdout = "";
  let stderr = "";
  const listeners = new Set<() => void>();
  child.stdout!.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr!.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
    for (const listener of [...listeners]) listener();
  });

  let exited = false;
  const timeoutMs = opts.timeoutMs ?? NSIT_TIMEOUT_MS;
  const label = `nsit ${args.join(" ")}`;
  let timedOut = false;
  let rejectDone: (reason: Error) => void = () => {};
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
    // If it does not die at once, kill it for good and fail now rather than wait for a 'close' that may never come.
    const force = setTimeout(() => {
      child.kill("SIGKILL");
      rejectDone(new Error(`${label} did not finish in ${timeoutMs} ms and had to be force-killed\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 2_000);
    child.once("close", () => clearTimeout(force));
  }, timeoutMs);

  const done = new Promise<NsitResult>((resolve, reject) => {
    rejectDone = reject;
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      exited = true;
      clearTimeout(timer);
      for (const listener of [...listeners]) listener();
      if (timedOut) reject(new Error(`${label} did not finish in ${timeoutMs} ms\nstdout: ${stdout}\nstderr: ${stderr}`));
      else resolve({ code, stdout, stderr });
    });
  });
  done.catch(() => {}); // the caller may never await it when an earlier assertion fails

  const waitForStderr = (pattern: RegExp, ms = 30_000) =>
    new Promise<RegExpMatchArray>((resolve, reject) => {
      const check = () => {
        const match = pattern.exec(stderr);
        if (match) return finish(() => resolve(match));
        if (exited) finish(() => reject(new Error(`${label} exited before printing ${pattern}\nstdout: ${stdout}\nstderr: ${stderr}`)));
      };
      const wait = setTimeout(
        () => finish(() => reject(new Error(`${label} did not print ${pattern} within ${ms} ms\nstderr: ${stderr}`))),
        ms,
      );
      const finish = (settle: () => void) => {
        clearTimeout(wait);
        listeners.delete(check);
        settle();
      };
      listeners.add(check);
      check();
    });

  return { stderr: () => stderr, waitForStderr, done, kill: () => child.kill() };
}

/** Runs `nsit` to completion. The server under test can answer meanwhile: nothing here blocks the event loop. */
export async function runNsit(args: string[], opts: NsitOptions = {}): Promise<NsitResult> {
  return (await startNsit(args, opts)).done;
}
