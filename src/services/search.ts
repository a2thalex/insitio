import type { DatabaseSync } from "node:sqlite";
import type { Deps } from "../deps.js";
import { accessLevel, can } from "./permissions.js";
import { gitFor, type RepoRow } from "./repos.js";
import type { User } from "./users.js";

type Row = Record<string, any>;

export type IssueHit = { owner: string; name: string; number: number; title: string; isPull: boolean };
export type UserHit = { username: string; kind: "user" | "org" };
export type CodeHit = { owner: string; name: string; ref: string; path: string; line: number; text: string };

const SELECT = `select i.number, i.title, i.is_pull, i.repo_id, r.owner_id, r.name, r.is_private, u.username as owner
  from issues i join repos r on r.id = i.repo_id join users u on u.id = r.owner_id`;

export function searchIssues(db: DatabaseSync, q: string, viewer: User | null): IssueHit[] {
  const like = `%${q.trim().replace(/[%_\\]/g, (m) => "\\" + m)}%`;
  const rows = db.prepare(`${SELECT} where i.title like ? escape '\\' or i.body like ? escape '\\' order by i.updated_at desc limit 80`).all(like, like) as Row[];
  const hits: IssueHit[] = [];
  for (const row of rows) {
    const repo = { id: row.repo_id, ownerId: row.owner_id, isPrivate: !!row.is_private };
    if (!can(accessLevel(db, viewer, repo), "read")) continue;
    hits.push({ owner: row.owner, name: row.name, number: row.number, title: row.title, isPull: !!row.is_pull });
    if (hits.length === 30) break;
  }
  return hits;
}

export function searchUsers(db: DatabaseSync, q: string): UserHit[] {
  const like = `%${q.trim().replace(/[%_\\]/g, (m) => "\\" + m)}%`;
  return (db.prepare("select username, kind from users where username like ? escape '\\' order by username limit 30").all(like) as Row[]).map((row) => ({
    username: row.username,
    kind: row.kind === "org" ? "org" : "user",
  }));
}

/** Grep the default branch of visible repositories. Stops after a handful of repositories. */
export async function searchCode(deps: Deps, q: string, repos: RepoRow[]): Promise<CodeHit[]> {
  const hits: CodeHit[] = [];
  for (const repo of repos.slice(0, 15)) {
    const found = await gitFor(deps, repo).grep(repo.defaultBranch, q, 5);
    for (const file of found) {
      for (const line of file.lines) {
        hits.push({ owner: repo.owner, name: repo.name, ref: repo.defaultBranch, path: file.path, line: line.no, text: line.text });
        if (hits.length >= 30) return hits;
      }
    }
  }
  return hits;
}
