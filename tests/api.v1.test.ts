import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/web/env.js";
import { csrfGuard, loadSession } from "../src/web/middleware.js";
import { createRepo } from "../src/services/repos.js";
import { createAccessToken, deleteAccessToken, listAccessTokens, userForBearerToken } from "../src/services/users.js";
import { testApp } from "./helpers.js";

/** A test app with `ada` and `bob`, each holding a personal access token. */
function setup() {
  const t = testApp();
  const ada = t.user("ada");
  const bob = t.user("bob");
  const adaToken = createAccessToken(t.deps.db, ada.id, "cli");
  const bobToken = createAccessToken(t.deps.db, bob.id, "cli");
  const call = (path: string, token?: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    t.app.request(path, {
      method: init.method ?? "GET",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
    });
  const mkRepo = (owner: typeof ada, name: string, isPrivate: boolean) =>
    createRepo(t.deps, owner, { name, description: `${name} repo`, isPrivate, initReadme: false });
  return { ...t, ada, bob, adaToken, bobToken, call, mkRepo };
}

describe("userForBearerToken", () => {
  it("resolves a token to its user and token id, and records the use", () => {
    const { deps, ada, adaToken } = setup();
    expect(listAccessTokens(deps.db, ada.id)[0].lastUsedAt).toBeNull();

    const found = userForBearerToken(deps.db, adaToken);
    expect(found?.user.username).toBe("ada");
    expect(found?.tokenId).toBe(listAccessTokens(deps.db, ada.id)[0].id);
    expect(listAccessTokens(deps.db, ada.id)[0].lastUsedAt).not.toBeNull();
  });

  it("returns null for unknown tokens", () => {
    const { deps } = setup();
    expect(userForBearerToken(deps.db, "ins_nope")).toBeNull();
    expect(userForBearerToken(deps.db, "")).toBeNull();
  });
});

describe("API v1 authentication", () => {
  it("answers 401 with a JSON error when no token is sent", async () => {
    const { call } = setup();
    const res = await call("/api/v1/user");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
    expect(typeof body.error.message).toBe("string");
  });

  it("does not accept a browser session cookie", async () => {
    const { app, ada, loginAs } = setup();
    const res = await app.request("/api/v1/user", { headers: { cookie: loginAs(ada).cookie } });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  it("rejects unknown tokens, other schemes, and revoked tokens", async () => {
    const { call, deps, ada, adaToken } = setup();
    expect((await call("/api/v1/user", "ins_notarealtoken")).status).toBe(401);
    expect((await call("/api/v1/user", undefined, { headers: { authorization: `Basic ${adaToken}` } })).status).toBe(401);
    expect((await call("/api/v1/user", undefined, { headers: { authorization: "Bearer" } })).status).toBe(401);

    expect((await call("/api/v1/user", adaToken)).status).toBe(200);
    deleteAccessToken(deps.db, ada.id, listAccessTokens(deps.db, ada.id)[0].id);
    expect((await call("/api/v1/user", adaToken)).status).toBe(401);
  });

  it("accepts the Bearer scheme in any letter case", async () => {
    const { call, adaToken } = setup();
    const res = await call("/api/v1/user", undefined, { headers: { authorization: `bearer ${adaToken}` } });
    expect(res.status).toBe(200);
  });

  it("does not need a CSRF token for bearer-authenticated writes", async () => {
    const { call, adaToken } = setup();
    const res = await call("/api/v1/repos", adaToken, { method: "POST", body: { name: "nocsrf" } });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(201);
  });
});

describe("csrfGuard and /api/ paths", () => {
  it("skips CSRF checks under /api/ wherever the API is mounted, and still guards everything else", async () => {
    const t = testApp();
    const app = new Hono<Env>();
    app.use("*", loadSession(t.deps));
    app.use("*", csrfGuard((c) => c.text("csrf", 403)));
    app.post("/api/anything", (c) => c.text("ok"));
    app.post("/form", (c) => c.text("ok"));

    expect((await app.request("/api/anything", { method: "POST" })).status).toBe(200);
    expect((await app.request("/form", { method: "POST" })).status).toBe(403);
  });
});

describe("GET /api/v1/user", () => {
  it("returns the token's owner", async () => {
    const { call, adaToken } = setup();
    const res = await call("/api/v1/user", adaToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ login: "ada", name: "", email: "ada@example.com", is_admin: false });
  });

  it("reports the display name and admin flag", async () => {
    const t = testApp();
    const boss = t.user("boss", { isAdmin: true });
    t.deps.db.prepare("update users set display_name = ? where id = ?").run("The Boss", boss.id);
    const token = createAccessToken(t.deps.db, boss.id, "cli");
    const res = await t.app.request("/api/v1/user", { headers: { authorization: `Bearer ${token}` } });
    expect(await res.json()).toMatchObject({ login: "boss", name: "The Boss", is_admin: true });
  });
});

describe("POST /api/v1/repos", () => {
  it("creates a private repository by default", async () => {
    const { call, adaToken } = setup();
    const res = await call("/api/v1/repos", adaToken, { method: "POST", body: { name: "tools" } });
    expect(res.status).toBe(201);
    const repo = await res.json();
    expect(repo).toMatchObject({
      owner: "ada",
      name: "tools",
      full_name: "ada/tools",
      description: "",
      private: true,
      default_branch: "main",
      clone_url: "http://localhost:3000/ada/tools.git",
      html_url: "http://localhost:3000/ada/tools",
    });
    expect(new Date(repo.created_at).toISOString()).toBe(repo.created_at);
    expect(Object.keys(repo).sort()).toEqual(
      ["clone_url", "created_at", "default_branch", "description", "full_name", "html_url", "name", "owner", "private"],
    );
  });

  it("honours description and private:false", async () => {
    const { call, adaToken } = setup();
    const res = await call("/api/v1/repos", adaToken, {
      method: "POST",
      body: { name: "open", description: "  hello  ", private: false },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: "open", description: "hello", private: false });
  });

  it("uses the configured base URL for links", async () => {
    const t = testApp({ baseUrl: "https://git.example.com" });
    const ada = t.user("ada");
    const token = createAccessToken(t.deps.db, ada.id, "cli");
    const res = await t.app.request("/api/v1/repos", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "tools" }),
    });
    expect(await res.json()).toMatchObject({
      clone_url: "https://git.example.com/ada/tools.git",
      html_url: "https://git.example.com/ada/tools",
    });
  });

  it("answers 422 name_taken for a repeat and 422 invalid for a bad name", async () => {
    const { call, adaToken } = setup();
    expect((await call("/api/v1/repos", adaToken, { method: "POST", body: { name: "tools" } })).status).toBe(201);

    const again = await call("/api/v1/repos", adaToken, { method: "POST", body: { name: "tools" } });
    expect(again.status).toBe(422);
    expect((await again.json()).error.code).toBe("name_taken");

    const bad = await call("/api/v1/repos", adaToken, { method: "POST", body: { name: "bad name" } });
    expect(bad.status).toBe(422);
    const body = await bad.json();
    expect(body.error.code).toBe("invalid");
    expect(body.error.message).toContain("Repository names may contain");
  });

  it("answers 422 invalid for wrongly typed fields", async () => {
    const { call, adaToken } = setup();
    for (const body of [{}, { name: 5 }, { name: "x", description: 1 }, { name: "x", private: "yes" }]) {
      const res = await call("/api/v1/repos", adaToken, { method: "POST", body });
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("invalid");
    }
  });

  it("answers 400 bad_request when the body is not a JSON object", async () => {
    const { call, adaToken } = setup();
    for (const body of ["{nope", "[]", "null", '"text"']) {
      const res = await call("/api/v1/repos", adaToken, { method: "POST", body });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
    }
  });

  it("answers 413 when the body is too large", async () => {
    const { call, adaToken } = setup();
    const res = await call("/api/v1/repos", adaToken, {
      method: "POST",
      body: { name: "big", description: "x".repeat(2 * 1024 * 1024) },
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("too_large");
  });

  it("requires a token", async () => {
    const { call } = setup();
    const res = await call("/api/v1/repos", undefined, { method: "POST", body: { name: "tools" } });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/repos", () => {
  it("lists only what the caller may see for an owner", async () => {
    const { call, ada, adaToken, bobToken, mkRepo } = setup();
    await mkRepo(ada, "open", false);
    await mkRepo(ada, "secret", true);

    const asBob = await call("/api/v1/repos?owner=ada", bobToken);
    expect(asBob.status).toBe(200);
    expect((await asBob.json()).map((r: { name: string }) => r.name)).toEqual(["open"]);

    const asAda = await call("/api/v1/repos?owner=ada", adaToken);
    expect((await asAda.json()).map((r: { name: string }) => r.name)).toEqual(["open", "secret"]);
  });

  it("lists every visible repository when no owner is given", async () => {
    const { call, ada, bob, bobToken, mkRepo } = setup();
    await mkRepo(ada, "open", false);
    await mkRepo(ada, "secret", true);
    await mkRepo(bob, "mine", true);

    const res = await call("/api/v1/repos", bobToken);
    expect(res.status).toBe(200);
    const names = (await res.json()).map((r: { full_name: string }) => r.full_name).sort();
    expect(names).toEqual(["ada/open", "bob/mine"]);
  });

  it("answers 404 for an unknown owner", async () => {
    const { call, adaToken } = setup();
    const res = await call("/api/v1/repos?owner=nobody", adaToken);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("requires a token", async () => {
    const { call } = setup();
    expect((await call("/api/v1/repos")).status).toBe(401);
  });
});

describe("GET /api/v1/repos/:owner/:name", () => {
  it("returns a visible repository", async () => {
    const { call, ada, bobToken, mkRepo } = setup();
    await mkRepo(ada, "open", false);
    const res = await call("/api/v1/repos/ada/open", bobToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      full_name: "ada/open",
      description: "open repo",
      private: false,
      clone_url: "http://localhost:3000/ada/open.git",
    });
  });

  it("hides private repositories from people without access", async () => {
    const { call, ada, adaToken, bobToken, mkRepo } = setup();
    await mkRepo(ada, "secret", true);

    const asBob = await call("/api/v1/repos/ada/secret", bobToken);
    expect(asBob.status).toBe(404);
    expect((await asBob.json()).error.code).toBe("not_found");

    // Identical to a repository that does not exist.
    const missing = await call("/api/v1/repos/ada/missing", bobToken);
    expect(missing.status).toBe(404);

    expect((await call("/api/v1/repos/ada/secret", adaToken)).status).toBe(200);
  });

  it("requires a token", async () => {
    const { call, ada, mkRepo } = setup();
    await mkRepo(ada, "open", false);
    expect((await call("/api/v1/repos/ada/open")).status).toBe(401);
  });
});

describe("unknown API paths", () => {
  it("answer with a JSON 404", async () => {
    const { call, adaToken } = setup();
    for (const token of [adaToken, undefined]) {
      const res = await call("/api/v1/nope", token);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect((await res.json()).error.code).toBe("not_found");
    }
  });
});
