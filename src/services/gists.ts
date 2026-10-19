import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { now, tx } from "../db/db.js";
import { ValidationError } from "./errors.js";

type Row = Record<string, any>;

export type GistFile = { name: string; body: string };
export type Gist = { id: string; ownerId: number; owner: string; description: string; secret: boolean; createdAt: number; files: GistFile[] };

export function gistFileName(raw: string): string {
  const name = raw.trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === "." || name === ".." || name.includes("..")) {
    throw new ValidationError("File names use letters, numbers, dots, dashes, and underscores.");
  }
  return name;
}

export function createGist(
  db: DatabaseSync,
  ownerId: number,
  input: { description: string; secret: boolean; files: { name: string; body: string }[] },
): string {
  const files = cleanFiles(input.files);
  const id = randomBytes(12).toString("hex");
  const stamp = now();
  tx(db, () => {
    db.prepare("insert into gists (id, owner_id, description, secret, created_at, updated_at) values (?, ?, ?, ?, ?, ?)").run(
      id,
      ownerId,
      input.description.trim().slice(0, 200),
      input.secret ? 1 : 0,
      stamp,
      stamp,
    );
    const insert = db.prepare("insert into gist_files (gist_id, name, body) values (?, ?, ?)");
    for (const file of files) insert.run(id, file.name, file.body);
  });
  return id;
}

export function addGistFile(db: DatabaseSync, gistId: string, ownerId: number, name: string, body: string): void {
  const gist = db.prepare("select owner_id from gists where id = ?").get(gistId) as Row | undefined;
  if (!gist || gist.owner_id !== ownerId) throw new ValidationError("That gist does not exist.");
  const fileName = gistFileName(name);
  if (body.length > 100_000) throw new ValidationError("A gist file can be at most 100,000 characters.");
  const existing = db.prepare("select 1 as n from gist_files where gist_id = ? and name = ?").get(gistId, fileName) as Row | undefined;
  const count = (db.prepare("select count(*) as n from gist_files where gist_id = ?").get(gistId) as Row).n as number;
  if (!existing && count >= 10) throw new ValidationError("A gist can have at most 10 files.");
  db.prepare(
    "insert into gist_files (gist_id, name, body) values (?, ?, ?) on conflict (gist_id, name) do update set body = excluded.body",
  ).run(gistId, fileName, body);
  db.prepare("update gists set updated_at = ? where id = ?").run(now(), gistId);
}

export function getGist(db: DatabaseSync, id: string, viewerId: number | null): Gist | null {
  const row = db
    .prepare(
      `select g.*, u.username as owner from gists g join users u on u.id = g.owner_id where g.id = ?`,
    )
    .get(id) as Row | undefined;
  if (!row) return null;
  if (row.secret && row.owner_id !== viewerId) return null;
  const files = (db.prepare("select name, body from gist_files where gist_id = ? order by name").all(id) as Row[]).map((file) => ({
    name: file.name,
    body: file.body,
  }));
  return {
    id: row.id,
    ownerId: row.owner_id,
    owner: row.owner,
    description: row.description,
    secret: !!row.secret,
    createdAt: row.created_at,
    files,
  };
}

export function listVisibleGists(db: DatabaseSync, viewerId: number | null): Gist[] {
  const rows = viewerId
    ? (db.prepare("select id from gists where owner_id = ? or secret = 0 order by updated_at desc limit 30").all(viewerId) as Row[])
    : (db.prepare("select id from gists where secret = 0 order by updated_at desc limit 30").all() as Row[]);
  return rows.map((row) => getGist(db, row.id, viewerId)).filter((gist): gist is Gist => !!gist);
}

export function deleteGist(db: DatabaseSync, id: string, ownerId: number): void {
  db.prepare("delete from gists where id = ? and owner_id = ?").run(id, ownerId);
}

function cleanFiles(files: { name: string; body: string }[]): { name: string; body: string }[] {
  const cleaned = files
    .map((file) => ({ name: file.name.trim(), body: file.body }))
    .filter((file) => file.name || file.body);
  if (cleaned.length === 0) throw new ValidationError("A gist needs a file.");
  if (cleaned.length > 10) throw new ValidationError("A gist can have at most 10 files.");
  const names = new Set<string>();
  return cleaned.map((file) => {
    const name = gistFileName(file.name);
    if (names.has(name)) throw new ValidationError(`File ${name} is listed twice.`);
    names.add(name);
    if (file.body.length > 100_000) throw new ValidationError("A gist file can be at most 100,000 characters.");
    return { name, body: file.body };
  });
}
