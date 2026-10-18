import type { DatabaseSync } from "node:sqlite";
import { now, tx } from "../db/db.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { randomToken, sha256Hex } from "../auth/tokens.js";
import { ValidationError } from "./errors.js";

export type User = {
  id: number;
  username: string;
  displayName: string;
  email: string;
  isAdmin: boolean;
  bio: string;
  createdAt: number;
};

type Row = Record<string, any>;

const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
// Top-level URL segments a username must not shadow.
const RESERVED = new Set([
  "login", "logout", "join", "new", "settings", "site-admin", "static", "api", "explore", "search",
  "dashboard", "notifications", "about", "help", "issues", "pulls", "download",
]);
const SESSION_DAYS = 30;
const DAY = 86400;

export function toUser(r: Row): User {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    email: r.email,
    isAdmin: !!r.is_admin,
    bio: r.bio,
    createdAt: r.created_at,
  };
}

function validatePassword(password: string) {
  if (password.length < 8) throw new ValidationError("Password must be at least 8 characters");
  if (password.length > 200) throw new ValidationError("Password is too long");
}

export type NewUser = { username: string; password: string; email: string; displayName?: string; isAdmin?: boolean };

export function createUser(db: DatabaseSync, u: NewUser): User {
  const username = u.username.trim();
  if (!USERNAME_RE.test(username)) {
    throw new ValidationError("Username may only contain letters, numbers and single hyphens, and cannot start or end with a hyphen");
  }
  if (RESERVED.has(username.toLowerCase())) throw new ValidationError(`The username "${username}" is reserved`);
  validatePassword(u.password);
  const email = u.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new ValidationError("Email address is invalid");
  if (getUserByName(db, username)) throw new ValidationError(`Username "${username}" is already taken`);
  const res = db
    .prepare("insert into users (username, display_name, email, password_hash, is_admin, created_at) values (?, ?, ?, ?, ?, ?)")
    .run(username, (u.displayName ?? "").trim(), email, hashPassword(u.password), u.isAdmin ? 1 : 0, now());
  return getUserById(db, Number(res.lastInsertRowid))!;
}

export function getUserByName(db: DatabaseSync, username: string): User | null {
  const r = db.prepare("select * from users where username = ?").get(username);
  return r ? toUser(r) : null;
}

export function getUserById(db: DatabaseSync, id: number): User | null {
  const r = db.prepare("select * from users where id = ?").get(id);
  return r ? toUser(r) : null;
}

export function getUserByEmail(db: DatabaseSync, email: string): User | null {
  if (!email) return null;
  const r = db.prepare("select * from users where email = ? collate nocase order by id limit 1").get(email);
  return r ? toUser(r) : null;
}

export function listUsers(db: DatabaseSync): User[] {
  return db.prepare("select * from users order by username").all().map(toUser);
}

export function countUsers(db: DatabaseSync): number {
  return (db.prepare("select count(*) as n from users").get() as Row).n;
}

export function authenticate(db: DatabaseSync, username: string, password: string): User | null {
  const r = db.prepare("select * from users where username = ?").get(username.trim()) as Row | undefined;
  if (!r || !verifyPassword(password, r.password_hash)) return null;
  return toUser(r);
}

export function updateProfile(db: DatabaseSync, id: number, p: { displayName: string; email: string; bio: string }): void {
  const email = p.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new ValidationError("Email address is invalid");
  db.prepare("update users set display_name = ?, email = ?, bio = ? where id = ?").run(
    p.displayName.trim().slice(0, 100),
    email,
    p.bio.trim().slice(0, 500),
    id,
  );
}

export function changePassword(db: DatabaseSync, id: number, current: string, next: string): void {
  const r = db.prepare("select password_hash from users where id = ?").get(id) as Row | undefined;
  if (!r || !verifyPassword(current, r.password_hash)) throw new ValidationError("Current password is incorrect");
  validatePassword(next);
  db.prepare("update users set password_hash = ? where id = ?").run(hashPassword(next), id);
}

export function setPassword(db: DatabaseSync, id: number, next: string): void {
  validatePassword(next);
  db.prepare("update users set password_hash = ? where id = ?").run(hashPassword(next), id);
}

export function setAdmin(db: DatabaseSync, id: number, isAdmin: boolean): void {
  db.prepare("update users set is_admin = ? where id = ?").run(isAdmin ? 1 : 0, id);
}

// Sessions

export function createSession(db: DatabaseSync, userId: number): { id: string; csrf: string } {
  const id = randomToken();
  const csrf = randomToken(24);
  db.prepare("insert into sessions (id, user_id, csrf_token, expires_at) values (?, ?, ?, ?)").run(
    sha256Hex(id),
    userId,
    csrf,
    now() + SESSION_DAYS * DAY,
  );
  return { id, csrf };
}

export function getSession(db: DatabaseSync, id: string): { session: { id: string; csrf: string }; user: User } | null {
  const r = db
    .prepare("select s.csrf_token, s.expires_at, u.* from sessions s join users u on u.id = s.user_id where s.id = ?")
    .get(sha256Hex(id)) as Row | undefined;
  if (!r || r.expires_at < now()) return null;
  return { session: { id, csrf: r.csrf_token }, user: toUser(r) };
}

export function deleteSession(db: DatabaseSync, id: string): void {
  db.prepare("delete from sessions where id = ?").run(sha256Hex(id));
}

// Invites

export type Invite = { token: string; createdBy: string | null; usedBy: string | null; expiresAt: number; createdAt: number };

export function createInvite(db: DatabaseSync, createdBy: number, days = 7): string {
  const token = randomToken(18);
  db.prepare("insert into invites (token, created_by, expires_at, created_at) values (?, ?, ?, ?)").run(
    token,
    createdBy,
    now() + days * DAY,
    now(),
  );
  return token;
}

export function inviteStatus(db: DatabaseSync, token: string): "valid" | "used" | "expired" | "missing" {
  const r = db.prepare("select used_by, expires_at from invites where token = ?").get(token) as Row | undefined;
  if (!r) return "missing";
  if (r.used_by !== null) return "used";
  if (r.expires_at < now()) return "expired";
  return "valid";
}

export function redeemInvite(db: DatabaseSync, token: string, u: Omit<NewUser, "isAdmin">): User {
  return tx(db, () => {
    const status = inviteStatus(db, token);
    if (status !== "valid") throw new ValidationError(`This invite is ${status === "missing" ? "not valid" : status}`);
    const user = createUser(db, { ...u, isAdmin: false });
    db.prepare("update invites set used_by = ? where token = ?").run(user.id, token);
    return user;
  });
}

export function listInvites(db: DatabaseSync, createdBy?: number): Invite[] {
  const rows = db
    .prepare(
      `select i.*, c.username as creator, u.username as used
       from invites i left join users c on c.id = i.created_by left join users u on u.id = i.used_by
       ${createdBy !== undefined ? "where i.created_by = ?" : ""}
       order by i.created_at desc`,
    )
    .all(...(createdBy !== undefined ? [createdBy] : [])) as Row[];
  return rows.map((r) => ({
    token: r.token,
    createdBy: r.creator,
    usedBy: r.used,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  }));
}

export function revokeInvite(db: DatabaseSync, token: string, createdBy?: number): void {
  if (createdBy !== undefined) {
    db.prepare("delete from invites where token = ? and used_by is null and created_by = ?").run(token, createdBy);
  } else {
    db.prepare("delete from invites where token = ? and used_by is null").run(token);
  }
}

// Personal access tokens

export type AccessToken = { id: number; name: string; lastUsedAt: number | null; createdAt: number };

export function createAccessToken(db: DatabaseSync, userId: number, name: string): string {
  const label = name.trim();
  if (!label) throw new ValidationError("Token name is required");
  const token = `ins_${randomToken(30)}`;
  db.prepare("insert into access_tokens (user_id, name, token_hash, created_at) values (?, ?, ?, ?)").run(
    userId,
    label.slice(0, 100),
    sha256Hex(token),
    now(),
  );
  return token;
}

function findAccessToken(db: DatabaseSync, token: string): { user: User; tokenId: number } | null {
  const r = db
    .prepare("select t.id as token_id, u.* from access_tokens t join users u on u.id = t.user_id where t.token_hash = ?")
    .get(sha256Hex(token)) as Row | undefined;
  return r ? { user: toUser(r), tokenId: r.token_id } : null;
}

function touchAccessToken(db: DatabaseSync, tokenId: number): void {
  db.prepare("update access_tokens set last_used_at = ? where id = ?").run(now(), tokenId);
}

/** Git HTTP: the token must belong to the username in the Basic credentials. */
export function userForAccessToken(db: DatabaseSync, username: string, token: string): User | null {
  const found = findAccessToken(db, token);
  if (!found || found.user.username.toLowerCase() !== username.toLowerCase()) return null;
  touchAccessToken(db, found.tokenId);
  return found.user;
}

/** API: whoever owns the token. */
export function userForBearerToken(db: DatabaseSync, token: string): { user: User; tokenId: number } | null {
  const found = findAccessToken(db, token);
  if (found) touchAccessToken(db, found.tokenId);
  return found;
}

export function listAccessTokens(db: DatabaseSync, userId: number): AccessToken[] {
  return (db.prepare("select * from access_tokens where user_id = ? order by created_at desc").all(userId) as Row[]).map(
    (r) => ({ id: r.id, name: r.name, lastUsedAt: r.last_used_at, createdAt: r.created_at }),
  );
}

export function deleteAccessToken(db: DatabaseSync, userId: number, id: number): void {
  db.prepare("delete from access_tokens where id = ? and user_id = ?").run(id, userId);
}
