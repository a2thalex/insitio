import type { DatabaseSync } from "node:sqlite";
import type { Deps } from "../deps.js";
import { now, tx } from "../db/db.js";
import { Repo, type Author } from "../git/repo.js";
import { initBareRepo, removeRepoDir, repoDir } from "../git/storage.js";
import { ValidationError } from "./errors.js";
import { accessLevel, can, type Access } from "./permissions.js";
import { createDefaultLabels } from "./issues.js";
import type { User } from "./users.js";

export type RepoRow = {
  id: number;
  ownerId: number;
  owner: string;
  name: string;
  description: string;
  website: string;
  isPrivate: boolean;
  defaultBranch: string;
  archived: boolean;
  issuesEnabled: boolean;
  pullsEnabled: boolean;
  allowMerge: boolean;
  allowSquash: boolean;
  allowRebase: boolean;
  createdAt: number;
  stars: number;
  forkedFromId: number | null;
};

type Row = Record<string, any>;

const SELECT = `select r.*, u.username as owner,
  (select count(*) from stars s where s.repo_id = r.id) as star_count
  from repos r join users u on u.id = r.owner_id`;

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

function toRepo(r: Row): RepoRow {
  return {
    id: r.id,
    ownerId: r.owner_id,
    owner: r.owner,
    name: r.name,
    description: r.description,
    website: r.website ?? "",
    isPrivate: !!r.is_private,
    defaultBranch: r.default_branch,
    archived: !!r.archived,
    issuesEnabled: r.issues_enabled !== 0,
    pullsEnabled: r.pulls_enabled !== 0,
    allowMerge: r.allow_merge !== 0,
    allowSquash: r.allow_squash !== 0,
    allowRebase: r.allow_rebase !== 0,
    createdAt: r.created_at,
    stars: r.star_count,
    forkedFromId: r.forked_from_id ?? null,
  };
}

export function gitFor(deps: Deps, repo: RepoRow): Repo {
  return new Repo(repoDir(deps.config.dataDir, repo.owner, repo.name));
}

/** The git identity used for commits Insitio makes on a user's behalf. */
export function authorFor(user: User, baseUrl?: string): Author {
  let host = "insitio";
  if (baseUrl) {
    try {
      host = new URL(baseUrl).host || host;
    } catch {
      // keep the fallback host
    }
  }
  return { name: user.displayName || user.username, email: user.email || `${user.username}@users.noreply.${host}` };
}

export function validateRepoName(name: string): string {
  const n = name.trim();
  if (!NAME_RE.test(n) || n === "." || n === ".." || /\.git$/i.test(n)) {
    throw new ValidationError("Repository names may contain letters, numbers, '.', '-' and '_', and cannot end in .git");
  }
  return n;
}

export async function createRepo(
  deps: Deps,
  owner: User,
  input: { name: string; description: string; isPrivate: boolean; initReadme: boolean },
): Promise<RepoRow> {
  const { db } = deps;
  const name = validateRepoName(input.name);
  if (getRepo(db, owner.username, name)) throw new ValidationError(`Repository ${owner.username}/${name} already exists`);
  const id = tx(db, () => {
    const res = db
      .prepare("insert into repos (owner_id, name, description, is_private, default_branch, created_at) values (?, ?, ?, ?, 'main', ?)")
      .run(owner.id, name, input.description.trim().slice(0, 350), input.isPrivate ? 1 : 0, now());
    const repoId = Number(res.lastInsertRowid);
    db.prepare("insert into repo_counters (repo_id) values (?)").run(repoId);
    createDefaultLabels(db, repoId);
    return repoId;
  });
  const repo = getRepoById(db, id)!;
  const dir = repoDir(deps.config.dataDir, owner.username, name);
  try {
    await initBareRepo(dir, "main");
    if (input.initReadme) {
      const readme = `# ${name}\n${repo.description ? `\n${repo.description}\n` : ""}`;
      await new Repo(dir).commitFiles("main", { "README.md": readme }, "Initial commit", authorFor(owner));
    }
  } catch (err) {
    db.prepare("delete from repos where id = ?").run(id);
    await removeRepoDir(dir);
    throw err;
  }
  return repo;
}

export function getRepo(db: DatabaseSync, owner: string, name: string): RepoRow | null {
  const r = db.prepare(`${SELECT} where u.username = ? and r.name = ?`).get(owner, name.replace(/\.git$/i, ""));
  return r ? toRepo(r) : null;
}

export function getRepoById(db: DatabaseSync, id: number): RepoRow | null {
  const r = db.prepare(`${SELECT} where r.id = ?`).get(id);
  return r ? toRepo(r) : null;
}

function visible(db: DatabaseSync, rows: Row[], viewer: User | null, need: Access = "read"): RepoRow[] {
  return rows.map(toRepo).filter((r) => can(accessLevel(db, viewer, r), need));
}

export function listReposForOwner(db: DatabaseSync, ownerId: number, viewer: User | null): RepoRow[] {
  return visible(db, db.prepare(`${SELECT} where r.owner_id = ? order by r.name collate nocase`).all(ownerId) as Row[], viewer);
}

/** Repos the user owns or collaborates on, most recently created first. */
export function listReposForMember(db: DatabaseSync, user: User): RepoRow[] {
  const rows = db
    .prepare(
      `${SELECT} where r.owner_id = ? or r.id in (select repo_id from collaborators where user_id = ?)
       order by r.created_at desc`,
    )
    .all(user.id, user.id) as Row[];
  return rows.map(toRepo);
}

export function searchRepos(db: DatabaseSync, q: string, viewer: User | null, limit = 50): RepoRow[] {
  const topics: string[] = [];
  const rest = q
    .replace(/(?:^|\s)topic:([a-z0-9-]{1,50})(?=\s|$)/gi, (_match, name: string) => {
      topics.push(name.toLowerCase());
      return " ";
    })
    .trim();
  const where: string[] = [];
  const params: string[] = [];
  if (rest) {
    const like = `%${rest.replace(/[%_]/g, (m) => "\\" + m)}%`;
    where.push("(r.name like ? escape '\\' or r.description like ? escape '\\' or u.username like ? escape '\\')");
    params.push(like, like, like);
  }
  for (const topic of topics) {
    where.push("exists (select 1 from repo_topics rt where rt.repo_id = r.id and rt.topic = ?)");
    params.push(topic);
  }
  if (!where.length) return [];
  const rows = db
    .prepare(`${SELECT} where ${where.join(" and ")} order by star_count desc, r.name collate nocase limit 500`)
    .all(...params) as Row[];
  return visible(db, rows, viewer).slice(0, limit);
}

export function listAllVisible(db: DatabaseSync, viewer: User | null, limit = 50): RepoRow[] {
  return visible(db, db.prepare(`${SELECT} order by r.created_at desc limit 500`).all() as Row[], viewer).slice(0, limit);
}

export function updateRepo(db: DatabaseSync, id: number, p: { description: string; isPrivate: boolean }): void {
  db.prepare("update repos set description = ?, is_private = ? where id = ?").run(p.description.trim().slice(0, 350), p.isPrivate ? 1 : 0, id);
}

export function normalizeWebsite(input: string): string {
  const value = input.trim();
  if (!value) return "";
  if (value.length > 255) throw new ValidationError("Website URL is too long.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("Website must be an http or https URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ValidationError("Website must be an http or https URL.");
  return value;
}

export function updateAbout(db: DatabaseSync, id: number, p: { description: string; website: string }): void {
  db.prepare("update repos set description = ?, website = ? where id = ?").run(p.description.trim().slice(0, 350), p.website, id);
}

/** The parent repository, when the viewer is allowed to know it exists. */
export function forkParent(db: DatabaseSync, repo: RepoRow, viewer: User | null): { owner: string; name: string } | null {
  if (!repo.forkedFromId) return null;
  const parent = getRepoById(db, repo.forkedFromId);
  if (!parent || !can(accessLevel(db, viewer, parent), "read")) return null;
  return { owner: parent.owner, name: parent.name };
}

export function listForks(db: DatabaseSync, repoId: number, viewer: User | null): RepoRow[] {
  return visible(db, db.prepare(`${SELECT} where r.forked_from_id = ? order by r.created_at desc`).all(repoId) as Row[], viewer);
}

export function setDefaultBranch(db: DatabaseSync, id: number, branch: string): void {
  db.prepare("update repos set default_branch = ? where id = ?").run(branch, id);
}

export async function deleteRepo(deps: Deps, repo: RepoRow): Promise<void> {
  deps.db.prepare("delete from repos where id = ?").run(repo.id);
  await removeRepoDir(repoDir(deps.config.dataDir, repo.owner, repo.name));
}

// Collaborators

export type Collaborator = { userId: number; username: string; role: Exclude<Access, "none"> };

export function addCollaborator(db: DatabaseSync, repoId: number, userId: number, role: Collaborator["role"]): void {
  db.prepare(
    "insert into collaborators (repo_id, user_id, role) values (?, ?, ?) on conflict (repo_id, user_id) do update set role = excluded.role",
  ).run(repoId, userId, role);
}

export function removeCollaborator(db: DatabaseSync, repoId: number, userId: number): void {
  db.prepare("delete from collaborators where repo_id = ? and user_id = ?").run(repoId, userId);
}

export function listCollaborators(db: DatabaseSync, repoId: number): Collaborator[] {
  return (
    db
      .prepare("select c.user_id, c.role, u.username from collaborators c join users u on u.id = c.user_id where c.repo_id = ? order by u.username")
      .all(repoId) as Row[]
  ).map((r) => ({ userId: r.user_id, username: r.username, role: r.role }));
}

// Stars

export function star(db: DatabaseSync, userId: number, repoId: number): void {
  db.prepare("insert or ignore into stars (user_id, repo_id, created_at) values (?, ?, ?)").run(userId, repoId, now());
}

export function unstar(db: DatabaseSync, userId: number, repoId: number): void {
  db.prepare("delete from stars where user_id = ? and repo_id = ?").run(userId, repoId);
}

export function isStarred(db: DatabaseSync, userId: number, repoId: number): boolean {
  return !!db.prepare("select 1 from stars where user_id = ? and repo_id = ?").get(userId, repoId);
}

export function listStarred(db: DatabaseSync, userId: number, viewer: User | null): RepoRow[] {
  const rows = db
    .prepare(`${SELECT} join stars st on st.repo_id = r.id where st.user_id = ? order by st.created_at desc`)
    .all(userId) as Row[];
  return visible(db, rows, viewer);
}
