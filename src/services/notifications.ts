import type { DatabaseSync } from "node:sqlite";
import { now } from "../db/db.js";
import { accessLevel, can } from "./permissions.js";
import { getUserById } from "./users.js";

type Row = Record<string, any>;

export type Notice = { id: number; title: string; url: string; reason: string; readAt: number | null; createdAt: number };

function canReadRepo(db: DatabaseSync, userId: number, repoId: number): boolean {
  const user = getUserById(db, userId);
  const repo = db.prepare("select id, owner_id, is_private from repos where id = ?").get(repoId) as Row | undefined;
  if (!user || !repo) return false;
  return can(accessLevel(db, user, { id: repo.id, ownerId: repo.owner_id, isPrivate: !!repo.is_private }), "read");
}

/** A targeted notice. `ignore` drops it, and so does a recipient who cannot read the repository. The actor is never notified. */
export function notify(
  db: DatabaseSync,
  userId: number,
  actorId: number,
  note: { title: string; url: string; reason: string; repoId: number },
): void {
  if (userId === actorId) return;
  const user = getUserById(db, userId);
  if (!user || user.notify === "ignore") return;
  if (!canReadRepo(db, userId, note.repoId)) return;
  db.prepare("insert into notifications (user_id, repo_id, title, url, reason, created_at) values (?, ?, ?, ?, ?, ?)").run(
    userId,
    note.repoId,
    note.title.slice(0, 200),
    note.url.slice(0, 300),
    note.reason.slice(0, 40),
    now(),
  );
}

export function listNotifications(db: DatabaseSync, userId: number): Notice[] {
  const rows = db.prepare("select * from notifications where user_id = ? order by id desc limit 50").all(userId) as Row[];
  return rows
    .filter((row) => canReadRepo(db, userId, row.repo_id))
    .map((row) => ({
      id: row.id,
      title: row.title,
      url: row.url,
      reason: row.reason,
      readAt: row.read_at,
      createdAt: row.created_at,
    }));
}

export function unreadCount(db: DatabaseSync, userId: number): number {
  return listNotifications(db, userId).filter((note) => note.readAt === null).length;
}

export function markNotificationsRead(db: DatabaseSync, userId: number): void {
  db.prepare("update notifications set read_at = ? where user_id = ? and read_at is null").run(now(), userId);
}
