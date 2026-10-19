import { beforeEach, describe, expect, it } from "vitest";
import { createIssue } from "../src/services/issues.js";
import { addLineComment } from "../src/services/pullExtras.js";
import { createPull } from "../src/services/pulls.js";
import { authorFor, createRepo, gitFor } from "../src/services/repos.js";
import type { User } from "../src/services/users.js";
import { testApp, type Who } from "./helpers.js";

let t: ReturnType<typeof testApp>;
let ada: User;
let adaWho: Who;

beforeEach(() => {
  t = testApp();
  ada = t.user("ada");
  adaWho = t.loginAs(ada);
});

describe("sub-issues and gists", () => {
  it("attaches a sub-issue and refuses a cycle", async () => {
    const repo = await createRepo(t.deps, ada, { name: "hello", description: "", isPrivate: false, initReadme: true });
    const parent = createIssue(t.deps.db, repo.id, ada.id, { title: "Parent", body: "" });
    const child = createIssue(t.deps.db, repo.id, ada.id, { title: "Child task", body: "" });
    expect((await t.post(`/ada/hello/issues/${parent.number}/subissue`, { number: String(child.number) }, adaWho)).status).toBe(302);
    expect(await (await t.get(`/ada/hello/issues/${parent.number}`, adaWho)).text()).toContain("Child task");
    expect((await t.post(`/ada/hello/issues/${child.number}/subissue`, { number: String(parent.number) }, adaWho)).status).toBe(400);
  });

  it("hides a secret gist and rejects a file name that is a path", async () => {
    expect((await t.post("/gists", { description: "Quiet", filename: "note.txt", body: "secret words", secret: "1" }, adaWho)).status).toBe(302);
    const id = (t.deps.db.prepare("select id from gists").get() as { id: string }).id;
    expect((await t.get(`/gists/${id}`)).status).toBe(404);
    expect(await (await t.get("/gists")).text()).not.toContain("secret words");
    expect(await (await t.get(`/gists/${id}`, adaWho)).text()).toContain("secret words");
    expect((await t.post("/gists", { description: "Bad", filename: "../x", body: "nope" }, adaWho)).status).toBe(400);

    expect((await t.post("/gists", { description: "Public note", filename: "hello.txt", body: "visible" }, adaWho)).status).toBe(302);
    expect(await (await t.get("/gists")).text()).toContain("Public note");
  });
});

describe("apply suggestion", () => {
  it("replaces the commented line and refuses once the line has moved", async () => {
    const repo = await createRepo(t.deps, ada, { name: "hello", description: "", isPrivate: false, initReadme: true });
    const git = gitFor(t.deps, repo);
    await git.commitFiles("feature", { "note.txt": "old\n" }, "note", authorFor(ada), "main");
    const pull = createPull(t.deps.db, repo.id, ada.id, { title: "Note", body: "", baseRef: "main", headRef: "feature" });
    addLineComment(t.deps.db, pull.id, ada.id, {
      path: "note.txt",
      side: "right",
      line: 1,
      body: "```suggestion\nnew\n```",
      commitSha: (await git.resolve("feature"))!,
      lineText: "old",
    });
    const comment = t.deps.db.prepare("select id from pull_line_comments").get() as { id: number };
    expect((await t.post(`/ada/hello/pull/${pull.number}/line-comments/${comment.id}/apply`, {}, adaWho)).status).toBe(302);
    const blob = await git.blob("feature", "note.txt", 1000);
    expect(blob.content.toString("utf8")).toBe("new\n");

    addLineComment(t.deps.db, pull.id, ada.id, {
      path: "note.txt",
      side: "right",
      line: 1,
      body: "```suggestion\nlater\n```",
      commitSha: (await git.resolve("feature"))!,
      lineText: "old",
    });
    const stale = t.deps.db.prepare("select id from pull_line_comments order by id desc").get() as { id: number };
    expect((await t.post(`/ada/hello/pull/${pull.number}/line-comments/${stale.id}/apply`, {}, adaWho)).status).toBe(400);
    expect((await git.blob("feature", "note.txt", 1000)).content.toString("utf8")).toBe("new\n");
  });
});
