import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { createRateLimiter } from "../src/rateLimit.js";
import {
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

  it("allows 10 requests a minute per client address, then 429, then recovers", async () => {
    const { start, app } = setup();
    for (let i = 0; i < 10; i++) expect((await start()).res.status).toBe(200);

    const blocked = await jsonPost(app, "/api/v1/device/code", { client_name: "test-pc" });
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe("rate_limited");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

    advance(61);
    expect((await start()).res.status).toBe(200);
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
});
