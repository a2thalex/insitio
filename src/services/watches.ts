import type { DatabaseSync } from "node:sqlite";
import { ValidationError } from "./errors.js";

export type WatchLevel = "participating" | "all" | "ignore";

export function getWatch(db: DatabaseSync, userId: number, repoId: number): WatchLevel {
  const row = db.prepare("select level from watches where user_id = ? and repo_id = ?").get(userId, repoId) as { level: string } | undefined;
  return row?.level === "all" || row?.level === "ignore" ? row.level : "participating";
}

export function setWatch(db: DatabaseSync, userId: number, repoId: number, level: string): void {
  if (level === "participating") {
    db.prepare("delete from watches where user_id = ? and repo_id = ?").run(userId, repoId);
    return;
  }
  if (level !== "all" && level !== "ignore") throw new ValidationError("Choose Participating, All activity, or Ignore.");
  db.prepare(
    `insert into watches (user_id, repo_id, level) values (?, ?, ?)
     on conflict (user_id, repo_id) do update set level = excluded.level`,
  ).run(userId, repoId, level);
}

/** People who asked for every event. Participating and Ignore are not counted. */
export function watcherCount(db: DatabaseSync, repoId: number): number {
  return Number((db.prepare("select count(*) as n from watches where repo_id = ? and level = 'all'").get(repoId) as { n: number }).n);
}

export function listWatchers(db: DatabaseSync, repoId: number): { username: string; displayName: string }[] {
  return db
    .prepare(
      `select u.username as username, u.display_name as displayName from watches w
       join users u on u.id = w.user_id
       where w.repo_id = ? and w.level = 'all' order by u.username collate nocase`,
    )
    .all(repoId) as { username: string; displayName: string }[];
}
