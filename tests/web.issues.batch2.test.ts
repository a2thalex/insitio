import { beforeEach, describe, expect, it } from "vitest";
import { applyClosingReferences, closingReferences, scanPushedCommits } from "../src/services/issueExtras.js";
import { createIssue, getIssue } from "../src/services/issues.js";
import { createPull } from "../src/services/pulls.js";
import { addCollaborator, createRepo, gitFor, type RepoRow } from "../src/services/repos.js";
import { createAccessToken, type User } from "../src/services/users.js";
import { testApp, type Who } from "./helpers.js";

let t: ReturnType<typeof testApp>;
let ada: User;
let adaWho: Who;
let repo: RepoRow;

beforeEach(async () => {
  t = testApp();
  ada = t.user("ada");
  adaWho = t.loginAs(ada);
  repo = await createRepo(t.deps, ada, { name: "hello", description: "", isPrivate: false, initReadme: true });
});

describe("closing references", () => {
  it("reads Fixes, Closes and Resolves on the same line, including another repo", () => {
    expect(closingReferences("Fixes #12\nsee #3\nCloses ada/other#4 and fixed #5")).toEqual([
      { owner: undefined, repo: undefined, number: 12 },
      { owner: "ada", repo: "other", number: 4 },
      { owner: undefined, repo: undefined, number: 5 },
    ]);
  });
});

describe("issue workflow", () => {
  it("assigns, milestones, reacts, locks, pins and edits comments", async () => {
    const bob = t.user("bob");
    const bobWho = t.loginAs(bob);
    const issue = createIssue(t.deps.db, repo.id, ada.id, { title: "Bug", body: "Broken" });
    const assigned = await t.post(`/ada/hello/issues/${issue.number}/assignees`, { assignees: "bob" }, adaWho);
    expect(assigned.status).toBe(302);
    expect(getIssue(t.deps.db, repo.id, issue.number)?.assignees.map((a) => a.username)).toEqual(["bob"]);
    const stranger = await t.post(`/ada/hello/issues/${issue.number}/assignees`, { assignees: "nobody" }, adaWho);
    expect(stranger.status).toBe(400);

    const milestone = await t.post("/ada/hello/milestones", { title: "v1", description: "First", due: "2026-12-01" }, adaWho);
    expect(milestone.status).toBe(302);
    await t.post(`/ada/hello/issues/${issue.number}/milestone`, { milestone: "1" }, adaWho);
    const filtered = await (await t.get("/ada/hello/issues?milestone=v1")).text();
    expect(filtered).toContain("Bug");

    await t.post(`/ada/hello/issues/${issue.number}/reactions`, { emoji: "+1" }, bobWho);
    await t.post(`/ada/hello/issues/${issue.number}/reactions`, { emoji: "+1" }, adaWho);
    const page = await (await t.get(`/ada/hello/issues/${issue.number}`, adaWho)).text();
    expect(page).toContain("👍 2");

    await t.post(`/ada/hello/issues/${issue.number}/comment`, { body: "A comment", action: "comment" }, bobWho);
    const commentId = t.deps.db.prepare("select id from comments where issue_id = ?").get(issue.id) as { id: number };
    const edited = await t.post(`/ada/hello/issues/${issue.number}/comments/${commentId.id}`, { action: "edit", body: "Edited comment" }, bobWho);
    expect(edited.status).toBe(302);
    const shown = await (await t.get(`/ada/hello/issues/${issue.number}`, adaWho)).text();
    expect(shown).toContain("Edited comment");
    expect(shown).toContain('aria-pressed="true"');
    const cara = t.user("cara");
    expect((await t.post(`/ada/hello/issues/${issue.number}/comments/${commentId.id}`, { action: "delete", body: "" }, t.loginAs(cara))).status).toBe(403);

    await t.post(`/ada/hello/issues/${issue.number}/lock`, {}, adaWho);
    const locked = await t.post(`/ada/hello/issues/${issue.number}/comment`, { body: "nope", action: "comment" }, bobWho);
    expect(locked.status).toBe(403);
    expect(await locked.text()).toContain("locked");

    await t.post(`/ada/hello/issues/${issue.number}/pin`, {}, adaWho);
    expect(await (await t.get("/ada/hello/issues")).text()).toContain("Pinned");
    await t.post(`/ada/hello/issues/${issue.number}/comment`, { body: "", action: "close", reason: "not_planned" }, adaWho);
    const closed = await (await t.get(`/ada/hello/issues/${issue.number}`)).text();
    expect(closed).toContain("Not planned");
    expect(await (await t.get("/ada/hello/issues?state=closed&reason=not_planned")).text()).toContain("Bug");
  });

  it("offers a template and closes an issue when a pull request says Fixes", async () => {
    await t.post("/ada/hello/issues/templates", { name: "Bug report", about: "Something broke", title: "Bug: ", body: "Steps" }, adaWho);
    const chooser = await (await t.get("/ada/hello/issues/new", adaWho)).text();
    expect(chooser).toContain("Bug report");
    const form = await (await t.get("/ada/hello/issues/new?template=1", adaWho)).text();
    expect(form).toContain('value="Bug:"');
    expect(form).toContain("Steps");

    const issue = createIssue(t.deps.db, repo.id, ada.id, { title: "Leak", body: "" });
    await gitFor(t.deps, repo).commitFiles("main", { "a.txt": "1\n" }, "base", { name: "Ada", email: "ada@example.com" });
    await gitFor(t.deps, repo).createBranch("feature", "main");
    await gitFor(t.deps, repo).commitFiles("feature", { "a.txt": "2\n" }, "fix", { name: "Ada", email: "ada@example.com" });
    createPull(t.deps.db, repo.id, ada.id, { title: "Fix the leak", body: `Fixes #${issue.number}`, baseRef: "main", headRef: "feature" });
    const merged = await t.post(`/ada/hello/pull/${issue.number + 1}/merge`, {}, adaWho);
    expect(merged.status).toBe(302);
    expect(getIssue(t.deps.db, repo.id, issue.number)?.state).toBe("closed");
    expect(getIssue(t.deps.db, repo.id, issue.number)?.closeReason).toBe("completed");
    const closedPage = await (await t.get(`/ada/hello/issues/${issue.number}`)).text();
    expect(closedPage).toContain("Closed by");
    expect(closedPage).toContain("Completed");
    const mentioned = await t.post("/ada/hello/issues", { title: "Other", body: `See #${issue.number}` }, adaWho);
    expect(mentioned.status).toBe(302);
    expect(await (await t.get(`/ada/hello/issues/${issue.number}`)).text()).toContain("mentioned this in");
  });

  it("filters unassigned and unmilestoned issues, and enforces the caps", async () => {
    const assigned = createIssue(t.deps.db, repo.id, ada.id, { title: "Has owner", body: "" });
    createIssue(t.deps.db, repo.id, ada.id, { title: "Lonely bug", body: "" });
    await t.post(`/ada/hello/issues/${assigned.number}/assignees`, { assignees: "ada" }, adaWho);
    await t.post("/ada/hello/milestones", { title: "v1", description: "", due: "" }, adaWho);
    await t.post(`/ada/hello/issues/${assigned.number}/milestone`, { milestone: "1" }, adaWho);
    const noAssignee = await (await t.get("/ada/hello/issues?no:assignee")).text();
    expect(noAssignee).toContain("Lonely bug");
    expect(noAssignee).not.toContain("Has owner");
    const noMilestone = await (await t.get("/ada/hello/issues?no:milestone")).text();
    expect(noMilestone).toContain("Lonely bug");
    expect(noMilestone).not.toContain("Has owner");

    const names = Array.from({ length: 11 }, (_, i) => t.user(`u${i}`).username);
    expect((await t.post(`/ada/hello/issues/${assigned.number}/assignees`, { assignees: names.join(" ") }, adaWho)).status).toBe(400);
    expect((await t.post(`/ada/hello/issues/${assigned.number}/assignees`, { assignees: names.slice(0, 10).join(" ") }, adaWho)).status).toBe(302);

    for (let n = 0; n < 3; n++) {
      const extra = createIssue(t.deps.db, repo.id, ada.id, { title: `Pin ${n}`, body: "" });
      expect((await t.post(`/ada/hello/issues/${extra.number}/pin`, {}, adaWho)).status).toBe(302);
    }
    const fourth = createIssue(t.deps.db, repo.id, ada.id, { title: "Pin overflow", body: "" });
    const overflow = await t.post(`/ada/hello/issues/${fourth.number}/pin`, {}, adaWho);
    expect(overflow.status).toBe(400);
    expect(await overflow.text()).toContain("3");

    for (let n = 0; n < 10; n++) {
      expect((await t.post("/ada/hello/issues/templates", { name: `T${n}`, about: "", title: "", body: "" }, adaWho)).status).toBe(302);
    }
    const tooMany = await t.post("/ada/hello/issues/templates", { name: "T10", about: "", title: "", body: "" }, adaWho);
    expect(tooMany.status).toBe(400);
    expect(await tooMany.text()).toContain("10");
  });

  it("does not assign someone who cannot read a private repository", async () => {
    const priv = await createRepo(t.deps, ada, { name: "priv", description: "", isPrivate: true, initReadme: false });
    const bob = t.user("bob");
    const issue = createIssue(t.deps.db, priv.id, ada.id, { title: "Secret", body: "" });
    const denied = await t.post(`/ada/priv/issues/${issue.number}/assignees`, { assignees: bob.username }, adaWho);
    expect(denied.status).toBe(400);
    expect(getIssue(t.deps.db, priv.id, issue.number)?.assignees).toEqual([]);
    expect((await t.get(`/ada/priv/issues/${issue.number}`)).status).toBe(404);
  });

  it("closes an issue from a default-branch push and leaves a branch the actor cannot write", async () => {
    const issue = createIssue(t.deps.db, repo.id, ada.id, { title: "Push me", body: "" });
    const git = gitFor(t.deps, repo);
    const before = await git.resolve("main");
    await git.commitFiles("main", { "b.txt": "x\n" }, `Fixes #${issue.number}\n\nSee #${issue.number}`, { name: "Ada", email: "ada@example.com" });
    await scanPushedCommits(t.deps, repo, ada, git, before);
    expect(getIssue(t.deps.db, repo.id, issue.number)?.state).toBe("closed");
    expect(await (await t.get(`/ada/hello/issues/${issue.number}`)).text()).toContain("mentioned this in");

    const other = createIssue(t.deps.db, repo.id, ada.id, { title: "Stay open", body: "" });
    const sideBefore = await git.resolve("main");
    await git.createBranch("side", "main");
    await git.commitFiles("side", { "c.txt": "y\n" }, `Fixes #${other.number}`, { name: "Ada", email: "ada@example.com" });
    await scanPushedCommits(t.deps, repo, ada, git, sideBefore);
    expect(getIssue(t.deps.db, repo.id, other.number)?.state).toBe("open");

    const bob = t.user("bob");
    const secret = await createRepo(t.deps, bob, { name: "secret", description: "", isPrivate: true, initReadme: false });
    const hidden = createIssue(t.deps.db, secret.id, bob.id, { title: "Hidden", body: "" });
    applyClosingReferences(t.deps.db, ada, repo, `Fixes bob/secret#${hidden.number}`, "abc1234");
    expect(getIssue(t.deps.db, secret.id, hidden.number)?.state).toBe("open");
    addCollaborator(t.deps.db, secret.id, ada.id, "write");
    applyClosingReferences(t.deps.db, ada, repo, `Fixes bob/secret#${hidden.number}`, "abc1234");
    expect(getIssue(t.deps.db, secret.id, hidden.number)?.state).toBe("closed");
    expect(getIssue(t.deps.db, secret.id, hidden.number)?.closeReason).toBe("completed");
  });

  it("reads and updates assignees through the API", async () => {
    const token = createAccessToken(t.deps.db, ada.id, "cli");
    const bob = t.user("bob");
    const call = (path: string, method = "GET", body?: unknown) =>
      t.app.request(path, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const rejected = await call("/api/v1/repos/ada/hello/issues", "POST", { title: "Nope", assignees: ["nobody"] });
    expect(rejected.status).toBe(422);
    expect((await call("/api/v1/repos/ada/hello/issues/1")).status).toBe(404);
    const created = await call("/api/v1/repos/ada/hello/issues", "POST", { title: "API bug", body: "See later", assignees: [bob.username] });
    expect(created.status).toBe(201);
    const made = await created.json();
    expect(made.assignees).toEqual([bob.username]);
    const got = await call(`/api/v1/repos/ada/hello/issues/${made.number}`);
    expect((await got.json()).title).toBe("API bug");
    const patched = await call(`/api/v1/repos/ada/hello/issues/${made.number}`, "PATCH", { assignees: [], state: "closed", state_reason: "not_planned" });
    expect(patched.status).toBe(200);
    const after = await patched.json();
    expect(after.assignees).toEqual([]);
    expect(after.state).toBe("closed");
    expect(after.state_reason).toBe("not_planned");
    const stranger = createAccessToken(t.deps.db, bob.id, "cli");
    const hidden = await createRepo(t.deps, ada, { name: "hidden", description: "", isPrivate: true, initReadme: false });
    createIssue(t.deps.db, hidden.id, ada.id, { title: "Nope", body: "" });
    const missing = await t.app.request("/api/v1/repos/ada/hidden/issues/1", { headers: { authorization: `Bearer ${stranger}` } });
    expect(missing.status).toBe(404);
  });
});
