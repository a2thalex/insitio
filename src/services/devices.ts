import { randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { now as clock, tx } from "../db/db.js";
import { randomToken, sha256Hex } from "../auth/tokens.js";
import { ValidationError } from "./errors.js";
import { createAccessToken, getUserById } from "./users.js";

// Device authorization (the `nsit auth login` flow). The CLI asks for a device code
// and a short user code, the user enters the user code on a signed-in web page and
// approves, and the CLI collects a personal access token by polling. Both codes are
// stored hashed, and the token is minted at poll time so it is never stored at all.

export const DEVICE_EXPIRES_IN = 600;
export const DEVICE_INTERVAL = 5;

// No vowels (no accidental words) and nothing easily misread: 20 letters, 8 of them per code.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const CLIENT_NAME_MAX = 64;
// How long a finished or expired row is kept before startDevice sweeps it away.
const KEEP_SECONDS = 3600;

type Row = Record<string, any>;

export type DeviceStatus = "pending" | "approved" | "denied" | "consumed";

export type DeviceRow = {
  id: number;
  clientName: string;
  status: DeviceStatus;
  userId: number | null;
  interval: number;
  lastPollAt: number | null;
  expiresAt: number;
  createdAt: number;
};

export type DevicePoll =
  | { status: "pending" | "slow_down" | "denied" | "expired" }
  | { status: "approved"; token: string; login: string };

function toDevice(r: Row): DeviceRow {
  return {
    id: r.id,
    clientName: r.client_name,
    status: r.status,
    userId: r.user_id,
    interval: r.interval,
    lastPollAt: r.last_poll_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

/** Uppercases a typed user code and drops dashes and whitespace, so `abcd efgh` equals `ABCD-EFGH`. */
export function normalizeUserCode(code: string): string {
  return code.toUpperCase().replace(/[-\s]/g, "");
}

function newUserCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function cleanClientName(name: string): string {
  const clean = name.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, CLIENT_NAME_MAX).trim();
  if (!clean) throw new ValidationError("client_name is required");
  return clean;
}

/** Begins a sign-in. `at` is unix seconds. */
export function startDevice(
  db: DatabaseSync,
  clientName: string,
  at = clock(),
): { deviceCode: string; userCode: string; expiresIn: 600; interval: 5 } {
  const name = cleanClientName(clientName);
  db.prepare("delete from device_codes where expires_at < ?").run(at - KEEP_SECONDS);
  // A clash on either hash is astronomically unlikely, but then we simply draw new codes.
  for (let attempt = 0; attempt < 5; attempt++) {
    const deviceCode = randomToken(32);
    const userCode = newUserCode();
    const res = db
      .prepare(
        `insert into device_codes (device_code_hash, user_code_hash, client_name, interval, expires_at, created_at)
         values (?, ?, ?, ?, ?, ?) on conflict do nothing`,
      )
      .run(sha256Hex(deviceCode), sha256Hex(normalizeUserCode(userCode)), name, DEVICE_INTERVAL, at + DEVICE_EXPIRES_IN, at);
    if (Number(res.changes) > 0) return { deviceCode, userCode, expiresIn: DEVICE_EXPIRES_IN, interval: DEVICE_INTERVAL };
  }
  throw new Error("could not allocate a device code");
}

/**
 * What the CLI's poll gets. A request that is polled again inside its interval is told
 * to slow down (and that poll is not counted). Approval turns into a token here, once;
 * the row is then consumed. Unknown, consumed and expired codes all read as "expired".
 */
export function pollDevice(db: DatabaseSync, deviceCode: string, at: number): DevicePoll {
  return tx(db, () => {
    const r = db.prepare("select * from device_codes where device_code_hash = ?").get(sha256Hex(deviceCode)) as Row | undefined;
    if (!r || r.status === "consumed" || r.expires_at <= at) return { status: "expired" };
    if (r.last_poll_at !== null && at - r.last_poll_at < r.interval) return { status: "slow_down" };
    db.prepare("update device_codes set last_poll_at = ? where id = ?").run(at, r.id);

    if (r.status === "denied") return { status: "denied" };
    if (r.status === "approved") {
      const user = getUserById(db, r.user_id);
      if (!user) return { status: "expired" };
      const token = createAccessToken(db, user.id, `nsit on ${r.client_name}`);
      db.prepare("update device_codes set status = 'consumed' where id = ?").run(r.id);
      return { status: "approved", token, login: user.username };
    }
    return { status: "pending" };
  });
}

/** The still-open request a user code belongs to, if any. `at` is unix seconds. */
export function findPendingByUserCode(db: DatabaseSync, userCode: string, at = clock()): DeviceRow | null {
  const r = db
    .prepare("select * from device_codes where user_code_hash = ? and status = 'pending' and expires_at > ?")
    .get(sha256Hex(normalizeUserCode(userCode)), at) as Row | undefined;
  return r ? toDevice(r) : null;
}

/** Approves or denies an open request on behalf of `userId`. False if it was no longer open. */
export function decideDevice(db: DatabaseSync, id: number, userId: number, approve: boolean, at = clock()): boolean {
  const res = db
    .prepare("update device_codes set status = ?, user_id = ? where id = ? and status = 'pending' and expires_at > ?")
    .run(approve ? "approved" : "denied", userId, id, at);
  return Number(res.changes) > 0;
}
