import { beforeEach, describe, expect, it } from "vitest";
import { createIssue } from "../src/services/issues.js";
import { listNotifications } from "../src/services/notifications.js";
import { createOrg } from "../src/services/orgs.js";
import { createRepo } from "../src/services/repos.js";
import { authenticate, type User } from "../src/services/users.js";
import { testApp, type Who } from "./helpers.js";

let t: ReturnType<typeof testApp>;
let ada: User;
let adaWho: Who;

beforeEach(() => {
  t = testApp();
  ada = t.user("ada");
  adaWho = t.loginAs(ada);
});

describe("organizations", () => {
  it("lets an owner and a team reader see a private org repo, and hides it from everyone else", async () => {
    const org = createOrg(t.deps.db, ada, "acme", "Acme");
    const secret = await createRepo(t.deps, org, { name: "vault", description: "", isPrivate: true, initReadme: true });
    expect((await t.get("/acme/vault", adaWho)).status).toBe(200);
    expect((await t.get("/acme/vault")).status).toBe(404);

    const bob = t.user("bob");
    const bobWho = t.loginAs(bob);
    const cara = t.user("cara");
    const caraWho = t.loginAs(cara);
    expect((await t.get("/acme/vault", bobWho)).status).toBe(404);
    expect((await t.post("/orgs/acme/members", { username: "bob" }, caraWho)).status).toBe(403);

    expect((await t.post("/orgs/acme/members", { username: "bob" }, adaWho)).status).toBe(302);
    expect((await t.post("/orgs/acme/members", { username: "cara" }, adaWho)).status).toBe(302);
    expect((await t.get("/acme/vault", caraWho)).status).toBe(404);

    expect((await t.post("/orgs/acme/teams", { name: "Readers" }, adaWho)).status).toBe(302);
    expect((await t.post("/orgs/acme/teams/readers/members", { username: "bob" }, adaWho)).status).toBe(302);
    expect((await t.post("/orgs/acme/teams/readers/repos", { repo: String(secret.id), role: "read" }, adaWho)).status).toBe(302);
    expect((await t.get("/acme/vault", bobWho)).status).toBe(200);
    expect((await t.get("/acme/vault", caraWho)).status).toBe(404);

    const personal = await createRepo(t.deps, ada, { name: "personal", description: "", isPrivate: true, initReadme: true });
    expect((await t.post("/orgs/acme/teams/readers/repos", { repo: String(personal.id), role: "read" }, adaWho)).status).toBe(400);
    expect((await t.get("/ada/personal", bobWho)).status).toBe(404);

    t.deps.db.prepare("update users set password_hash = (select password_hash from users where id = ?) where id = ?").run(ada.id, org.id);
    expect(authenticate(t.deps.db, "acme", "longenough")).toBeNull();
    expect(await (await t.get("/acme")).text()).toContain("Organization");

    const created = await t.post("/new", { owner: "acme", name: "widget", description: "", visibility: "public", readme: "1" }, adaWho);
    expect(created.status).toBe(302);
    expect(created.headers.get("location")).toBe("/acme/widget");
    const stolen = await t.post("/new", { owner: "bob", name: "nope", description: "", visibility: "public" }, adaWho);
    expect(stolen.status).toBe(400);
  });
});

describe("notifications", () => {
  it("records a comment and an assignment, and drops them when the person ignores notices", async () => {
    const repo = await createRepo(t.deps, ada, { name: "hello", description: "", isPrivate: false, initReadme: true });
    const bob = t.user("bob");
    const bobWho = t.loginAs(bob);
    const issue = createIssue(t.deps.db, repo.id, ada.id, { title: "Bug", body: "" });
    expect((await t.post(`/ada/hello/issues/${issue.number}/comment`, { body: "seen it", action: "comment" }, bobWho)).status).toBe(302);
    expect((await t.post(`/ada/hello/issues/${issue.number}/assignees`, { assignees: "bob" }, adaWho)).status).toBe(302);

    const adaInbox = await (await t.get("/notifications", adaWho)).text();
    expect(adaInbox).toContain("bob commented on ada/hello#1");
    expect(adaInbox).toContain("1 unread notifications");
    const bobInbox = await (await t.get("/notifications", bobWho)).text();
    expect(bobInbox).toContain("You were assigned to ada/hello#1");
    expect(bobInbox).not.toContain("commented on");

    expect((await t.post("/notifications/read", {}, adaWho)).status).toBe(302);
    const read = await (await t.get("/notifications", adaWho)).text();
    expect(read).toContain("Notifications");
    expect(read).not.toContain("unread notifications");
    expect(listNotifications(t.deps.db, bob.id)).toHaveLength(1);

    t.deps.db.prepare("update users set notify = 'ignore' where id = ?").run(ada.id);
    expect((await t.post(`/ada/hello/issues/${issue.number}/comment`, { body: "again", action: "comment" }, bobWho)).status).toBe(302);
    expect(listNotifications(t.deps.db, ada.id).map((note) => note.title)).toEqual(["bob commented on ada/hello#1"]);
    expect((await t.get("/notifications")).status).toBe(302);
  });
});

describe("search", () => {
  it("finds people and public code, and hides a private issue and a private file", async () => {
    const secret = await createRepo(t.deps, ada, { name: "secret", description: "", isPrivate: true, initReadme: true });
    createIssue(t.deps.db, secret.id, ada.id, { title: "zephyr-secret-title", body: "hidden body" });
    await createRepo(t.deps, ada, { name: "codetoken77", description: "", isPrivate: false, initReadme: true });
    const bobWho = t.loginAs(t.user("bob"));

    const hidden = await (await t.get("/search?q=zephyr-secret-title&type=issues", bobWho)).text();
    expect(hidden).toContain("No issues found");
    expect(hidden).not.toContain("/ada/secret/issues/");
    const visible = await (await t.get("/search?q=zephyr-secret-title&type=issues", adaWho)).text();
    expect(visible).toContain("/ada/secret/issues/1");

    const people = await (await t.get("/search?q=ada&type=users")).text();
    expect(people).toContain('href="/ada"');
    createOrg(t.deps.db, ada, "acme");
    const orgs = await (await t.get("/search?q=acme&type=users")).text();
    expect(orgs).toContain('href="/acme"');
    expect(orgs).toContain("organization");
    expect(orgs).not.toContain('href="/orgs/acme"');

    const code = await (await t.get("/search?q=codetoken77&type=code")).text();
    expect(code).toContain("/ada/codetoken77/blob/README.md");
    const leaked = await (await t.get("/search?q=secret&type=code", bobWho)).text();
    expect(leaked).not.toContain("/ada/secret/blob/");
  });
});
