import { beforeEach, describe, expect, it } from "vitest";
import { RefMovedError } from "../src/git/repo.js";
import { createPull, getPull } from "../src/services/pulls.js";
import { createRepo, gitFor, type RepoRow } from "../src/services/repos.js";
import { createAccessToken, type User } from "../src/services/users.js";
import type { Repo } from "../src/git/repo.js";
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

describe("pull request workflow", () => {
  it("keeps a draft from merging until it is ready", async () => {
    const opened = await t.post("/ada/hello/pulls", { base: "main", head: "feature", title: "Add feature", body: "Soon", draft: "1" }, adaWho);
    expect(opened.status).toBe(302);
    const page = await (await t.get("/ada/hello/pull/1", adaWho)).text();
    expect(page).toContain("Draft");
    expect(await (await t.get("/ada/hello/pulls")).text()).toContain("Draft");
    expect((await t.post("/ada/hello/pull/1/merge", {}, adaWho)).status).toBe(409);
    expect((await t.post("/ada/hello/pull/1/draft", {}, adaWho)).status).toBe(302);
    expect((await t.post("/ada/hello/pull/1/merge", {}, adaWho)).status).toBe(302);
    expect(getPull(t.deps.db, repo.id, 1)?.mergedAt).toBeTruthy();
  });

  it("asks readers to review and records an approval from a writer", async () => {
    createPull(t.deps.db, repo.id, ada.id, { title: "Add feature", body: "", baseRef: "main", headRef: "feature" });
    const bob = t.user("bob");
    const bobWho = t.loginAs(bob);
    expect((await t.post("/ada/hello/pull/1/reviewers", { reviewers: "bob" }, adaWho)).status).toBe(302);
    expect((await t.post("/ada/hello/pull/1/reviewers", { reviewers: "nobody" }, adaWho)).status).toBe(400);
    expect((await t.post("/ada/hello/pull/1/reviewers", { reviewers: "ada Ada" }, adaWho)).status).toBe(302);
    const reviewerCount = t.deps.db.prepare(
      "select count(*) as n from pull_reviewers r join issues i on i.id = r.issue_id where i.repo_id = ? and i.number = 1",
    ).get(repo.id) as { n: number };
    expect(reviewerCount.n).toBe(1);
    const names = Array.from({ length: 11 }, (_, i) => t.user(`u${i}`).username);
    expect((await t.post("/ada/hello/pull/1/reviewers", { reviewers: names.join(" ") }, adaWho)).status).toBe(400);

    expect((await t.post("/ada/hello/pull/1/reviews", { state: "comment", body: "Looks fine" }, bobWho)).status).toBe(302);
    expect((await t.post("/ada/hello/pull/1/reviews", { state: "approve", body: "" }, bobWho)).status).toBe(403);
    expect((await t.post("/ada/hello/pull/1/reviews", { state: "approve", body: "Ship it" }, adaWho)).status).toBe(302);
    const page = await (await t.get("/ada/hello/pull/1")).text();
    expect(page).toContain("approved these changes");
    expect(page).toContain("bob");

    const priv = await createRepo(t.deps, ada, { name: "priv", description: "", isPrivate: true, initReadme: true });
    await gitFor(t.deps, priv).commitFiles("feature", { "a.txt": "a\n" }, "a", author, "main");
    createPull(t.deps.db, priv.id, ada.id, { title: "Secret", body: "", baseRef: "main", headRef: "feature" });
    expect((await t.post("/ada/priv/pull/1/reviewers", { reviewers: "bob" }, adaWho)).status).toBe(400);
  });

  it("comments on a diff line and shows a suggestion", async () => {
    createPull(t.deps.db, repo.id, ada.id, { title: "Add feature", body: "", baseRef: "main", headRef: "feature" });
    const comment = await t.post("/ada/hello/pull/1/line-comments", {
      path: "feature.txt",
      side: "right",
      line: "1",
      body: "Try this\n\n```suggestion\nbetter feature\n```",
    }, adaWho);
    expect(comment.status).toBe(302);
    const files = await (await t.get("/ada/hello/pull/1/files", adaWho)).text();
    expect(files).toContain("Suggested change");
    expect(files).toContain("better feature");
    const id = (t.deps.db.prepare("select id from pull_line_comments").get() as { id: number }).id;
    const cara = t.user("cara");
    expect((await t.post(`/ada/hello/pull/1/line-comments/${id}`, { action: "delete", body: "" }, t.loginAs(cara))).status).toBe(403);
    expect((await t.post("/ada/hello/pull/1/line-comments", { path: "../secret", side: "right", line: "1", body: "nope" }, adaWho)).status).toBe(400);
  });

  it("squashes, rebases, deletes the head branch, and refuses a conflicting rebase", async () => {
    createPull(t.deps.db, repo.id, ada.id, { title: "Add feature", body: "Squashed body", baseRef: "main", headRef: "feature" });
    const before = await git.resolve("main");
    expect((await t.post("/ada/hello/pull/1/merge", { method: "squash" }, adaWho)).status).toBe(302);
    const after = (await git.resolve("main"))!;
    expect(after).not.toBe(before);
    const commit = await git.commit(after);
    expect(commit.parents).toEqual([before]);
    expect(commit.subject).toBe("Add feature");
    expect(commit.body).toContain("Squashed body");
    expect(await (await t.get("/ada/hello/pull/1/files")).text()).toContain("feature.txt");

    await git.commitFiles("ahead", { "ahead.txt": "ahead\n" }, "Ahead", author, "main");
    createPull(t.deps.db, repo.id, ada.id, { title: "Ahead", body: "", baseRef: "main", headRef: "ahead" });
    const head = await git.resolve("ahead");
    expect((await t.post("/ada/hello/pull/2/merge", { method: "rebase", delete_branch: "1" }, adaWho)).status).toBe(302);
    expect(await git.resolve("main")).toBe(head);
    expect(await git.resolve("ahead")).toBeNull();
    expect(await git.resolve("main")).toBeTruthy();

    await git.commitFiles("clash", { "README.md": "# clash\n" }, "Clash", author, "main");
    await git.commitFiles("main", { "README.md": "# main\n" }, "Main", author);
    const stable = await git.resolve("main");
    createPull(t.deps.db, repo.id, ada.id, { title: "Clash", body: "", baseRef: "main", headRef: "clash" });
    expect((await t.post("/ada/hello/pull/3/merge", { method: "rebase" }, adaWho)).status).toBe(409);
    expect(await git.resolve("main")).toBe(stable);
  });

  it("updates a branch that is behind and fills a template", async () => {
    createPull(t.deps.db, repo.id, ada.id, { title: "Add feature", body: "", baseRef: "main", headRef: "feature" });
    await git.commitFiles("main", { "later.txt": "later\n" }, "Later", author);
    expect(await (await t.get("/ada/hello/pull/1", adaWho)).text()).toContain("Update branch");
    expect((await t.post("/ada/hello/pull/1/update", {}, adaWho)).status).toBe(302);
    const tip = await git.commit((await git.resolve("feature"))!);
    expect(tip.parents).toHaveLength(2);

    await git.commitFiles("docs", { "docs.txt": "docs\n" }, "Docs", author, "main");
    expect((await t.post("/ada/hello/pulls/templates", { name: "Fix", about: "A fix", title: "Fix: ", body: "What broke" }, adaWho)).status).toBe(302);
    const chooser = await (await t.get("/ada/hello/compare/main...docs", adaWho)).text();
    expect(chooser).toContain("Fix");
    const form = await (await t.get("/ada/hello/compare/main...docs?template=1", adaWho)).text();
    expect(form).toContain('value="Fix:"');
    expect(form).toContain("What broke");
    expect((await t.post("/ada/hello/pulls/templates", { name: "Fix", about: "", title: "", body: "" }, adaWho)).status).toBe(400);
  });

  it("moves a stale line comment out of the diff and will not rebase a merge commit", async () => {
    createPull(t.deps.db, repo.id, ada.id, { title: "Add feature", body: "", baseRef: "main", headRef: "feature" });
    expect((await t.post("/ada/hello/pull/1/line-comments", { path: "feature.txt", side: "right", line: "1", body: "original note" }, adaWho)).status).toBe(302);
    await git.commitFiles("feature", { "feature.txt": "inserted\nnew feature\n" }, "Insert a line", author);
    const files = await (await t.get("/ada/hello/pull/1/files", adaWho)).text();
    expect(files).toContain("Outdated");
    expect(files.split("original note").length - 1).toBe(1);

    await git.commitFiles("main", { "later.txt": "later\n" }, "Later", author);
    expect((await t.post("/ada/hello/pull/1/update", {}, adaWho)).status).toBe(302);
    await git.commitFiles("main", { "again.txt": "again\n" }, "Again", author);
    const base = await git.resolve("main");
    const refused = await t.post("/ada/hello/pull/1/merge", { method: "rebase" }, adaWho);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("merge commit");
    expect(await git.resolve("main")).toBe(base);
  });

  it("refuses to merge a head other than the one whose checks were read", async () => {
    const base = (await git.resolve("main"))!;
    await expect(git.merge("main", "feature", "nope", author, { base, head: "b".repeat(40) })).rejects.toBeInstanceOf(RefMovedError);
    expect(await git.resolve("main")).toBe(base);
  });

  it("refuses to merge until required checks succeed, and hides a private repository", async () => {
    createPull(t.deps.db, repo.id, ada.id, { title: "Add feature", body: "", baseRef: "main", headRef: "feature" });
    expect((await t.post("/ada/hello/settings/checks", { contexts: "ci" }, adaWho)).status).toBe(302);
    const blocked = await t.post("/ada/hello/pull/1/merge", {}, adaWho);
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain("ci");

    const sha = (await git.resolve("feature"))!;
    const token = createAccessToken(t.deps.db, ada.id, "cli");
    const posted = await t.app.request(`/api/v1/repos/ada/hello/statuses/${sha}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ context: "ci", state: "success", description: "ok" }),
    });
    expect(posted.status).toBe(200);
    expect(await (await t.get("/ada/hello/pull/1", adaWho)).text()).toContain("ci: success");
    expect((await t.post("/ada/hello/pull/1/merge", {}, adaWho)).status).toBe(302);

    const bobToken = createAccessToken(t.deps.db, t.user("bob").id, "cli");
    const hidden = await createRepo(t.deps, ada, { name: "hidden", description: "", isPrivate: true, initReadme: true });
    const hiddenSha = (await gitFor(t.deps, hidden).resolve("main"))!;
    const missing = await t.app.request(`/api/v1/repos/ada/hidden/statuses/${hiddenSha}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bobToken}`, "content-type": "application/json" },
      body: JSON.stringify({ context: "ci", state: "success" }),
    });
    expect(missing.status).toBe(404);
  });
});
