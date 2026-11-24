import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { now } from "../db/db.js";
import type { Deps } from "../deps.js";
import { GitError, runGit } from "../git/run.js";
import { repoDir } from "../git/storage.js";
import { ValidationError } from "./errors.js";
import { assertOutboundUrl, isLoopback } from "./repoAdmin.js";
import { getRepoById } from "./repos.js";

type Row = Record<string, any>;

export type PushMirror = {
  id: number;
  url: string;
  username: string;
  lastAttemptAt: number | null;
  lastSyncedAt: number | null;
  lastError: string;
};

const MAX_MIRRORS = 10;
/** A push that has not finished in 10 minutes is killed and recorded as failed. */
const PUSH_TIMEOUT_MS = 10 * 60 * 1000;
/** After a failure the sweep waits this long before trying again, so a revoked token is not retried every minute. */
const RETRY_AFTER_S = 10 * 60;
const SWEEP_EVERY_MS = 60 * 1000;

/** https only; plain http just to loopback, and only when the config allows it (tests). */
export function assertMirrorUrl(raw: string, allowLoopback = false): URL {
  const url = assertOutboundUrl(raw, "mirror", allowLoopback);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "https:" && !(allowLoopback && isLoopback(host))) throw new ValidationError("Mirror URL must be https.");
  if (url.search || url.hash) throw new ValidationError("Mirror URL must not have a query or fragment.");
  return url;
}

export function listPushMirrors(db: DatabaseSync, repoId: number): PushMirror[] {
  return (db.prepare("select * from push_mirrors where repo_id = ? order by id").all(repoId) as Row[]).map((row) => ({
    id: row.id,
    url: row.url,
    username: row.username,
    lastAttemptAt: row.last_attempt_at ?? null,
    lastSyncedAt: row.last_synced_at ?? null,
    lastError: row.last_error,
  }));
}

export function addPushMirror(
  db: DatabaseSync,
  repoId: number,
  input: { url: string; username: string; token: string },
  allowLoopback = false,
): number {
  const url = assertMirrorUrl(input.url.trim(), allowLoopback).toString();
  const username = input.username.trim();
  const token = input.token.trim();
  if (!username || username.length > 100 || /[:\s]/.test(username)) throw new ValidationError("Enter the username for the mirror.");
  if (!token || token.length > 500 || /\s/.test(token)) throw new ValidationError("Enter an access token for the mirror.");
  const count = (db.prepare("select count(*) as n from push_mirrors where repo_id = ?").get(repoId) as Row).n;
  if (count >= MAX_MIRRORS) throw new ValidationError(`A repository can have at most ${MAX_MIRRORS} push mirrors.`);
  const result = db.prepare("insert into push_mirrors (repo_id, url, username, token, created_at) values (?, ?, ?, ?, ?)").run(repoId, url, username, token, now());
  return Number(result.lastInsertRowid);
}

export function deletePushMirror(db: DatabaseSync, repoId: number, id: number): void {
  db.prepare("delete from push_mirrors where id = ? and repo_id = ?").run(id, repoId);
}

/** One running push per mirror. A change that lands while it runs makes it run once more afterwards. */
const running = new WeakMap<Deps, Map<number, Promise<void>>>();
const again = new WeakMap<Deps, Set<number>>();

function enqueue(deps: Deps, id: number): Promise<void> {
  const runs = running.get(deps) ?? new Map<number, Promise<void>>();
  const pending = again.get(deps) ?? new Set<number>();
  running.set(deps, runs);
  again.set(deps, pending);
  const current = runs.get(id);
  if (current) {
    pending.add(id);
    return current;
  }
  const run = (async () => {
    try {
      do {
        pending.delete(id);
        await pushMirror(deps, id);
      } while (pending.has(id));
    } finally {
      runs.delete(id);
    }
  })();
  runs.set(id, run);
  return run;
}

/** Pushes every mirror of the repository. Never throws; each result is recorded on its mirror. */
export function syncPushMirrors(deps: Deps, repoId: number): Promise<void> {
  const ids = (deps.db.prepare("select id from push_mirrors where repo_id = ?").all(repoId) as Row[]).map((row) => row.id as number);
  return Promise.all(ids.map((id) => enqueue(deps, id))).then(() => undefined);
}

export function syncPushMirror(deps: Deps, repoId: number, id: number): Promise<void> {
  const row = deps.db.prepare("select id from push_mirrors where id = ? and repo_id = ?").get(id, repoId) as Row | undefined;
  return row ? enqueue(deps, row.id) : Promise.resolve();
}

/** A digest of every branch and tag, so the sweep can tell whether anything changed since the last good push. */
async function refsDigest(dir: string): Promise<string> {
  const { stdout } = await runGit(dir, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"]);
  const text = stdout.toString();
  return text.trim() ? createHash("sha256").update(text).digest("hex") : "";
}

async function pushMirror(deps: Deps, id: number): Promise<void> {
  const row = deps.db.prepare("select * from push_mirrors where id = ?").get(id) as Row | undefined;
  if (!row) return;
  const repo = getRepoById(deps.db, row.repo_id);
  if (!repo) return;
  const dir = repoDir(deps.config.dataDir, repo.owner, repo.name);
  const started = now();
  try {
    const url = assertMirrorUrl(row.url, deps.config.mirrorAllowLoopback);
    const digest = await refsDigest(dir);
    // An empty repository would prune every branch on the other side.
    if (!digest) throw new ValidationError("Nothing to push yet: the repository has no branches.");
    const basic = Buffer.from(`${row.username}:${row.token}`).toString("base64");
    const allowHttp = url.protocol === "http:" ? ["-c", "protocol.http.allow=always"] : [];
    await runGit(
      dir,
      [
        "-c", "credential.helper=",
        "-c", "http.followRedirects=false",
        "-c", "protocol.allow=never",
        "-c", "protocol.https.allow=always",
        ...allowHttp,
        "push", "--porcelain", "--prune", url.toString(),
        "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*",
      ],
      {
        // The token goes in a header through the environment, never in the URL or the argument list.
        env: { GIT_ASKPASS: "", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` },
        timeoutMs: PUSH_TIMEOUT_MS,
      },
    );
    deps.db.prepare("update push_mirrors set last_attempt_at = ?, last_synced_at = ?, last_error = '', last_refs = ? where id = ?").run(started, now(), digest, id);
  } catch (err) {
    const message = describeFailure(err, [row.token, Buffer.from(`${row.username}:${row.token}`).toString("base64")]);
    deps.db.prepare("update push_mirrors set last_attempt_at = ?, last_error = ? where id = ?").run(started, message, id);
    console.error(`[mirror] ${repo.owner}/${repo.name} #${id}: ${message}`);
  }
}

function describeFailure(err: unknown, secrets: string[]): string {
  let text: string;
  if (err instanceof GitError) {
    const lines = err.stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    text = err.code === null ? "The push timed out." : lines.slice(-3).join(" · ") || err.message;
  } else if (err instanceof ValidationError) {
    text = err.message;
  } else {
    text = "The push could not start.";
  }
  for (const secret of secrets) if (secret) text = text.split(secret).join("***");
  return text.slice(0, 300);
}

/** Pushes mirrors whose branches or tags changed since their last good push, including changes made in the web UI. */
export async function sweepPushMirrors(deps: Deps): Promise<void> {
  const rows = deps.db.prepare("select id, repo_id, last_refs, last_error, last_attempt_at from push_mirrors").all() as Row[];
  const due: Promise<void>[] = [];
  for (const row of rows) {
    if (row.last_error && row.last_attempt_at && now() - row.last_attempt_at < RETRY_AFTER_S) continue;
    const repo = getRepoById(deps.db, row.repo_id);
    if (!repo) continue;
    const digest = await refsDigest(repoDir(deps.config.dataDir, repo.owner, repo.name)).catch(() => "");
    if (digest && digest !== row.last_refs) due.push(enqueue(deps, row.id));
  }
  await Promise.all(due);
}

/** Starts the once-a-minute sweep. Returns a function that stops it. */
export function startPushMirrorSweep(deps: Deps, everyMs = SWEEP_EVERY_MS): () => void {
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    sweepPushMirrors(deps)
      .catch((err) => console.error("[mirror] sweep failed", err))
      .finally(() => {
        sweeping = false;
      });
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
