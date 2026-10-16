import { describe, it, expect, beforeEach } from "vitest";
import { addCollaborator, createRepo, getRepo, type RepoRow } from "../src/services/repos.js";
import { listLabels } from "../src/services/issues.js";
import { createPull } from "../src/services/pulls.js";
import type { User } from "../src/services/users.js";
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

describe("issues", () => {
  it("creates an issue, comments with Markdown, and closes it", async () => {
    const res = await t.post("/ada/hello/issues", { title: "It breaks", body: "Steps:\n\n1. **run** it" }, adaWho);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ada/hello/issues/1");

    const page = await (await t.get("/ada/hello/issues/1")).text();
    expect(page).toContain("It breaks");
    expect(page).toContain("<strong>run</strong>");
    expect(page).toContain("State--open");

    await t.post("/ada/hello/issues/1/comment", { body: "Fixed in `main`", action: "close" }, adaWho);
    const closed = await (await t.get("/ada/hello/issues/1")).text();
    expect(closed).toContain("<code>main</code>");
    expect(closed).toContain("State--closed");
    expect(closed).toContain("closed this");

    const openList = await (await t.get("/ada/hello/issues")).text();
    expect(openList).toContain("There aren&#39;t any open issues.");
    const closedList = await (await t.get("/ada/hello/issues?state=closed")).text();
    expect(closedList).toContain("It breaks");
  });

  it("rejects blank titles", async () => {
    const res = await t.post("/ada/hello/issues", { title: "  ", body: "" }, adaWho);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Title can&#39;t be blank");
  });

  it("filters by label and searches titles", async () => {
    await t.post("/ada/hello/issues", { title: "Crash on start", body: "" }, adaWho);
    await t.post("/ada/hello/issues", { title: "Add dark mode", body: "" }, adaWho);
    const bug = listLabels(t.deps.db, repo.id).find((l) => l.name === "bug")!;
    await t.post("/ada/hello/issues/1/labels", { label: [String(bug.id)] }, adaWho);
    const filtered = await (await t.get("/ada/hello/issues?label=bug")).text();
    expect(filtered).toContain("Crash on start");
    expect(filtered).not.toContain("Add dark mode");
    const searched = await (await t.get("/ada/hello/issues?q=dark")).text();
    expect(searched).toContain("Add dark mode");
    expect(searched).not.toContain("Crash on start");
  });

  it("lets signed-in users comment on public repos but not label or close others' issues", async () => {
    await t.post("/ada/hello/issues", { title: "Question", body: "" }, adaWho);
    const bob = t.loginAs(t.user("bob"));
    const comment = await t.post("/ada/hello/issues/1/comment", { body: "+1", action: "comment" }, bob);
    expect(comment.status).toBe(302);
    expect(await (await t.get("/ada/hello/issues/1")).text()).toContain("+1");
    expect((await t.post("/ada/hello/issues/1/labels", { label: "1" }, bob)).status).toBe(403);
    expect((await t.post("/ada/hello/issues/1/comment", { body: "", action: "close" }, bob)).status).toBe(403);
  });

  it("sends anonymous commenters to sign in", async () => {
    await t.post("/ada/hello/issues", { title: "Question", body: "" }, adaWho);
    const res = await t.post("/ada/hello/issues/1/comment", { body: "hi", action: "comment" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/login/);
  });

  it("redirects pull request numbers to the pull page", async () => {
    createPull(t.deps.db, repo.id, ada.id, { title: "PR", body: "", baseRef: "main", headRef: "feature" });
    const res = await t.get("/ada/hello/issues/1");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ada/hello/pull/1");
  });

  it("hides issues of private repos and lets read collaborators comment", async () => {
    await createRepo(t.deps, ada, { name: "secret", description: "", isPrivate: true, initReadme: false });
    await t.post("/ada/secret/issues", { title: "Hidden", body: "" }, adaWho);
    const bobUser = t.user("bob");
    const bob = t.loginAs(bobUser);
    expect((await t.get("/ada/secret/issues", bob)).status).toBe(404);
    const secret = getRepo(t.deps.db, "ada", "secret")!;
    addCollaborator(t.deps.db, secret.id, bobUser.id, "read");
    expect((await t.get("/ada/secret/issues/1", bob)).status).toBe(200);
    expect((await t.post("/ada/secret/issues/1/comment", { body: "seen", action: "comment" }, bob)).status).toBe(302);
  });
});

describe("labels", () => {
  it("lets writers create and delete labels", async () => {
    await t.post("/ada/hello/labels", { name: "needs-design", color: "#ff00aa" }, adaWho);
    const page = await (await t.get("/ada/hello/labels")).text();
    expect(page).toContain("needs-design");
    const label = listLabels(t.deps.db, repo.id).find((l) => l.name === "needs-design")!;
    await t.post(`/ada/hello/labels/${label.id}/delete`, {}, adaWho);
    expect(await (await t.get("/ada/hello/labels")).text()).not.toContain("needs-design");
    const bob = t.loginAs(t.user("bob"));
    expect((await t.post("/ada/hello/labels", { name: "x", color: "#000000" }, bob)).status).toBe(403);
  });
});
