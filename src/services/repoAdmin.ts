import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createHmac, randomBytes } from "node:crypto";
import { sha256Hex } from "../auth/tokens.js";
import { now } from "../db/db.js";
import type { Deps } from "../deps.js";
import { repoDir } from "../git/storage.js";
import { ValidationError } from "./errors.js";
import { getRepo, getRepoById, validateRepoName, type RepoRow } from "./repos.js";
import { getUserByName } from "./users.js";

type Row = Record<string, any>;

export async function renameRepo(deps: Deps, repo: RepoRow, name: string): Promise<RepoRow> {
  const next = validateRepoName(name);
  if (next.toLowerCase() === repo.name.toLowerCase()) return getRepoById(deps.db, repo.id)!;
  if (getRepo(deps.db, repo.owner, next)) throw new ValidationError(`Repository ${repo.owner}/${next} already exists`);
  await moveRepoDir(deps, repo.owner, repo.name, repo.owner, next);
  try {
    deps.db.prepare("update repos set name = ? where id = ?").run(next, repo.id);
  } catch (err) {
    await moveRepoDir(deps, repo.owner, next, repo.owner, repo.name);
    throw err;
  }
  return getRepoById(deps.db, repo.id)!;
}

export async function transferRepo(deps: Deps, repo: RepoRow, ownerName: string, name: string): Promise<RepoRow> {
  const owner = getUserByName(deps.db, ownerName.trim());
  if (!owner) throw new ValidationError(`No user named ${ownerName.trim()}`);
  const next = validateRepoName(name);
  if (owner.id === repo.ownerId && next.toLowerCase() === repo.name.toLowerCase()) return getRepoById(deps.db, repo.id)!;
  if (getRepo(deps.db, owner.username, next)) throw new ValidationError(`Repository ${owner.username}/${next} already exists`);
  await moveRepoDir(deps, repo.owner, repo.name, owner.username, next);
  try {
    deps.db.prepare("update repos set owner_id = ?, name = ? where id = ?").run(owner.id, next, repo.id);
  } catch (err) {
    await moveRepoDir(deps, owner.username, next, repo.owner, repo.name);
    throw err;
  }
  return getRepoById(deps.db, repo.id)!;
}

async function moveRepoDir(deps: Deps, fromOwner: string, fromName: string, owner: string, name: string): Promise<void> {
  const from = repoDir(deps.config.dataDir, fromOwner, fromName);
  const to = repoDir(deps.config.dataDir, owner, name);
  if (from === to) return;
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch {
    throw new ValidationError("Could not move the repository on disk.");
  }
}

export function setArchived(db: DatabaseSync, id: number, archived: boolean): void {
  db.prepare("update repos set archived = ? where id = ?").run(archived ? 1 : 0, id);
}

export function setFeatures(db: DatabaseSync, id: number, features: { issues: boolean; pulls: boolean }): void {
  db.prepare("update repos set issues_enabled = ?, pulls_enabled = ? where id = ?").run(features.issues ? 1 : 0, features.pulls ? 1 : 0, id);
}

export function setMergeMethods(db: DatabaseSync, id: number, methods: { merge: boolean; squash: boolean; rebase: boolean }): void {
  if (!methods.merge && !methods.squash && !methods.rebase) throw new ValidationError("Leave at least one merge method on.");
  db.prepare("update repos set allow_merge = ?, allow_squash = ?, allow_rebase = ? where id = ?").run(
    methods.merge ? 1 : 0,
    methods.squash ? 1 : 0,
    methods.rebase ? 1 : 0,
    id,
  );
}

const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;

export type BranchRule = { branch: string; requirePr: boolean; approvals: number };

export function listBranchRules(db: DatabaseSync, repoId: number): BranchRule[] {
  return (db.prepare("select branch, require_pr, approvals from branch_rules where repo_id = ? order by branch").all(repoId) as Row[]).map((row) => ({
    branch: row.branch,
    requirePr: !!row.require_pr,
    approvals: row.approvals,
  }));
}

export function saveBranchRule(db: DatabaseSync, repoId: number, input: { branch: string; requirePr: boolean; approvals: number }): void {
  const branch = input.branch.trim();
  if (!BRANCH.test(branch) || branch.includes("..") || branch.startsWith("/") || branch.endsWith("/")) {
    throw new ValidationError("That branch name can't be protected.");
  }
  const approvals = input.approvals;
  if (!Number.isInteger(approvals) || approvals < 0 || approvals > 6) throw new ValidationError("Approvals must be from 0 to 6.");
  const count = (db.prepare("select count(*) as n from branch_rules where repo_id = ? and branch <> ?").get(repoId, branch) as Row).n;
  if (count >= 10) throw new ValidationError("A repository can protect at most 10 branches.");
  db.prepare(
    `insert into branch_rules (repo_id, branch, require_pr, approvals) values (?, ?, ?, ?)
     on conflict (repo_id, branch) do update set require_pr = excluded.require_pr, approvals = excluded.approvals`,
  ).run(repoId, branch, input.requirePr ? 1 : 0, approvals);
}

export function deleteBranchRule(db: DatabaseSync, repoId: number, branch: string): void {
  db.prepare("delete from branch_rules where repo_id = ? and branch = ?").run(repoId, branch);
}

export function protectedRefList(db: DatabaseSync, repoId: number): string {
  return listBranchRules(db, repoId)
    .filter((rule) => rule.requirePr)
    .map((rule) => `refs/heads/${rule.branch}`)
    .join(",");
}

export type Webhook = { id: number; url: string; events: string[]; active: boolean; hasSecret: boolean };

const EVENTS = new Set(["push", "issues", "pull_request"]);

export function assertWebhookUrl(raw: string, allowLoopback = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError("Webhook URL must be http or https.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ValidationError("Webhook URL must be http or https.");
  if (url.username || url.password) throw new ValidationError("Webhook URL must not include a username or password.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new ValidationError("Webhook URL must include a host.");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal") {
    if (!(allowLoopback && host === "localhost")) throw new ValidationError("That webhook address is not allowed.");
  }
  if (isPrivateAddress(host) && !(allowLoopback && isLoopback(host))) throw new ValidationError("That webhook address is not allowed.");
  return url;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isPrivateAddress(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const n = v4.slice(1).map(Number);
    if (n.some((part) => part > 255)) return true;
    const [a, b] = n;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  const v6 = host.toLowerCase();
  return v6 === "::1" || v6 === "0:0:0:0:0:0:0:1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

export function listWebhooks(db: DatabaseSync, repoId: number): Webhook[] {
  return (db.prepare("select * from webhooks where repo_id = ? order by id").all(repoId) as Row[]).map((row) => ({
    id: row.id,
    url: row.url,
    events: String(row.events).split(",").filter(Boolean),
    active: !!row.active,
    hasSecret: !!row.secret,
  }));
}

export function addWebhook(db: DatabaseSync, repoId: number, input: { url: string; secret: string; events: string[] }, allowLoopback = false): void {
  assertWebhookUrl(input.url, allowLoopback);
  const events = [...new Set(input.events.filter((event) => EVENTS.has(event)))];
  if (!events.length) throw new ValidationError("Choose at least one event.");
  const count = (db.prepare("select count(*) as n from webhooks where repo_id = ?").get(repoId) as Row).n;
  if (count >= 10) throw new ValidationError("A repository can have at most 10 webhooks.");
  db.prepare("insert into webhooks (repo_id, url, secret, events, created_at) values (?, ?, ?, ?, ?)").run(
    repoId,
    input.url,
    input.secret.slice(0, 200),
    events.join(","),
    now(),
  );
}

export function deleteWebhook(db: DatabaseSync, repoId: number, id: number): void {
  db.prepare("delete from webhooks where id = ? and repo_id = ?").run(id, repoId);
}

export type Delivery = { id: number; event: string; responseStatus: number | null; createdAt: number };

export function listDeliveries(db: DatabaseSync, webhookId: number): Delivery[] {
  return (db.prepare("select * from webhook_deliveries where webhook_id = ? order by id desc limit 20").all(webhookId) as Row[]).map((row) => ({
    id: row.id,
    event: row.event,
    responseStatus: row.response_status,
    createdAt: row.created_at,
  }));
}

/** Posts matching hooks. Waits at most 2 seconds. Failures are recorded and do not throw. */
export async function deliverWebhooks(deps: Deps, repo: RepoRow, event: string, payload: Record<string, unknown>): Promise<void> {
  const hooks = dbHooks(deps.db, repo.id, event);
  if (!hooks.length) return;
  const body = JSON.stringify({ event, repository: `${repo.owner}/${repo.name}`, ...payload });
  await Promise.race([
    Promise.all(hooks.map((hook) => postHook(deps, hook, event, body))),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
}

function dbHooks(db: DatabaseSync, repoId: number, event: string): { id: number; url: string; secret: string }[] {
  return (db.prepare("select id, url, secret, events from webhooks where repo_id = ? and active = 1").all(repoId) as Row[])
    .filter((row) => String(row.events).split(",").includes(event))
    .map((row) => ({ id: row.id, url: row.url, secret: row.secret }));
}

async function postHook(deps: Deps, hook: { id: number; url: string; secret: string }, event: string, body: string): Promise<void> {
  let status: number | null = null;
  try {
    assertWebhookUrl(hook.url, deps.config.webhookAllowLoopback);
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "Insitio-Hook" };
    if (hook.secret) headers["x-insitio-signature"] = `sha256=${createHmac("sha256", hook.secret).update(body).digest("hex")}`;
    const response = await fetch(hook.url, { method: "POST", headers, body, signal: AbortSignal.timeout(1500) });
    status = response.status;
  } catch {
    status = null;
  }
  deps.db.prepare("insert into webhook_deliveries (webhook_id, event, response_status, created_at) values (?, ?, ?, ?)").run(hook.id, event, status, now());
  deps.db.prepare(
    `delete from webhook_deliveries where webhook_id = ? and id not in
     (select id from webhook_deliveries where webhook_id = ? order by id desc limit 20)`,
  ).run(hook.id, hook.id);
}

export type DeployKey = { id: number; title: string; canWrite: boolean; createdAt: number };

export function listDeployKeys(db: DatabaseSync, repoId: number): DeployKey[] {
  return (db.prepare("select id, title, can_write, created_at from deploy_keys where repo_id = ? order by id").all(repoId) as Row[]).map((row) => ({
    id: row.id,
    title: row.title,
    canWrite: !!row.can_write,
    createdAt: row.created_at,
  }));
}

export function createDeployKey(db: DatabaseSync, repoId: number, title: string, canWrite: boolean): string {
  const name = title.trim();
  if (!name) throw new ValidationError("Deploy key title is required.");
  const count = (db.prepare("select count(*) as n from deploy_keys where repo_id = ?").get(repoId) as Row).n;
  if (count >= 10) throw new ValidationError("A repository can have at most 10 deploy keys.");
  const token = `idk_${randomBytes(24).toString("base64url")}`;
  db.prepare("insert into deploy_keys (repo_id, title, token_hash, can_write, created_at) values (?, ?, ?, ?, ?)").run(
    repoId,
    name.slice(0, 100),
    sha256Hex(token),
    canWrite ? 1 : 0,
    now(),
  );
  return token;
}

export function deleteDeployKey(db: DatabaseSync, repoId: number, id: number): void {
  db.prepare("delete from deploy_keys where id = ? and repo_id = ?").run(id, repoId);
}

/** Git HTTP only. The token grants read or write on its own repository and nowhere else. */
export function deployKeyAccess(db: DatabaseSync, token: string, repoId: number): "read" | "write" | null {
  if (!token.startsWith("idk_")) return null;
  const row = db.prepare("select repo_id, can_write from deploy_keys where token_hash = ?").get(sha256Hex(token)) as Row | undefined;
  if (!row || row.repo_id !== repoId) return null;
  return row.can_write ? "write" : "read";
}
