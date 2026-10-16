import { describe, it, expect } from "vitest";
import { createInvite } from "../src/services/users.js";
import { testApp } from "./helpers.js";

describe("invite-only sign up", () => {
  it("rejects unknown invite links", async () => {
    const t = testApp();
    const res = await t.get("/join/not-a-real-token");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("This invite link is not valid.");
  });

  it("creates an account from a valid invite exactly once", async () => {
    const t = testApp();
    const admin = t.user("boss", { isAdmin: true });
    const token = createInvite(t.deps.db, admin.id);
    const form = { username: "newbie", email: "n@example.com", password: "longenough", confirm: "longenough" };

    const res = await t.post(`/join/${token}`, form);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/gfk_session=/);

    const session = cookie.match(/gfk_session=([^;]+)/)![1];
    const home = await t.get("/", { cookie: `gfk_session=${session}`, csrf: "" });
    expect(await home.text()).toContain("Top repositories");

    const again = await t.post(`/join/${token}`, { ...form, username: "second" });
    expect(again.status).toBe(404);
    expect(await again.text()).toContain("already been used");
  });

  it("re-renders the form when passwords don't match", async () => {
    const t = testApp();
    const admin = t.user("boss", { isAdmin: true });
    const token = createInvite(t.deps.db, admin.id);
    const res = await t.post(`/join/${token}`, { username: "x1", email: "", password: "longenough", confirm: "different1" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Passwords don&#39;t match");
  });
});

describe("sign in", () => {
  it("rejects wrong passwords and accepts right ones", async () => {
    const t = testApp();
    t.user("ada");
    const bad = await t.post("/login", { username: "ada", password: "wrong-password" });
    expect(bad.status).toBe(401);
    expect(await bad.text()).toContain("Incorrect username or password.");
    const ok = await t.post("/login?next=/settings/profile", { username: "ada", password: "longenough" });
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/settings/profile");
  });

  it("ignores off-site next parameters", async () => {
    const t = testApp();
    t.user("ada");
    const ok = await t.post("/login?next=//evil.example.com", { username: "ada", password: "longenough" });
    expect(ok.headers.get("location")).toBe("/");
  });

  it("requires a CSRF token on every POST", async () => {
    const t = testApp();
    t.user("ada");
    const res = await t.app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=ada&password=longenough",
    });
    expect(res.status).toBe(403);
  });

  it("redirects anonymous visitors from settings to sign in", async () => {
    const t = testApp();
    const res = await t.get("/settings/profile");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Fsettings%2Fprofile");
  });
});

describe("settings and site admin", () => {
  it("creates a personal access token and shows it once", async () => {
    const t = testApp();
    const ada = t.loginAs(t.user("ada"));
    const res = await t.post("/settings/tokens", { name: "laptop" }, ada);
    const html = await res.text();
    expect(html).toMatch(/value="gfk_[A-Za-z0-9_-]+"/);
    const list = await (await t.get("/settings/tokens", ada)).text();
    expect(list).toContain("laptop");
    expect(list).not.toMatch(/value="gfk_/);
  });

  it("hides site admin from non-admins and lets admins create invites", async () => {
    const t = testApp();
    const ada = t.loginAs(t.user("ada"));
    expect((await t.get("/site-admin", ada)).status).toBe(404);
    const boss = t.loginAs(t.user("boss", { isAdmin: true }));
    const res = await t.post("/site-admin/invites", {}, boss);
    expect(await res.text()).toMatch(/http:\/\/localhost:3000\/join\/[A-Za-z0-9_-]+/);
  });

  it("only offers user invites when enabled", async () => {
    const off = testApp();
    const a = off.loginAs(off.user("ada"));
    expect((await off.get("/settings/invites", a)).status).toBe(404);
    const on = testApp({ allowUserInvites: true });
    const b = on.loginAs(on.user("ada"));
    expect((await on.get("/settings/invites", b)).status).toBe(200);
  });
});
