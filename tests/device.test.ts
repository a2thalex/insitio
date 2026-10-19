import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { createRateLimiter } from "../src/rateLimit.js";
import { migrate } from "../src/db/schema.js";
import {
  DeviceCapacityError,
  MAX_PENDING_DEVICE_CODES,
  MAX_PENDING_PER_BUCKET,
  decideDevice,
  findPendingByUserCode,
  normalizeUserCode,
  pollDevice,
  startDevice,
} from "../src/services/devices.js";
import { ValidationError } from "../src/services/errors.js";
import { createAccessToken, listAccessTokens, userForBearerToken } from "../src/services/users.js";
import { testApp } from "./helpers.js";

const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
const T0_MS = Date.parse("2026-10-18T12:00:00Z");
const T0 = T0_MS / 1000;

// Route tests move the clock with fake timers; only Date is faked so async work still runs.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0_MS);
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000);

function jsonPost(app: Hono<any>, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function setup() {
  const t = testApp();
  const ada = t.user("ada");
  const adaWho = t.loginAs(ada);
  const start = async (clientName = "test-pc") => {
    const res = await jsonPost(t.app, "/api/v1/device/code", { client_name: clientName });
    return { res, body: await res.json() };
  };
  const poll = (deviceCode: string) => jsonPost(t.app, "/api/v1/device/token", { device_code: deviceCode });
  return { ...t, ada, adaWho, start, poll };
}

describe("startDevice", () => {
  it("returns a formatted user code, 600 seconds of life and a 5 second interval", () => {
    const { deps } = setup();
    const d = startDevice(deps.db, "test-pc");
    expect(d.userCode).toMatch(USER_CODE);
    expect(d.expiresIn).toBe(600);
    expect(d.interval).toBe(5);
    expect(d.deviceCode.length).toBeGreaterThanOrEqual(32);
    expect(startDevice(deps.db, "test-pc").deviceCode).not.toBe(d.deviceCode);
  });

  it("stores only hashes of the codes, never a token", () => {
    const { deps } = setup();
    const d = startDevice(deps.db, "test-pc");
    const stored = JSON.stringify(deps.db.prepare("select * from device_codes").all());
    expect(stored).not.toContain(d.deviceCode);
    expect(stored).not.toContain(d.userCode);
    expect(stored).not.toContain(normalizeUserCode(d.userCode));
    expect(stored).not.toContain("ins_");
  });

  it("requires a client name and tidies it for display", () => {
    const { deps } = setup();
    expect(() => startDevice(deps.db, "   ")).toThrow(ValidationError);
    expect(() => startDevice(deps.db, "\n\t")).toThrow(ValidationError);
    startDevice(deps.db, "  my\nlaptop  ");
    startDevice(deps.db, "x".repeat(200));
    const names = deps.db.prepare("select client_name from device_codes order by id").all() as { client_name: string }[];
    expect(names[0].client_name).toBe("mylaptop");
    expect(names[1].client_name).toHaveLength(64);
  });

  it("forgets codes that expired long ago", () => {
    const { deps } = setup();
    startDevice(deps.db, "old", T0);
    startDevice(deps.db, "fresh", T0 + 3600 + 601);
    const rows = deps.db.prepare("select client_name from device_codes").all() as { client_name: string }[];
    expect(rows.map((r) => r.client_name)).toEqual(["fresh"]);
  });

  it("looks the expired rows up by index, not by scanning the table", () => {
    const { deps } = setup();
    const plan = deps.db.prepare("explain query plan delete from device_codes where expires_at < ?").all(0) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/USING (COVERING )?INDEX device_codes_expires_at/);
  });
});

describe("the cap on pending device codes", () => {
  const fill = (db: Parameters<typeof startDevice>[0], n: number, at: number) => {
    for (let i = 0; i < n; i++) startDevice(db, `pc-${i}`, at);
  };

  it("refuses a new code once MAX_PENDING_DEVICE_CODES are waiting, and says when a slot frees up", () => {
    const { deps } = setup();
    expect(MAX_PENDING_DEVICE_CODES).toBe(1000);
    fill(deps.db, MAX_PENDING_DEVICE_CODES, T0);
    expect(() => startDevice(deps.db, "one-too-many", T0 + 100)).toThrow(DeviceCapacityError);
    try {
      startDevice(deps.db, "one-too-many", T0 + 100);
    } catch (err) {
      expect((err as DeviceCapacityError).retryAfter).toBe(500); // the first code expires at T0 + 600
    }
    const count = deps.db.prepare("select count(*) as n from device_codes").get() as { n: number };
    expect(count.n).toBe(MAX_PENDING_DEVICE_CODES);
  });

  it("counts only codes that are still open: a decided one frees its slot", () => {
    const { deps, ada } = setup();
    const first = startDevice(deps.db, "first", T0);
    fill(deps.db, MAX_PENDING_DEVICE_CODES - 1, T0);
    expect(() => startDevice(deps.db, "no-room", T0 + 1)).toThrow(DeviceCapacityError);

    const row = findPendingByUserCode(deps.db, first.userCode, T0 + 1)!;
    expect(decideDevice(deps.db, row.id, ada.id, false, T0 + 1)).toBe(true);
    expect(() => startDevice(deps.db, "fits-now", T0 + 1)).not.toThrow();
    expect(() => startDevice(deps.db, "full-again", T0 + 1)).toThrow(DeviceCapacityError);
  });

  it("still sweeps long-expired rows on the request it turns away", () => {
    const { deps } = setup();
    fill(deps.db, MAX_PENDING_DEVICE_CODES, T0);
    deps.db
      .prepare("insert into device_codes (device_code_hash, user_code_hash, client_name, expires_at, created_at) values ('d', 'u', 'ancient', ?, ?)")
      .run(T0 - 4000, T0 - 4600);
    expect(() => startDevice(deps.db, "no-room", T0)).toThrow(DeviceCapacityError);
    const names = deps.db.prepare("select client_name from device_codes where client_name = 'ancient'").all();
    expect(names).toHaveLength(0);
  });

  it("frees every slot when the codes expire", () => {
    const { deps } = setup();
    fill(deps.db, MAX_PENDING_DEVICE_CODES, T0);
    expect(() => startDevice(deps.db, "early", T0 + 599)).toThrow(DeviceCapacityError);
    expect(() => startDevice(deps.db, "on-time", T0 + 600)).not.toThrow();
  });
});

describe("the cap on pending device codes per bucket", () => {
  const A = "203.0.113.9";
  const B = "203.0.113.10";
  const fillBucket = (db: Parameters<typeof startDevice>[0], bucket: string, n: number, at: number) => {
    for (let i = 0; i < n; i++) startDevice(db, `pc-${bucket}-${i}`, at, bucket);
  };
  const refusal = (fn: () => unknown): DeviceCapacityError => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceCapacityError);
      return err as DeviceCapacityError;
    }
    throw new Error("expected a DeviceCapacityError");
  };

  it("lets one bucket have MAX_PENDING_PER_BUCKET open codes, then turns it away and says when its first one expires", () => {
    const { deps } = setup();
    expect(MAX_PENDING_PER_BUCKET).toBe(5);
    fillBucket(deps.db, A, MAX_PENDING_PER_BUCKET, T0);
    const err = refusal(() => startDevice(deps.db, "sixth", T0 + 100, A));
    expect(err.scope).toBe("bucket");
    expect(err.retryAfter).toBe(500); // the first code expires at T0 + 600
    const count = deps.db.prepare("select count(*) as n from device_codes").get() as { n: number };
    expect(count.n).toBe(MAX_PENDING_PER_BUCKET);
  });

  it("leaves every other bucket alone while one is full", () => {
    const { deps } = setup();
    fillBucket(deps.db, A, MAX_PENDING_PER_BUCKET, T0);
    expect(() => startDevice(deps.db, "x", T0, A)).toThrow(DeviceCapacityError);
    expect(() => startDevice(deps.db, "x", T0, B)).not.toThrow();
    expect(() => startDevice(deps.db, "x", T0, "2001:db8:1::/48")).not.toThrow();
    // A caller that names no bucket is only held to the table-wide cap.
    for (let i = 0; i < MAX_PENDING_PER_BUCKET + 2; i++) expect(() => startDevice(deps.db, "x", T0)).not.toThrow();
  });

  it("counts only the bucket's open codes: a decided or an expired one frees its slot, other buckets' codes do not count", () => {
    const { deps, ada } = setup();
    fillBucket(deps.db, B, MAX_PENDING_PER_BUCKET, T0); // B being full does not use up A's allowance
    const first = startDevice(deps.db, "first", T0, A);
    fillBucket(deps.db, A, MAX_PENDING_PER_BUCKET - 1, T0);
    expect(() => startDevice(deps.db, "no-room", T0 + 1, A)).toThrow(DeviceCapacityError);

    const row = findPendingByUserCode(deps.db, first.userCode, T0 + 1)!;
    expect(decideDevice(deps.db, row.id, ada.id, false, T0 + 1)).toBe(true);
    expect(() => startDevice(deps.db, "fits-now", T0 + 1, A)).not.toThrow();
    expect(() => startDevice(deps.db, "full-again", T0 + 1, A)).toThrow(DeviceCapacityError);

    // The codes made at T0 expire at T0 + 600; the one made at T0 + 1 is the only one left then.
    expect(() => startDevice(deps.db, "after-expiry", T0 + 600, A)).not.toThrow();
  });

  it("says when the bucket's own oldest code expires, not the table's", () => {
    const { deps } = setup();
    startDevice(deps.db, "someone-else", T0, B); // expires at T0 + 600
    fillBucket(deps.db, A, MAX_PENDING_PER_BUCKET, T0 + 200); // expire at T0 + 800
    expect(refusal(() => startDevice(deps.db, "x", T0 + 300, A)).retryAfter).toBe(500);
  });

  it("checks the bucket before the table-wide cap", () => {
    const { deps } = setup();
    fillBucket(deps.db, A, MAX_PENDING_PER_BUCKET, T0);
    for (let i = 0; i < MAX_PENDING_DEVICE_CODES - MAX_PENDING_PER_BUCKET; i++) startDevice(deps.db, `pc-${i}`, T0);
    // The table is full now. The full bucket is told so (it can only wait for its own codes)...
    expect(refusal(() => startDevice(deps.db, "x", T0 + 1, A)).scope).toBe("bucket");
    // ...and a bucket with room is told that the table is full.
    expect(refusal(() => startDevice(deps.db, "x", T0 + 1, B)).scope).toBe("global");
  });

  it("still enforces the table-wide cap when every bucket is under its own", () => {
    const { deps } = setup();
    const buckets = MAX_PENDING_DEVICE_CODES / MAX_PENDING_PER_BUCKET;
    for (let b = 0; b < buckets; b++) fillBucket(deps.db, `198.51.100.${b}`, MAX_PENDING_PER_BUCKET, T0);
    const err = refusal(() => startDevice(deps.db, "one-too-many", T0 + 100, "192.0.2.1"));
    expect(err.scope).toBe("global");
    expect(err.retryAfter).toBe(500);
    const count = deps.db.prepare("select count(*) as n from device_codes").get() as { n: number };
    expect(count.n).toBe(MAX_PENDING_DEVICE_CODES);
  });

  it("records the bucket on the row (null when none is given) and counts by it through an index", () => {
    const { deps } = setup();
    startDevice(deps.db, "with", T0, A);
    startDevice(deps.db, "without", T0);
    const rows = deps.db.prepare("select client_name, bucket from device_codes order by id").all() as { client_name: string; bucket: string | null }[];
    expect(rows).toEqual([
      { client_name: "with", bucket: A },
      { client_name: "without", bucket: null },
    ]);
    const plan = deps.db
      .prepare("explain query plan select count(*) as n, min(expires_at) as soonest from device_codes where bucket = ? and status = 'pending' and expires_at > ?")
      .all(A, T0) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/USING (COVERING )?INDEX device_codes_bucket/);
  });

  it("migrates a database that already holds device codes: they keep their rows and get no bucket", () => {
    const { deps } = setup();
    const version = (deps.db.prepare("pragma user_version").get() as { user_version: number }).user_version;
    // The bucket column is user_version 5. Rewind to that migration specifically: later migrations
    // must not be what this test undoes, or the column would not be added back.
    const beforeBucket = 4;
    // Later migrations are already applied. Drop what they added so replaying from the bucket migration can succeed.
    deps.db.exec(`
      drop table if exists repo_analyses;
      drop table if exists release_assets;
      drop table if exists releases;
      drop table if exists repo_topics;
      drop table if exists topics;
      drop table if exists watches;
      alter table repos drop column forked_from_id;
      alter table repos drop column website;
      drop index if exists device_codes_bucket;
      alter table device_codes drop column bucket;
      pragma user_version = ${beforeBucket};
    `);
    deps.db
      .prepare("insert into device_codes (device_code_hash, user_code_hash, client_name, expires_at, created_at) values ('d', 'u', 'legacy', ?, ?)")
      .run(T0 + 600, T0);

    migrate(deps.db);
    expect((deps.db.prepare("pragma user_version").get() as { user_version: number }).user_version).toBe(version);
    expect(deps.db.prepare("select client_name, bucket from device_codes").all()).toEqual([{ client_name: "legacy", bucket: null }]);
  });
});

describe("normalizeUserCode and findPendingByUserCode", () => {
  it("ignores case, dashes and spaces", () => {
    expect(normalizeUserCode("abcd efgh")).toBe("ABCDEFGH");
    expect(normalizeUserCode(" ab-cd  ef gh ")).toBe("ABCDEFGH");
    expect(normalizeUserCode("ABCD-EFGH")).toBe("ABCDEFGH");
  });

  it("matches a lowercase, space-separated entry of the same code", () => {
    const { deps } = setup();
    const d = startDevice(deps.db, "test-pc", T0);
    const typed = d.userCode.toLowerCase().replace("-", " ");
    expect(typed).toMatch(/^[a-z]{4} [a-z]{4}$/);
    const row = findPendingByUserCode(deps.db, typed, T0);
    expect(row?.clientName).toBe("test-pc");
    expect(row?.status).toBe("pending");
  });

  it("does not match wrong, expired or already decided codes", () => {
    const { deps, ada } = setup();
    const d = startDevice(deps.db, "test-pc", T0);
    expect(findPendingByUserCode(deps.db, "", T0)).toBeNull();
    expect(findPendingByUserCode(deps.db, "BBBB-BBBB", T0)).toBeNull();
    expect(findPendingByUserCode(deps.db, d.userCode, T0 + 600)).toBeNull();
    const row = findPendingByUserCode(deps.db, d.userCode, T0)!;
    expect(decideDevice(deps.db, row.id, ada.id, true, T0)).toBe(true);
    expect(findPendingByUserCode(deps.db, d.userCode, T0)).toBeNull();
  });
});

describe("pollDevice", () => {
  it("answers pending, then slow_down inside the interval, then pending again", () => {
    const { deps } = setup();
    const d = startDevice(deps.db, "test-pc", T0);
    expect(pollDevice(deps.db, d.deviceCode, T0)).toEqual({ status: "pending" });
    expect(pollDevice(deps.db, d.deviceCode, T0 + 1)).toEqual({ status: "slow_down" });
    expect(pollDevice(deps.db, d.deviceCode, T0 + 4)).toEqual({ status: "slow_down" });
    expect(pollDevice(deps.db, d.deviceCode, T0 + 5)).toEqual({ status: "pending" });
  });

  it("hands the token over exactly once, named after the machine", () => {
    const { deps, ada } = setup();
    const d = startDevice(deps.db, "test-pc", T0);
    const row = findPendingByUserCode(deps.db, d.userCode, T0)!;
    expect(decideDevice(deps.db, row.id, ada.id, true, T0)).toBe(true);

    const r = pollDevice(deps.db, d.deviceCode, T0 + 5);
    expect(r.status).toBe("approved");
    if (r.status !== "approved") throw new Error("unreachable");
    expect(r.token).toMatch(/^ins_/);
    expect(r.login).toBe("ada");
    expect(listAccessTokens(deps.db, ada.id).map((x) => x.name)).toEqual(["nsit on test-pc"]);
    expect(userForBearerToken(deps.db, r.token)?.user.username).toBe("ada");

    expect(pollDevice(deps.db, d.deviceCode, T0 + 10)).toEqual({ status: "expired" });
    expect(listAccessTokens(deps.db, ada.id)).toHaveLength(1);
    const status = deps.db.prepare("select status from device_codes").get() as { status: string };
    expect(status.status).toBe("consumed");
    expect(JSON.stringify(deps.db.prepare("select * from device_codes").all())).not.toContain(r.token);
  });

  it("reports a denial, and creates no token", () => {
    const { deps, ada } = setup();
    const d = startDevice(deps.db, "test-pc", T0);
    const row = findPendingByUserCode(deps.db, d.userCode, T0)!;
    expect(decideDevice(deps.db, row.id, ada.id, false, T0)).toBe(true);
    expect(pollDevice(deps.db, d.deviceCode, T0 + 5)).toEqual({ status: "denied" });
    expect(listAccessTokens(deps.db, ada.id)).toHaveLength(0);
  });

  it("expires after 600 seconds, even if approved but never collected", () => {
    const { deps, ada } = setup();
    const a = startDevice(deps.db, "pc-a", T0);
    expect(pollDevice(deps.db, a.deviceCode, T0 + 599)).toEqual({ status: "pending" });
    expect(pollDevice(deps.db, a.deviceCode, T0 + 600)).toEqual({ status: "expired" });

    const b = startDevice(deps.db, "pc-b", T0);
    const row = findPendingByUserCode(deps.db, b.userCode, T0)!;
    decideDevice(deps.db, row.id, ada.id, true, T0 + 100);
    expect(pollDevice(deps.db, b.deviceCode, T0 + 601)).toEqual({ status: "expired" });
    expect(listAccessTokens(deps.db, ada.id)).toHaveLength(0);
  });

  it("treats unknown device codes as expired", () => {
    const { deps } = setup();
    expect(pollDevice(deps.db, "nope", T0)).toEqual({ status: "expired" });
    expect(pollDevice(deps.db, "", T0)).toEqual({ status: "expired" });
  });

  it("refuses to decide an expired or already decided request", () => {
    const { deps, ada } = setup();
    const d = startDevice(deps.db, "test-pc", T0);
    const row = findPendingByUserCode(deps.db, d.userCode, T0)!;
    expect(decideDevice(deps.db, row.id, ada.id, true, T0 + 600)).toBe(false);
    expect(decideDevice(deps.db, row.id, ada.id, false, T0 + 1)).toBe(true);
    expect(decideDevice(deps.db, row.id, ada.id, true, T0 + 2)).toBe(false);
    expect(pollDevice(deps.db, d.deviceCode, T0 + 5)).toEqual({ status: "denied" });
  });
});

describe("POST /api/v1/device/code", () => {
  it("needs no token and returns the device-flow document", async () => {
    const { start } = setup();
    const { res, body } = await start("test-pc");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(body).sort()).toEqual(["device_code", "expires_in", "interval", "user_code", "verification_uri"]);
    expect(body.user_code).toMatch(USER_CODE);
    expect(body.verification_uri).toBe("http://localhost:3000/login/device");
    expect(body.expires_in).toBe(600);
    expect(body.interval).toBe(5);
    expect(typeof body.device_code).toBe("string");
  });

  it("answers 422 for a missing client name and 400 for a non-object body", async () => {
    const { app } = setup();
    for (const body of [{}, { client_name: 5 }, { client_name: "  " }]) {
      const res = await jsonPost(app, "/api/v1/device/code", body);
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("invalid");
    }
    for (const body of ["{nope", "[]", "null"]) {
      const res = await jsonPost(app, "/api/v1/device/code", body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
    }
  });

  // The rate limit lets one address ask for 10 codes a minute, which is more than may wait for approval
  // at once (MAX_PENDING_PER_BUCKET), so the tests of the rate limit decide each code as soon as it is
  // issued: a decided code no longer waits, and the rate limit is then the only thing that can refuse.
  const settle = (db: Parameters<typeof startDevice>[0]) => db.exec("update device_codes set status = 'denied' where status = 'pending'");

  it("allows 10 requests a minute per client address, then 429, then recovers", async () => {
    const { start, app, deps } = setup();
    for (let i = 0; i < 10; i++) {
      expect((await start()).res.status).toBe(200);
      settle(deps.db);
    }

    const blocked = await jsonPost(app, "/api/v1/device/code", { client_name: "test-pc" });
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe("rate_limited");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

    advance(61);
    expect((await start()).res.status).toBe(200);
  });

  // In-process requests have no socket, so these hand Hono the connection details a real server would.
  const from = (app: Hono<any>, address: string) =>
    app.request(
      "/api/v1/device/code",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "test-pc" }) },
      { incoming: { socket: { remoteAddress: address } } },
    );

  it("shares one allowance between all the addresses of an IPv6 /64, but not between /64s", async () => {
    const { app, deps } = setup();
    const settled = async (address: string) => {
      const res = await from(app, address);
      settle(deps.db);
      return res;
    };
    // Ten different addresses of 2001:db8:1:2::/64 use up the bucket...
    for (let i = 0; i < 10; i++) expect((await settled(`2001:db8:1:2:${i + 1}::${i + 1}`)).status).toBe(200);
    // ...so an eleventh address in the same /64 is blocked, however it is written...
    for (const address of ["2001:db8:1:2:ffff:ffff:ffff:ffff", "2001:DB8:1:2::", "2001:db8:1:2::1"]) {
      const blocked = await settled(address);
      expect(blocked.status).toBe(429);
      expect((await blocked.json()).error.code).toBe("rate_limited");
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    }
    // ...while the neighbouring /64s are untouched.
    expect((await settled("2001:db8:1:3::1")).status).toBe(200);
    expect((await settled("2001:db8:2:2::1")).status).toBe(200);
  });

  it("keeps limiting IPv4 per address, and counts an IPv4-mapped IPv6 address as its IPv4", async () => {
    const { app, deps } = setup();
    const settled = async (address: string) => {
      const res = await from(app, address);
      settle(deps.db);
      return res;
    };
    for (let i = 0; i < 5; i++) expect((await settled("203.0.113.9")).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await settled("::ffff:203.0.113.9")).status).toBe(200);
    expect((await settled("203.0.113.9")).status).toBe(429);
    expect((await settled("::ffff:203.0.113.9")).status).toBe(429);
    // A neighbour on the same /24 is a different client.
    expect((await settled("203.0.113.10")).status).toBe(200);
  });

  it("lets an IPv4 address keep MAX_PENDING_PER_BUCKET sign-ins waiting, then answers 429 rate_limited for that address only", async () => {
    const { app, deps } = setup();
    for (let i = 0; i < MAX_PENDING_PER_BUCKET; i++) expect((await from(app, "203.0.113.9")).status).toBe(200);

    const blocked = await from(app, "203.0.113.9");
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.message).toContain("from your network");
    expect(blocked.headers.get("retry-after")).toBe("600");
    // An IPv4-mapped IPv6 address is the same source.
    expect((await from(app, "::ffff:203.0.113.9")).status).toBe(429);
    const count = deps.db.prepare("select count(*) as n from device_codes").get() as { n: number };
    expect(count.n).toBe(MAX_PENDING_PER_BUCKET);

    // Everyone else can still sign in, and so can this address once a code is decided or expires.
    expect((await from(app, "203.0.113.10")).status).toBe(200);
    expect((await from(app, "198.51.100.1")).status).toBe(200);
    advance(100);
    expect((await from(app, "203.0.113.9")).headers.get("retry-after")).toBe("500");
    advance(501);
    expect((await from(app, "203.0.113.9")).status).toBe(200);
  });

  it("counts a whole IPv6 /48 as one source for the pending cap, though the rate limit counts per /64", async () => {
    const { app } = setup();
    // Five different /64s of 2001:db8:1::/48 each keep a sign-in waiting...
    for (let i = 0; i < MAX_PENDING_PER_BUCKET; i++) expect((await from(app, `2001:db8:1:${i + 1}::1`)).status).toBe(200);
    // ...so a sixth /64 of the same /48 (a fresh rate-limit bucket) is turned away, however it is written...
    for (const address of ["2001:db8:1:99::1", "2001:DB8:0001:ffff:aaaa:bbbb:cccc:dddd", "2001:db8:1::"]) {
      const blocked = await from(app, address);
      expect(blocked.status).toBe(429);
      expect((await blocked.json()).error.code).toBe("rate_limited");
      expect(blocked.headers.get("retry-after")).toBe("600");
    }
    // ...while other /48s are untouched.
    expect((await from(app, "2001:db8:2:1::1")).status).toBe(200);
    expect((await from(app, "2001:db9:1:1::1")).status).toBe(200);
  });

  it("still enforces the table-wide cap when no single address is over its own", async () => {
    const { app, deps } = setup();
    const buckets = MAX_PENDING_DEVICE_CODES / MAX_PENDING_PER_BUCKET;
    for (let b = 0; b < buckets; b++) {
      for (let i = 0; i < MAX_PENDING_PER_BUCKET; i++) startDevice(deps.db, `pc-${b}-${i}`, T0, `198.51.100.${b}`);
    }
    const full = await from(app, "192.0.2.1");
    expect(full.status).toBe(429);
    const body = await full.json();
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.message).not.toContain("from your network");
    expect(full.headers.get("retry-after")).toBe("600");
  });

  it("answers 429 rate_limited with retry-after while MAX_PENDING_DEVICE_CODES sign-ins are waiting", async () => {
    const { app, deps } = setup();
    for (let i = 0; i < MAX_PENDING_DEVICE_CODES; i++) startDevice(deps.db, `pc-${i}`, T0);

    const full = await jsonPost(app, "/api/v1/device/code", { client_name: "one-too-many" });
    expect(full.status).toBe(429);
    expect((await full.json()).error.code).toBe("rate_limited");
    expect(full.headers.get("retry-after")).toBe("600");
    const count = deps.db.prepare("select count(*) as n from device_codes").get() as { n: number };
    expect(count.n).toBe(MAX_PENDING_DEVICE_CODES);

    // The wait shrinks as the open codes age, and the endpoint reopens once they expire.
    advance(100);
    const later = await jsonPost(app, "/api/v1/device/code", { client_name: "one-too-many" });
    expect(later.status).toBe(429);
    expect(later.headers.get("retry-after")).toBe("500");

    advance(500);
    const open = await jsonPost(app, "/api/v1/device/code", { client_name: "fits-now" });
    expect(open.status).toBe(200);
  });

  it("validates the request body before it reports that the queue is full", async () => {
    const { app, deps } = setup();
    for (let i = 0; i < MAX_PENDING_DEVICE_CODES; i++) startDevice(deps.db, `pc-${i}`, T0);
    // A malformed request is still a 4xx about the request, so a broken client sees its own mistake.
    expect((await jsonPost(app, "/api/v1/device/code", "[]")).status).toBe(400);
    expect((await jsonPost(app, "/api/v1/device/code", {})).status).toBe(422);
  });
});

describe("POST /api/v1/device/token", () => {
  it("answers authorization_pending, then slow_down when polled too soon", async () => {
    const { start, poll } = setup();
    const { body } = await start();

    const first = await poll(body.device_code);
    expect(first.status).toBe(400);
    expect((await first.json()).error.code).toBe("authorization_pending");

    advance(2);
    const second = await poll(body.device_code);
    expect(second.status).toBe(400);
    expect((await second.json()).error.code).toBe("slow_down");

    advance(5);
    expect((await (await poll(body.device_code)).json()).error.code).toBe("authorization_pending");
  });

  it("answers expired_token for unknown codes and expired_token past 600 seconds", async () => {
    const { start, poll } = setup();
    const unknown = await poll("not-a-code");
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error.code).toBe("expired_token");

    const { body } = await start();
    advance(601);
    const late = await poll(body.device_code);
    expect(late.status).toBe(400);
    expect((await late.json()).error.code).toBe("expired_token");
  });

  it("validates the request body", async () => {
    const { app } = setup();
    const missing = await jsonPost(app, "/api/v1/device/token", {});
    expect(missing.status).toBe(422);
    expect((await missing.json()).error.code).toBe("invalid");
    const bad = await jsonPost(app, "/api/v1/device/token", "[]");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("bad_request");
  });
});

describe("approving through the web pages", () => {
  it("signs the CLI in end to end, then revokes the token on logout", async () => {
    const { app, post, get, adaWho, deps, ada, start, poll } = setup();
    const { body } = await start("test-pc");

    expect((await poll(body.device_code)).status).toBe(400);

    // Ada types the code in lowercase with a space; the page shows who is asking.
    const typed = body.user_code.toLowerCase().replace("-", " ");
    const entry = await get("/login/device", adaWho);
    expect(entry.status).toBe(200);
    expect(await entry.text()).toContain('name="user_code"');

    const confirm = await post("/login/device", { user_code: typed }, adaWho);
    expect(confirm.status).toBe(200);
    const confirmHtml = await confirm.text();
    expect(confirmHtml).toContain("nsit on test-pc");
    expect(confirmHtml).toContain('value="approve"');
    expect(confirmHtml).toContain('value="deny"');
    expect(confirmHtml).toContain(`value="${normalizeUserCode(body.user_code)}"`);

    const decided = await post("/login/device/decide", { user_code: normalizeUserCode(body.user_code), decision: "approve" }, adaWho);
    expect(decided.status).toBe(200);
    expect(await decided.text()).toContain("Device connected");

    advance(5);
    const ok = await poll(body.device_code);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const issued = await ok.json();
    expect(issued.token_type).toBe("bearer");
    expect(issued.login).toBe("ada");
    expect(issued.access_token).toMatch(/^ins_/);
    expect(listAccessTokens(deps.db, ada.id).map((t) => t.name)).toEqual(["nsit on test-pc"]);

    const bearer = { authorization: `Bearer ${issued.access_token}` };
    expect((await app.request("/api/v1/user", { headers: bearer })).status).toBe(200);

    // The code is single use.
    advance(5);
    const again = await poll(body.device_code);
    expect(again.status).toBe(400);
    expect((await again.json()).error.code).toBe("expired_token");

    const logout = await app.request("/api/v1/user/tokens/current", { method: "DELETE", headers: bearer });
    expect(logout.status).toBe(204);
    expect(await logout.text()).toBe("");
    const after = await app.request("/api/v1/user", { headers: bearer });
    expect(after.status).toBe(401);
    expect(listAccessTokens(deps.db, ada.id)).toHaveLength(0);
  });

  it("reports access_denied when Ada denies the request", async () => {
    const { post, adaWho, deps, ada, start, poll } = setup();
    const { body } = await start("test-pc");
    const code = normalizeUserCode(body.user_code);

    const res = await post("/login/device/decide", { user_code: code, decision: "deny" }, adaWho);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Request denied");

    const denied = await poll(body.device_code);
    expect(denied.status).toBe(400);
    expect((await denied.json()).error.code).toBe("access_denied");
    expect(listAccessTokens(deps.db, ada.id)).toHaveLength(0);
  });

  it("issues the token to whoever approved, not to anyone else", async () => {
    const { post, user, loginAs, start, poll, deps } = setup();
    const bob = user("bob");
    const { body } = await start("bobs-box");
    await post("/login/device/decide", { user_code: body.user_code, decision: "approve" }, loginAs(bob));
    const issued = await (await poll(body.device_code)).json();
    expect(issued.login).toBe("bob");
    expect(listAccessTokens(deps.db, bob.id)).toHaveLength(1);
  });

  it("shows an error for a wrong code and lets Ada retry", async () => {
    const { post, adaWho } = setup();
    const res = await post("/login/device", { user_code: "BBBB-BBBB" }, adaWho);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("isn&#39;t valid or has expired");
    expect(html).toContain('name="user_code"');
  });

  it("will not approve a request twice or after it expired", async () => {
    const { post, adaWho, start } = setup();
    const { body } = await start("test-pc");
    const code = normalizeUserCode(body.user_code);
    expect((await post("/login/device/decide", { user_code: code, decision: "deny" }, adaWho)).status).toBe(200);
    const twice = await post("/login/device/decide", { user_code: code, decision: "approve" }, adaWho);
    expect(twice.status).toBe(400);

    const second = await start("other-pc");
    advance(601);
    const late = await post("/login/device/decide", { user_code: normalizeUserCode(second.body.user_code), decision: "approve" }, adaWho);
    expect(late.status).toBe(400);
  });

  it("rejects a decision that is neither approve nor deny", async () => {
    const { post, adaWho, start, poll } = setup();
    const { body } = await start("test-pc");
    const res = await post("/login/device/decide", { user_code: body.user_code, decision: "maybe" }, adaWho);
    expect(res.status).toBe(400);
    advance(5);
    expect((await (await poll(body.device_code)).json()).error.code).toBe("authorization_pending");
  });

  it("throttles someone who keeps guessing codes", async () => {
    const { post, adaWho } = setup();
    for (let i = 0; i < 10; i++) expect((await post("/login/device", { user_code: "BBBB-BBBB" }, adaWho)).status).toBe(400);
    const blocked = await post("/login/device", { user_code: "BBBB-BBBB" }, adaWho);
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain("Too many");
  });
});

describe("device pages need sign-in and CSRF", () => {
  it("sends anonymous visitors to sign in and back", async () => {
    const { get, post, anon } = setup();
    const check = (res: Response, next: string) => {
      expect(res.status).toBe(302);
      const url = new URL(res.headers.get("location")!, "http://localhost:3000");
      expect(url.pathname).toBe("/login");
      expect(url.searchParams.get("next")).toBe(next);
    };
    check(await get("/login/device"), "/login/device");
    check(await get("/login/device?user_code=ABCD-EFGH"), "/login/device?user_code=ABCD-EFGH");
    check(await post("/login/device", { user_code: "ABCD-EFGH" }, anon), "/login/device");
    const decide = await post("/login/device/decide", { user_code: "ABCD-EFGH", decision: "approve" }, anon);
    expect(decide.status).toBe(302);
    expect(new URL(decide.headers.get("location")!, "http://localhost:3000").pathname).toBe("/login");
  });

  it("rejects form posts without the CSRF token", async () => {
    const { app, adaWho, start, poll } = setup();
    const { body } = await start("test-pc");
    for (const path of ["/login/device", "/login/device/decide"]) {
      const res = await app.request(path, {
        method: "POST",
        headers: { cookie: adaWho.cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ user_code: body.user_code, decision: "approve" }),
      });
      expect(res.status).toBe(403);
    }
    advance(5);
    expect((await (await poll(body.device_code)).json()).error.code).toBe("authorization_pending");
  });

  it("prefills the code from the link", async () => {
    const { get, adaWho } = setup();
    const res = await get("/login/device?user_code=ABCD-EFGH", adaWho);
    expect(await res.text()).toContain('value="ABCD-EFGH"');
  });
});

describe("DELETE /api/v1/user/tokens/current", () => {
  it("requires a token", async () => {
    const { app } = setup();
    const res = await app.request("/api/v1/user/tokens/current", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("revokes only the token that made the request", async () => {
    const { app, deps, ada } = setup();
    const keep = createAccessToken(deps.db, ada.id, "keep");
    const drop = createAccessToken(deps.db, ada.id, "drop");
    const res = await app.request("/api/v1/user/tokens/current", { method: "DELETE", headers: { authorization: `Bearer ${drop}` } });
    expect(res.status).toBe(204);
    expect(listAccessTokens(deps.db, ada.id).map((t) => t.name)).toEqual(["keep"]);
    expect((await app.request("/api/v1/user", { headers: { authorization: `Bearer ${keep}` } })).status).toBe(200);
  });
});

describe("createRateLimiter", () => {
  it("allows `max` records per window per key and slides", () => {
    const limiter = createRateLimiter(3, 1000);
    for (let i = 0; i < 3; i++) {
      expect(limiter.retryAfter("a", 0)).toBe(0);
      limiter.record("a", 0);
    }
    expect(limiter.retryAfter("a", 500)).toBe(1);
    expect(limiter.retryAfter("b", 500)).toBe(0);
    expect(limiter.retryAfter("a", 1000)).toBe(0);
  });

  it("reports how long until the oldest hit leaves the window", () => {
    const limiter = createRateLimiter(1, 60_000);
    limiter.record("a", 10_000);
    expect(limiter.retryAfter("a", 20_000)).toBe(50);
    expect(limiter.retryAfter("a", 69_500)).toBe(1);
  });

  it("holds at most `maxKeys` keys: past that the key that was active longest ago is evicted", () => {
    const limiter = createRateLimiter(1, 60_000, 3);
    limiter.record("a", 0);
    limiter.record("b", 1);
    limiter.record("c", 2);
    expect(limiter.size()).toBe(3);
    limiter.record("d", 3);
    expect(limiter.size()).toBe(3);
    expect(limiter.retryAfter("a", 4)).toBe(0); // evicted
    for (const key of ["b", "c", "d"]) expect(limiter.retryAfter(key, 4)).toBeGreaterThan(0);
  });

  it("treats a key as active when it records again, so a busy key is not the one evicted", () => {
    const limiter = createRateLimiter(5, 60_000, 3);
    limiter.record("a", 0);
    limiter.record("b", 1);
    limiter.record("c", 2);
    limiter.record("a", 3); // a is now the most recently active
    limiter.record("d", 4); // evicts b
    expect(limiter.size()).toBe(3);
    expect(limiter.retryAfter("b", 5)).toBe(0);
    limiter.record("b", 5); // evicts c; a and d stay
    expect(limiter.size()).toBe(3);
    expect(limiter.retryAfter("c", 6)).toBe(0);
    // a kept its first two hits through all of that: three more reach the limit of 5.
    expect(limiter.retryAfter("a", 6)).toBe(0);
    for (let i = 0; i < 3; i++) limiter.record("a", 7 + i);
    expect(limiter.retryAfter("a", 10)).toBeGreaterThan(0);
  });

  it("drops keys whose hits have all aged out when something new is recorded", () => {
    const limiter = createRateLimiter(1, 1000, 100);
    for (const key of ["a", "b", "c"]) limiter.record(key, 0);
    limiter.record("fresh", 500);
    expect(limiter.size()).toBe(4); // nothing has aged out yet
    limiter.record("later", 1500); // every earlier hit (0 and 500) is now outside the 1000 ms window
    expect(limiter.size()).toBe(1);
  });

  it("stays bounded at the default cap however many keys it sees", () => {
    const limiter = createRateLimiter(1, 60_000);
    for (let i = 0; i < 12_000; i++) limiter.record(`k${i}`, i);
    expect(limiter.size()).toBe(10_000);
    expect(limiter.retryAfter("k0", 12_000)).toBe(0);
    expect(limiter.retryAfter("k1999", 12_000)).toBe(0);
    expect(limiter.retryAfter("k2000", 12_000)).toBeGreaterThan(0);
    expect(limiter.retryAfter("k11999", 12_000)).toBeGreaterThan(0);
  });

  it("remembers only the last `max` hits of a key, so one key cannot grow without bound", () => {
    const limiter = createRateLimiter(2, 100_000);
    for (let i = 0; i < 5; i++) limiter.record("a", i * 10_000); // hits at 0, 10k, 20k, 30k, 40k
    // The two newest hits (30k and 40k) decide: a may act again once 30k leaves the window, at 130k.
    expect(limiter.retryAfter("a", 50_000)).toBe(80);
    expect(limiter.retryAfter("a", 129_999)).toBe(1);
    expect(limiter.retryAfter("a", 130_000)).toBe(0);
  });
});
