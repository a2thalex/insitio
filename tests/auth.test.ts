import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/db.js";
import { migrate } from "../src/db/schema.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import {
  authenticate, createAccessToken, createInvite, createSession, createUser, deleteSession,
  getSession, inviteStatus, redeemInvite, userForAccessToken,
} from "../src/services/users.js";
import { ValidationError } from "../src/services/errors.js";

let db: DatabaseSync;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
});

describe("passwords", () => {
  it("round-trips and rejects wrong passwords", () => {
    const h = hashPassword("correct horse");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("correct horse", h)).toBe(true);
    expect(verifyPassword("wrong horse", h)).toBe(false);
    expect(hashPassword("correct horse")).not.toBe(h);
  });
});

describe("users", () => {
  it("validates usernames and passwords", () => {
    expect(() => createUser(db, { username: "settings", password: "longenough", email: "a@b.c" })).toThrow(ValidationError);
    expect(() => createUser(db, { username: "-bad", password: "longenough", email: "a@b.c" })).toThrow(ValidationError);
    expect(() => createUser(db, { username: "ok", password: "short", email: "a@b.c" })).toThrow(ValidationError);
    createUser(db, { username: "Ada", password: "longenough", email: "a@b.c" });
    expect(() => createUser(db, { username: "ada", password: "longenough", email: "a@b.c" })).toThrow(/taken/);
  });

  it("authenticates by username and password", () => {
    createUser(db, { username: "ada", password: "longenough", email: "a@b.c" });
    expect(authenticate(db, "ADA", "longenough")?.username).toBe("ada");
    expect(authenticate(db, "ada", "nope-nope")).toBeNull();
    expect(authenticate(db, "nobody", "longenough")).toBeNull();
  });

  it("creates, reads and deletes sessions", () => {
    const u = createUser(db, { username: "ada", password: "longenough", email: "a@b.c" });
    const s = createSession(db, u.id);
    expect(getSession(db, s.id)?.user.username).toBe("ada");
    expect(getSession(db, s.id)?.session.csrf).toBe(s.csrf);
    deleteSession(db, s.id);
    expect(getSession(db, s.id)).toBeNull();
  });
});

describe("invites", () => {
  it("can be redeemed exactly once", () => {
    const admin = createUser(db, { username: "admin", password: "longenough", email: "a@b.c", isAdmin: true });
    const token = createInvite(db, admin.id);
    expect(inviteStatus(db, token)).toBe("valid");
    const u = redeemInvite(db, token, { username: "bob", password: "longenough", email: "b@b.c" });
    expect(u.username).toBe("bob");
    expect(inviteStatus(db, token)).toBe("used");
    expect(() => redeemInvite(db, token, { username: "eve", password: "longenough", email: "e@b.c" })).toThrow(ValidationError);
    expect(inviteStatus(db, "missing-token")).toBe("missing");
  });

  it("rejects expired invites and does not consume an invite on bad input", () => {
    const admin = createUser(db, { username: "admin", password: "longenough", email: "a@b.c", isAdmin: true });
    const expired = createInvite(db, admin.id, -1);
    expect(inviteStatus(db, expired)).toBe("expired");
    const token = createInvite(db, admin.id);
    expect(() => redeemInvite(db, token, { username: "x", password: "short", email: "x@b.c" })).toThrow(ValidationError);
    expect(inviteStatus(db, token)).toBe("valid");
  });
});

describe("access tokens", () => {
  it("authenticate only their owner", () => {
    const ada = createUser(db, { username: "ada", password: "longenough", email: "a@b.c" });
    createUser(db, { username: "bob", password: "longenough", email: "b@b.c" });
    const t = createAccessToken(db, ada.id, "laptop");
    expect(t.startsWith("gfk_")).toBe(true);
    expect(userForAccessToken(db, "ada", t)?.id).toBe(ada.id);
    expect(userForAccessToken(db, "bob", t)).toBeNull();
    expect(userForAccessToken(db, "ada", "gfk_wrong")).toBeNull();
  });
});
