import type { DatabaseSync } from "node:sqlite";
import { now } from "../db/db.js";
import { ValidationError } from "./errors.js";

type Row = Record<string, any>;

export type Environment = { id: number; name: string; url: string };
export type Deployment = { id: number; environment: string; sha: string; description: string; createdAt: number };

const ENV_NAME = /^[A-Za-z0-9._-]{1,40}$/;

export function listEnvironments(db: DatabaseSync, repoId: number): Environment[] {
  return (db.prepare("select id, name, url from environments where repo_id = ? order by name").all(repoId) as Row[]).map((row) => ({
    id: row.id,
    name: row.name,
    url: row.url,
  }));
}

export function createEnvironment(db: DatabaseSync, repoId: number, name: string, url: string): void {
  const clean = name.trim();
  if (!ENV_NAME.test(clean)) throw new ValidationError("An environment name uses letters, numbers, dots, dashes, and underscores.");
  if (url && !/^https?:\/\//.test(url)) throw new ValidationError("An environment URL must start with http:// or https://.");
  const count = (db.prepare("select count(*) as n from environments where repo_id = ?").get(repoId) as Row).n as number;
  if (count >= 20) throw new ValidationError("A repository can have at most 20 environments.");
  try {
    db.prepare("insert into environments (repo_id, name, url) values (?, ?, ?)").run(repoId, clean, url.trim().slice(0, 200));
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw new ValidationError("That environment already exists.");
    throw err;
  }
}

export function recordDeployment(db: DatabaseSync, repoId: number, environment: string, sha: string, description: string): number {
  const env = db.prepare("select id from environments where repo_id = ? and name = ?").get(repoId, environment.trim()) as Row | undefined;
  if (!env) throw new ValidationError("That environment does not exist.");
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new ValidationError("The deployment needs a commit id.");
  return Number(
    db.prepare("insert into deployments (repo_id, environment_id, sha, description, created_at) values (?, ?, ?, ?, ?)").run(
      repoId,
      env.id,
      sha.toLowerCase(),
      description.trim().slice(0, 200),
      now(),
    ).lastInsertRowid,
  );
}

export function listDeployments(db: DatabaseSync, repoId: number): Deployment[] {
  return (
    db
      .prepare(
        `select d.id, d.sha, d.description, d.created_at, e.name as environment
         from deployments d join environments e on e.id = d.environment_id
         where d.repo_id = ? order by d.id desc limit 30`,
      )
      .all(repoId) as Row[]
  ).map((row) => ({ id: row.id, environment: row.environment, sha: row.sha, description: row.description, createdAt: row.created_at }));
}

export function recordView(db: DatabaseSync, repoId: number): void {
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(
    `insert into repo_views (repo_id, day, views) values (?, ?, 1)
     on conflict (repo_id, day) do update set views = views + 1`,
  ).run(repoId, day);
}

export function recentViews(db: DatabaseSync, repoId: number): { day: string; views: number }[] {
  return (db.prepare("select day, views from repo_views where repo_id = ? order by day desc limit 14").all(repoId) as Row[]).map((row) => ({
    day: row.day,
    views: row.views,
  }));
}

export function explorePublic(db: DatabaseSync): {
  repos: { owner: string; name: string; description: string }[];
  issues: { owner: string; name: string; number: number; title: string }[];
  gists: { id: string; owner: string; description: string }[];
  discussions: { owner: string; name: string; number: number; title: string; category: string }[];
} {
  const repos = (db.prepare(
    `select u.username as owner, r.name, r.description from repos r join users u on u.id = r.owner_id
     where r.is_private = 0 order by r.id desc limit 20`,
  ).all() as Row[]).map((row) => ({ owner: row.owner, name: row.name, description: row.description }));
  const issues = (db.prepare(
    `select u.username as owner, r.name, i.number, i.title from issues i
     join repos r on r.id = i.repo_id join users u on u.id = r.owner_id
     where r.is_private = 0 and r.issues_enabled = 1 and i.is_pull = 0 order by i.id desc limit 20`,
  ).all() as Row[]).map((row) => ({ owner: row.owner, name: row.name, number: row.number, title: row.title }));
  const gists = (db.prepare(
    `select g.id, u.username as owner, g.description from gists g join users u on u.id = g.owner_id
     where g.secret = 0 order by g.updated_at desc limit 20`,
  ).all() as Row[]).map((row) => ({ id: row.id, owner: row.owner, description: row.description }));
  const discussions = (db.prepare(
    `select u.username as owner, r.name, d.number, d.title, d.category from discussions d
     join repos r on r.id = d.repo_id join users u on u.id = r.owner_id
     where r.is_private = 0 order by d.id desc limit 20`,
  ).all() as Row[]).map((row) => ({
    owner: row.owner,
    name: row.name,
    number: row.number,
    title: row.title,
    category: row.category,
  }));
  return { repos, issues, gists, discussions };
}
