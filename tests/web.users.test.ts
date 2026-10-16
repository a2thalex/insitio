import { describe, it, expect, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { createRepo, getRepo, gitFor, star } from "../src/services/repos.js";
import { repoDir } from "../src/git/storage.js";
import { getUserByName, type User } from "../src/services/users.js";
import { testApp, type Who } from "./helpers.js";

let t: ReturnType<typeof testApp>;
let ada: User;
let adaWho: Who;

beforeEach(async () => {
  t = testApp();
  ada = t.user("ada");
  adaWho = t.loginAs(ada);
  await createRepo(t.deps, ada, { name: "hello", description: "Public one", isPrivate: false, initReadme: true });
  await createRepo(t.deps, ada, { name: "secret", description: "Hidden one", isPrivate: true, initReadme: true });
});

describe("profiles", () => {
  it("shows public repos to everyone and private repos only to those with access", async () => {
    const anon = await (await t.get("/ada?tab=repositories")).text();
    expect(anon).toContain("hello");
    expect(anon).not.toContain("secret");
    const own = await (await t.get("/ada?tab=repositories", adaWho)).text();
    expect(own).toContain("secret");
  });

  it("lists starred repositories", async () => {
    const bob = t.user("bob");
    star(t.deps.db, bob.id, getRepo(t.deps.db, "ada", "hello")!.id);
    const html = await (await t.get("/bob?tab=stars")).text();
    expect(html).toContain("ada/hello");
  });

  it("404s for unknown users", async () => {
    expect((await t.get("/nobody")).status).toBe(404);
  });
});

describe("repository settings", () => {
  it("is only available to repo admins", async () => {
    const bob = t.loginAs(t.user("bob"));
    expect((await t.get("/ada/hello/settings", bob)).status).toBe(403);
    expect((await t.get("/ada/secret/settings", bob)).status).toBe(404);
    expect((await t.get("/ada/hello/settings", adaWho)).status).toBe(200);
  });

  it("updates description, visibility and default branch", async () => {
    const repo = getRepo(t.deps.db, "ada", "hello")!;
    await gitFor(t.deps, repo).commitFiles("dev", { "dev.txt": "x\n" }, "Dev work", { name: "Ada", email: "ada@example.com" }, "main");
    await t.post("/ada/hello/settings", { description: "Now private", visibility: "private", default_branch: "dev" }, adaWho);
    const updated = getRepo(t.deps.db, "ada", "hello")!;
    expect(updated).toMatchObject({ description: "Now private", isPrivate: true, defaultBranch: "dev" });
    expect(await gitFor(t.deps, updated).defaultBranch()).toBe("dev");
    expect((await t.get("/ada/hello")).status).toBe(404);
    expect(await (await t.get("/ada/hello", adaWho)).text()).toContain("dev.txt");
  });

  it("adds and removes collaborators", async () => {
    t.user("bob");
    await t.post("/ada/secret/settings/collaborators", { username: "bob", role: "write", action: "add" }, adaWho);
    const bob = t.loginAs(getUserByName(t.deps.db, "bob")!);
    expect((await t.get("/ada/secret", bob)).status).toBe(200);
    expect((await t.post("/ada/secret/labels", { name: "triage", color: "#00ff00" }, bob)).status).toBe(302);
    const settings = await (await t.get("/ada/secret/settings", adaWho)).text();
    expect(settings).toContain("bob");
    await t.post("/ada/secret/settings/collaborators", { username: "bob", action: "remove" }, adaWho);
    expect((await t.get("/ada/secret", bob)).status).toBe(404);
  });

  it("reports unknown collaborators", async () => {
    const res = await t.post("/ada/hello/settings/collaborators", { username: "ghost", role: "read", action: "add" }, adaWho);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("No user named ghost");
  });

  it("deletes a repository only after typing its full name", async () => {
    const dir = repoDir(t.deps.config.dataDir, "ada", "hello");
    const wrong = await t.post("/ada/hello/settings/delete", { confirm: "hello" }, adaWho);
    expect(wrong.status).toBe(400);
    expect(existsSync(dir)).toBe(true);
    const ok = await t.post("/ada/hello/settings/delete", { confirm: "ada/hello" }, adaWho);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/ada");
    expect(existsSync(dir)).toBe(false);
    expect((await t.get("/ada/hello", adaWho)).status).toBe(404);
  });
});
