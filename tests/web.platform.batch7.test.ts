import { beforeEach, describe, expect, it } from "vitest";
import { listNotifications } from "../src/services/notifications.js";
import { authorFor, createRepo, gitFor } from "../src/services/repos.js";
import { createAccessToken, type User } from "../src/services/users.js";
import { testApp, type Who } from "./helpers.js";

let t: ReturnType<typeof testApp>;
let ada: User;
let adaWho: Who;

beforeEach(() => {
  t = testApp();
  ada = t.user("ada");
  adaWho = t.loginAs(ada);
});

describe("repository tabs", () => {
  it("hides a private repository and rejects a wiki slug that is not a page name", async () => {
    const secret = await createRepo(t.deps, ada, { name: "secret", description: "", isPrivate: true, initReadme: true });
    expect(secret.id).toBeGreaterThan(0);
    const bob = t.loginAs(t.user("bob"));
    expect((await t.get("/ada/secret/wiki", bob)).status).toBe(404);
    expect((await t.get("/ada/secret/actions")).status).toBe(404);
    expect((await t.get("/ada/secret/wiki", adaWho)).status).toBe(200);

    const hello = await createRepo(t.deps, ada, { name: "hello", description: "", isPrivate: false, initReadme: true });
    expect(hello.owner).toBe("ada");
    expect((await t.post("/ada/hello/wiki/bad_slug", { title: "Nope", body: "x" }, adaWho)).status).toBe(400);
    expect((await t.post("/ada/hello/wiki/notes", { title: "Notes", body: "Hello **there**" }, adaWho)).status).toBe(302);
    const page = await (await t.get("/ada/hello/wiki/notes")).text();
    expect(page).toContain("there");
    expect(page).not.toContain("**there**");
  });

  it("notifies the discussion author and skips people who ignore notices", async () => {
    await createRepo(t.deps, ada, { name: "hello", description: "", isPrivate: false, initReadme: true });
    const bob = t.user("bob");
    const bobWho = t.loginAs(bob);
    expect((await t.post("/ada/hello/discussions", { category: "ideas", title: "A thought", body: "Maybe" }, adaWho)).status).toBe(302);
    expect((await t.post("/ada/hello/discussions/1/comment", { body: "I agree" }, bobWho)).status).toBe(302);
    expect(listNotifications(t.deps.db, ada.id).map((note) => note.title)).toEqual(["bob commented on ada/hello discussion #1"]);
    t.deps.db.prepare("update users set notify = 'ignore' where id = ?").run(ada.id);
    expect((await t.post("/ada/hello/discussions/1/comment", { body: "Again" }, bobWho)).status).toBe(302);
    expect(listNotifications(t.deps.db, ada.id)).toHaveLength(1);
  });

  it("scans for a private key without printing it, and keeps a draft advisory private", async () => {
    const repo = await createRepo(t.deps, ada, { name: "hello", description: "", isPrivate: false, initReadme: true });
    await gitFor(t.deps, repo).commitFiles("main", { "keys/demo.txt": "-----BEGIN PRIVATE KEY-----\nSECRETMATERIAL\n" }, "add a key", authorFor(ada));
    expect((await t.post("/ada/hello/security/scan", {}, adaWho)).status).toBe(302);
    const scanned = await (await t.get("/ada/hello/security?scan=1", adaWho)).text();
    expect(scanned).toContain("keys/demo.txt");
    expect(scanned).toContain("Private key");
    expect(scanned).not.toContain("SECRETMATERIAL");
    const bob = t.loginAs(t.user("bob"));
    expect(await (await t.get("/ada/hello/security?scan=1", bob)).text()).not.toContain("keys/demo.txt");

    expect((await t.post("/ada/hello/security/advisories", { title: "Draft hole", severity: "high", summary: "Not ready" }, adaWho)).status).toBe(302);
    expect(await (await t.get("/ada/hello/security", bob)).text()).not.toContain("Draft hole");
    expect(await (await t.get("/ada/hello/security", adaWho)).text()).toContain("Draft hole");
    expect((await t.post("/ada/hello/security/advisories", { title: "Public hole", severity: "low", summary: "Patched", published: "1" }, adaWho)).status).toBe(302);
    expect(await (await t.get("/ada/hello/security", bob)).text()).toContain("Public hole");
  });

  it("lists a workflow file and records a run without executing it", async () => {
    const repo = await createRepo(t.deps, ada, { name: "hello", description: "", isPrivate: false, initReadme: true });
    const sha = await gitFor(t.deps, repo).commitFiles("main", { ".github/workflows/ci.yml": "name: CI\n" }, "add workflow", authorFor(ada));
    const html = await (await t.get("/ada/hello/actions")).text();
    expect(html).toContain("ci.yml");
    expect(html).toContain("does not run them");
    expect((await t.post("/ada/hello/actions/runs", { name: "CI", head_sha: sha, status: "completed", conclusion: "success" }, adaWho)).status).toBe(302);
    expect(await (await t.get("/ada/hello/actions")).text()).toContain("success");

    const token = createAccessToken(t.deps.db, ada.id, "ci");
    const api = await t.app.request("/api/v1/repos/ada/hello/actions/runs", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "API", head_sha: sha, status: "completed", conclusion: "failure" }),
    });
    expect(api.status).toBe(201);
    expect(await (await t.get("/ada/hello/actions")).text()).toContain("API");
  });

  it("moves a project card and shows a contributor", async () => {
    const repo = await createRepo(t.deps, ada, { name: "hello", description: "", isPrivate: false, initReadme: true });
    expect((await t.post("/ada/hello/projects", { name: "Board" }, adaWho)).status).toBe(302);
    const board = await (await t.get("/ada/hello/projects/1", adaWho)).text();
    expect(board).toContain("To do");
    const column = t.deps.db.prepare("select id from project_columns where name = 'To do'").get() as { id: number };
    const done = t.deps.db.prepare("select id from project_columns where name = 'Done'").get() as { id: number };
    expect((await t.post(`/ada/hello/projects/1/columns/${column.id}/cards`, { title: "Write tests", issue: "" }, adaWho)).status).toBe(302);
    const card = t.deps.db.prepare("select id from project_cards").get() as { id: number };
    expect((await t.post(`/ada/hello/projects/1/cards/${card.id}`, { column: String(done.id) }, adaWho)).status).toBe(302);
    expect((t.deps.db.prepare("select column_id from project_cards where id = ?").get(card.id) as { column_id: number }).column_id).toBe(done.id);

    const insights = await (await t.get("/ada/hello/insights")).text();
    expect(insights).toContain("Page views are not recorded.");
    expect(insights).toContain(authorFor(ada).name);
    expect(repo.stars).toBe(0);
  });
});
