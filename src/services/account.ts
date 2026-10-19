import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "../auth/tokens.js";
import { randomBase32, totpMatches } from "../auth/totp.js";
import { now, tx } from "../db/db.js";
import { ForbiddenError, ValidationError } from "./errors.js";
import { getUserByName } from "./users.js";

type Row = Record<string, any>;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function logSecurity(db: DatabaseSync, userId: number, kind: string, detail = ""): void {
  db.prepare("insert into security_events (user_id, kind, detail, created_at) values (?, ?, ?, ?)").run(userId, kind, detail.slice(0, 200), now());
}

export function listSecurity(db: DatabaseSync, userId: number): { id: number; kind: string; detail: string; createdAt: number }[] {
  return (db.prepare("select * from security_events where user_id = ? order by id desc limit 50").all(userId) as Row[]).map((row) => ({
    id: row.id,
    kind: row.kind,
    detail: row.detail,
    createdAt: row.created_at,
  }));
}

export type EmailRow = { id: number; email: string; primary: boolean };

export function listEmails(db: DatabaseSync, userId: number): EmailRow[] {
  return (db.prepare("select * from emails where user_id = ? order by is_primary desc, email").all(userId) as Row[]).map((row) => ({
    id: row.id,
    email: row.email,
    primary: !!row.is_primary,
  }));
}

export function addEmail(db: DatabaseSync, userId: number, raw: string): void {
  const email = raw.trim();
  if (!EMAIL.test(email)) throw new ValidationError("Email address is invalid");
  const count = (db.prepare("select count(*) as n from emails where user_id = ?").get(userId) as Row).n;
  if (count >= 5) throw new ValidationError("An account can have at most 5 emails.");
  const taken = db.prepare("select user_id from emails where email = ? collate nocase").get(email) as Row | undefined;
  if (taken) throw new ValidationError("That email is already in use");
  const primary = count === 0 ? 1 : 0;
  db.prepare("insert into emails (user_id, email, is_primary) values (?, ?, ?)").run(userId, email, primary);
  if (primary) db.prepare("update users set email = ? where id = ?").run(email, userId);
  logSecurity(db, userId, "email_added", email);
}

export function removeEmail(db: DatabaseSync, userId: number, id: number): void {
  const row = db.prepare("select * from emails where id = ? and user_id = ?").get(id, userId) as Row | undefined;
  if (!row) return;
  if (row.is_primary) throw new ValidationError("Choose another primary email before removing this one.");
  db.prepare("delete from emails where id = ?").run(id);
  logSecurity(db, userId, "email_removed", row.email);
}

export function makePrimaryEmail(db: DatabaseSync, userId: number, id: number): void {
  const row = db.prepare("select * from emails where id = ? and user_id = ?").get(id, userId) as Row | undefined;
  if (!row) throw new ValidationError("That email is not on your account.");
  tx(db, () => {
    db.prepare("update emails set is_primary = 0 where user_id = ?").run(userId);
    db.prepare("update emails set is_primary = 1 where id = ?").run(id);
    db.prepare("update users set email = ? where id = ?").run(row.email, userId);
  });
}

export type SessionRow = { id: string; createdAt: number; userAgent: string; current: boolean };

export function listSessions(db: DatabaseSync, userId: number, currentId: string): SessionRow[] {
  const currentHash = sha256Hex(currentId);
  return (db.prepare("select id, created_at, user_agent from sessions where user_id = ? order by created_at desc").all(userId) as Row[]).map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    userAgent: row.user_agent,
    current: row.id === currentHash,
  }));
}

export function revokeSession(db: DatabaseSync, userId: number, sessionHash: string): void {
  const row = db.prepare("select id from sessions where id = ? and user_id = ?").get(sessionHash, userId) as Row | undefined;
  if (!row) return;
  db.prepare("delete from sessions where id = ? and user_id = ?").run(sessionHash, userId);
  logSecurity(db, userId, "session_revoked");
}

export function revokeOtherSessions(db: DatabaseSync, userId: number, currentId: string): void {
  db.prepare("delete from sessions where user_id = ? and id <> ?").run(userId, sha256Hex(currentId));
  logSecurity(db, userId, "session_revoked", "other sessions");
}

export function userHasTotp(db: DatabaseSync, userId: number): boolean {
  const row = db.prepare("select totp_secret from users where id = ?").get(userId) as Row | undefined;
  return !!row?.totp_secret;
}

export function totpSecret(db: DatabaseSync, userId: number): string | null {
  const row = db.prepare("select totp_secret from users where id = ?").get(userId) as Row | undefined;
  return row?.totp_secret ?? null;
}

export function beginTotp(db: DatabaseSync, userId: number, username: string): { secret: string; url: string } {
  const secret = randomBase32();
  db.prepare("update users set totp_pending = ? where id = ?").run(secret, userId);
  const url = `otpauth://totp/Insitio:${encodeURIComponent(username)}?secret=${secret}&issuer=Insitio`;
  return { secret, url };
}

export function confirmTotp(db: DatabaseSync, userId: number, code: string, at = Date.now()): string[] {
  const row = db.prepare("select totp_pending from users where id = ?").get(userId) as Row | undefined;
  if (!row?.totp_pending) throw new ValidationError("Start two-factor setup again.");
  if (!totpMatches(row.totp_pending, code, at)) throw new ValidationError("That code is not valid.");
  const codes = Array.from({ length: 8 }, () => randomBytes(5).toString("hex"));
  tx(db, () => {
    db.prepare("update users set totp_secret = totp_pending, totp_pending = null where id = ?").run(userId);
    db.prepare("delete from recovery_codes where user_id = ?").run(userId);
    const insert = db.prepare("insert into recovery_codes (user_id, code_hash) values (?, ?)");
    for (const item of codes) insert.run(userId, sha256Hex(item));
  });
  logSecurity(db, userId, "totp_enabled");
  return codes;
}

export function disableTotp(db: DatabaseSync, userId: number, code: string, at = Date.now()): void {
  const secret = totpSecret(db, userId);
  if (!secret || !acceptSecondFactor(db, userId, secret, code, at)) throw new ValidationError("That code is not valid.");
  tx(db, () => {
    db.prepare("update users set totp_secret = null, totp_pending = null where id = ?").run(userId);
    db.prepare("delete from recovery_codes where user_id = ?").run(userId);
  });
  logSecurity(db, userId, "totp_disabled");
}

/** True when `code` is a current TOTP or an unused recovery code. A recovery code is spent. */
export function acceptSecondFactor(db: DatabaseSync, userId: number, secret: string, code: string, at = Date.now()): boolean {
  if (totpMatches(secret, code, at)) return true;
  const hash = sha256Hex(code.trim().toLowerCase());
  const row = db.prepare("select 1 from recovery_codes where user_id = ? and code_hash = ?").get(userId, hash);
  if (!row) return false;
  db.prepare("delete from recovery_codes where user_id = ? and code_hash = ?").run(userId, hash);
  return true;
}

export function setAppearance(db: DatabaseSync, userId: number, theme: string, notify: string): void {
  if (theme !== "dark" && theme !== "light" && theme !== "system") throw new ValidationError("Choose dark, light, or system.");
  if (notify !== "participating" && notify !== "all" && notify !== "ignore") throw new ValidationError("Choose a notification level.");
  db.prepare("update users set theme = ?, notify = ? where id = ?").run(theme, notify, userId);
}

export function blockUser(db: DatabaseSync, userId: number, username: string): void {
  const other = getUserByName(db, username.trim());
  if (!other) throw new ValidationError(`No user named ${username.trim()}`);
  if (other.id === userId) throw new ValidationError("You can't block yourself.");
  const count = (db.prepare("select count(*) as n from blocks where user_id = ?").get(userId) as Row).n;
  if (count >= 50) throw new ValidationError("You can block at most 50 people.");
  db.prepare("insert into blocks (user_id, blocked_id, created_at) values (?, ?, ?) on conflict do nothing").run(userId, other.id, now());
  logSecurity(db, userId, "user_blocked", other.username);
}

export function unblockUser(db: DatabaseSync, userId: number, blockedId: number): void {
  db.prepare("delete from blocks where user_id = ? and blocked_id = ?").run(userId, blockedId);
}

export function listBlocks(db: DatabaseSync, userId: number): { id: number; username: string }[] {
  return (
    db.prepare("select u.id as id, u.username as username from blocks b join users u on u.id = b.blocked_id where b.user_id = ? order by u.username").all(userId) as Row[]
  ).map((row) => ({ id: row.id, username: row.username }));
}

export function assertNotBlocked(db: DatabaseSync, actorId: number, ownerId: number): void {
  const row = db.prepare("select 1 from blocks where user_id = ? and blocked_id = ?").get(ownerId, actorId);
  if (row) throw new ForbiddenError("You can't interact with this repository.");
}

export type SavedReply = { id: number; title: string; body: string };

export function listSavedReplies(db: DatabaseSync, userId: number): SavedReply[] {
  return (db.prepare("select id, title, body from saved_replies where user_id = ? order by title").all(userId) as Row[]).map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
  }));
}

export function addSavedReply(db: DatabaseSync, userId: number, title: string, body: string): void {
  const name = title.trim();
  const text = body.trim();
  if (!name) throw new ValidationError("Reply title is required.");
  if (!text) throw new ValidationError("Reply body is required.");
  const count = (db.prepare("select count(*) as n from saved_replies where user_id = ?").get(userId) as Row).n;
  if (count >= 20) throw new ValidationError("You can save at most 20 replies.");
  db.prepare("insert into saved_replies (user_id, title, body, created_at) values (?, ?, ?, ?)").run(userId, name.slice(0, 80), text.slice(0, 10_000), now());
}

export function deleteSavedReply(db: DatabaseSync, userId: number, id: number): void {
  db.prepare("delete from saved_replies where id = ? and user_id = ?").run(id, userId);
}

export function savedReplyBody(db: DatabaseSync, userId: number, id: number): string | null {
  const row = db.prepare("select body from saved_replies where id = ? and user_id = ?").get(id, userId) as Row | undefined;
  return row?.body ?? null;
}

const SSH_TYPES = new Set(["ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"]);

export function addSshKey(db: DatabaseSync, userId: number, title: string, publicKey: string): void {
  const name = title.trim();
  if (!name) throw new ValidationError("Key title is required.");
  const parts = publicKey.trim().split(/\s+/);
  if (parts.length < 2 || !SSH_TYPES.has(parts[0])) throw new ValidationError("Paste an OpenSSH public key.");
  const raw = Buffer.from(parts[1], "base64");
  if (raw.length < 8) throw new ValidationError("That public key is not valid.");
  const fingerprint = `SHA256:${createHash("sha256").update(raw).digest("base64").replace(/=+$/, "")}`;
  const count = (db.prepare("select count(*) as n from ssh_keys where user_id = ?").get(userId) as Row).n;
  if (count >= 10) throw new ValidationError("You can add at most 10 SSH keys.");
  db.prepare("insert into ssh_keys (user_id, title, public_key, fingerprint, created_at) values (?, ?, ?, ?, ?)").run(
    userId,
    name.slice(0, 80),
    parts.slice(0, 2).join(" "),
    fingerprint,
    now(),
  );
  logSecurity(db, userId, "ssh_key_added", fingerprint);
}

export function listSshKeys(db: DatabaseSync, userId: number): { id: number; title: string; fingerprint: string }[] {
  return (db.prepare("select id, title, fingerprint from ssh_keys where user_id = ? order by id").all(userId) as Row[]).map((row) => ({
    id: row.id,
    title: row.title,
    fingerprint: row.fingerprint,
  }));
}

export function deleteSshKey(db: DatabaseSync, userId: number, id: number): void {
  db.prepare("delete from ssh_keys where id = ? and user_id = ?").run(id, userId);
  logSecurity(db, userId, "ssh_key_removed");
}

export function addGpgKey(db: DatabaseSync, userId: number, armored: string): void {
  const text = armored.trim();
  if (!text.includes("-----BEGIN PGP PUBLIC KEY BLOCK-----") || !text.includes("-----END PGP PUBLIC KEY BLOCK-----")) {
    throw new ValidationError("Paste an ASCII-armored PGP public key.");
  }
  if (text.length > 20_000) throw new ValidationError("That key is too large.");
  const keyId = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const count = (db.prepare("select count(*) as n from gpg_keys where user_id = ?").get(userId) as Row).n;
  if (count >= 10) throw new ValidationError("You can add at most 10 GPG keys.");
  db.prepare("insert into gpg_keys (user_id, key_id, armored, created_at) values (?, ?, ?, ?)").run(userId, keyId, text, now());
  logSecurity(db, userId, "gpg_key_added", keyId);
}

export function listGpgKeys(db: DatabaseSync, userId: number): { id: number; keyId: string }[] {
  return (db.prepare("select id, key_id from gpg_keys where user_id = ? order by id").all(userId) as Row[]).map((row) => ({
    id: row.id,
    keyId: row.key_id,
  }));
}

export function deleteGpgKey(db: DatabaseSync, userId: number, id: number): void {
  db.prepare("delete from gpg_keys where id = ? and user_id = ?").run(id, userId);
  logSecurity(db, userId, "gpg_key_removed");
}
