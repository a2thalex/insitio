import type { DatabaseSync } from "node:sqlite";
import { now } from "../db/db.js";
import { getUserById } from "./users.js";

type Row = Record<string, any>;

export type Notice = { id: number; title: string; url: string; reason: string; readAt: number | null; createdAt: number };

/** A targeted notice. `ignore` drops it. The actor is never notified. */
export function notify(db: DatabaseSync, userId: number, actorId: number, note: { title: string; url: string; reason: string }): void {
  if (userId === actorId) return;
  const user = getUserById(db, userId);
  if (!user || user.notify === "ignore") return;
  db.prepare("insert into notifications (user_id, title, url, reason, created_at) values (?, ?, ?, ?, ?)").run(
    userId,
    note.title.slice(0, 200),
    note.url.slice(0, 300),
    note.reason.slice(0, 40),
    now(),
  );
}

export function listNotifications(db: DatabaseSync, userId: number): Notice[] {
  return (db.prepare("select * from notifications where user_id = ? order by id desc limit 50").all(userId) as Row[]).map((row) => ({
    id: row.id,
    title: row.title,
    url: row.url,
    reason: row.reason,
    readAt: row.read_at,
    createdAt: row.created_at,
  }));
}

export function unreadCount(db: DatabaseSync, userId: number): number {
  return (db.prepare("select count(*) as n from notifications where user_id = ? and read_at is null").get(userId) as Row).n;
}

export function markNotificationsRead(db: DatabaseSync, userId: number): void {
  db.prepare("update notifications set read_at = ? where user_id = ? and read_at is null").run(now(), userId);
}
