import { describe, it, expect, beforeEach } from "vitest";
import { createRepo, gitFor, type RepoRow } from "../src/services/repos.js";
import { getPull } from "../src/services/pulls.js";
import type { Repo } from "../src/git/repo.js";
import type { User } from "../src/services/users.js";
import { testApp, type Who } from "./helpers.js";

const author = { name: "Ada", email: "ada@example.com" };
let t: ReturnType<typeof testApp>;
let ada: User;
let adaWho: Who;
let repo: RepoRow;
let git: Repo;

beforeEach(async () => {
  t = testApp();
  ada = t.user("ada");
  adaWho = t.loginAs(ada);
  repo = await createRepo(t.deps, ada, { name: "hello", description: "", isPrivate: false, initReadme: true });
  git = gitFor(t.deps, repo);
  await git.commitFiles("feature", { "feature.txt": "new feature\n" }, "Add feature", author, "main");
});

describe("pull requests", () => {
  it("compares branches and offers to open a pull request", async () => {
    const html = await (await t.get("/ada/hello/compare/main...feature", adaWho)).text();
    expect(html).toContain("Add feature");
    expect(html).toContain("feature.txt");
    expect(html).toContain("Able to merge");
    expect(html).toContain("Create pull request");
  });

  it("opens, shows and merges a pull request", async () => {
    const res = await t.post("/ada/hello/pulls", { base: "main", head: "feature", title: "Add feature", body: "Please merge" }, adaWho);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ada/hello/pull/1");

    const page = await (await t.get("/ada/hello/pull/1", adaWho)).text();
    expect(page).toContain("State--open");
    expect(page).toContain("wants to merge 1 commit into");
    expect(page).toContain("Merge pull request");
    expect(page).toContain("Please merge");

    const files = await (await t.get("/ada/hello/pull/1/files")).text();
    expect(files).toContain("feature.txt");
    const commits = await (await t.get("/ada/hello/pull/1/commits")).text();
    expect(commits).toContain("Add feature");

    const before = await git.resolve("main");
    const merge = await t.post("/ada/hello/pull/1/merge", {}, adaWho);
    expect(merge.status).toBe(302);
    const after = (await git.resolve("main"))!;
    expect(after).not.toBe(before);
    const mergeCommit = await git.commit(after);
    expect(mergeCommit.subject).toBe("Merge pull request #1 from ada/feature");
    expect(mergeCommit.parents).toHaveLength(2);
    expect(getPull(t.deps.db, repo.id, 1)).toMatchObject({ state: "closed", mergedBy: "ada", mergeCommit: after });

    const merged = await (await t.get("/ada/hello/pull/1")).text();
    expect(merged).toContain("State--merged");
    expect(merged).toContain("merged 1 commit into");
    expect(merged).toContain("Pull request successfully merged and closed");
    // Commits and files still show after the merge.
    expect(await (await t.get("/ada/hello/pull/1/files")).text()).toContain("feature.txt");

    const closedList = await (await t.get("/ada/hello/pulls?state=closed")).text();
    expect(closedList).toContain("Add feature");
  });

  it("reports conflicts and refuses to merge them", async () => {
    await git.commitFiles("clash", { "README.md": "# clash version\n" }, "Clash edit", author, "main");
    await git.commitFiles("main", { "README.md": "# main version\n" }, "Main edit", author);
    await t.post("/ada/hello/pulls", { base: "main", head: "clash", title: "Clash", body: "" }, adaWho);
    const page = await (await t.get("/ada/hello/pull/1")).text();
    expect(page).toContain("This branch has conflicts that must be resolved");
    const res = await t.post("/ada/hello/pull/1/merge", {}, adaWho);
    expect(res.status).toBe(409);
  });

  it("only lets writers merge", async () => {
    await t.post("/ada/hello/pulls", { base: "main", head: "feature", title: "Add feature", body: "" }, adaWho);
    const bob = t.loginAs(t.user("bob"));
    const page = await (await t.get("/ada/hello/pull/1", bob)).text();
    expect(page).toContain("Only those with write access");
    expect((await t.post("/ada/hello/pull/1/merge", {}, bob)).status).toBe(403);
  });

  it("rejects pull requests between identical or unknown branches", async () => {
    expect((await t.post("/ada/hello/pulls", { base: "main", head: "main", title: "x", body: "" }, adaWho)).status).toBe(400);
    expect((await t.post("/ada/hello/pulls", { base: "main", head: "nope", title: "x", body: "" }, adaWho)).status).toBe(400);
  });

  it("closes and reopens without merging", async () => {
    await t.post("/ada/hello/pulls", { base: "main", head: "feature", title: "Add feature", body: "" }, adaWho);
    await t.post("/ada/hello/pull/1/comment", { body: "", action: "close" }, adaWho);
    expect(await (await t.get("/ada/hello/pull/1")).text()).toContain("State--closed");
    await t.post("/ada/hello/pull/1/comment", { body: "", action: "reopen" }, adaWho);
    expect(await (await t.get("/ada/hello/pull/1")).text()).toContain("State--open");
  });
});
