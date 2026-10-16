import { DatabaseSync } from "node:sqlite";

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("pragma foreign_keys = on");
  if (file !== ":memory:") db.exec("pragma journal_mode = wal");
  db.exec("pragma busy_timeout = 5000");
  return db;
}

const inTx = new WeakSet<DatabaseSync>();

/** Runs fn in a transaction; nested calls join the outer one. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (inTx.has(db)) return fn();
  db.exec("begin immediate");
  inTx.add(db);
  try {
    const result = fn();
    db.exec("commit");
    return result;
  } catch (err) {
    db.exec("rollback");
    throw err;
  } finally {
    inTx.delete(db);
  }
}

export const now = () => Math.floor(Date.now() / 1000);
