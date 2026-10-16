import { describe, it, expect, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import type { Deps } from "../src/deps.js";
import { createUser, type User } from "../src/services/users.js";
import {
  addCollaborator, createRepo, deleteRepo, getRepo, gitFor, isStarred, listReposForOwner, listStarred, star, unstar,
} from "../src/services/repos.js";
import { accessLevel } from "../src/services/permissions.js";
import {
  addComment, countIssues, createIssue, createLabel, getIssue, listComments, listEvents, listIssues, listLabels,
  setIssueLabels, setIssueState,
} from "../src/services/issues.js";
import { createPull, getPull, listPulls, markMerged } from "../src/services/pulls.js";
import { ValidationError } from "../src/services/errors.js";
import { repoDir } from "../src/git/storage.js";
import { testDeps } from "./helpers.js";

let deps: Deps;
let ada: User;
let bob: User;
let root: User;

beforeEach(() => {
  deps = testDeps();
  ada = createUser(deps.db, { username: "ada", password: "longenough", email: "ada@example.com" });
  bob = createUser(deps.db, { username: "bob", password: "longenough", email: "bob@example.com" });
  root = createUser(deps.db, { username: "root", password: "longenough", email: "", isAdmin: true });
});

describe("repos", () => {
  it("creates a repo with a README commit and default labels", async () => {
    const repo = await createRepo(deps, ada, { name: "hello", description: "Hi there", isPrivate: false, initReadme: true });
    expect(repo).toMatchObject({ owner: "ada", name: "hello", defaultBranch: "main", isPrivate: false, stars: 0 });
    const git = gitFor(deps, repo);
    expect((await git.tree("main", "")).map((e) => e.name)).toEqual(["README.md"]);
    expect(listLabels(deps.db, repo.id).map((l) => l.name)).toContain("bug");
    expect(getRepo(deps.db, "ADA", "Hello")?.id).toBe(repo.id);
  });

  it("validates names and rejects duplicates", async () => {
    await expect(createRepo(deps, ada, { name: "bad name", description: "", isPrivate: false, initReadme: false })).rejects.toBeInstanceOf(ValidationError);
    await expect(createRepo(deps, ada, { name: "x.git", description: "", isPrivate: false, initReadme: false })).rejects.toBeInstanceOf(ValidationError);
    await createRepo(deps, ada, { name: "dup", description: "", isPrivate: false, initReadme: false });
    await expect(createRepo(deps, ada, { name: "DUP", description: "", isPrivate: false, initReadme: false })).rejects.toThrow(/already exists/);
  });

  it("deletes the database row and the bare repo", async () => {
    const repo = await createRepo(deps, ada, { name: "gone", description: "", isPrivate: false, initReadme: true });
    const dir = repoDir(deps.config.dataDir, "ada", "gone");
    expect(existsSync(dir)).toBe(true);
    await deleteRepo(deps, repo);
    expect(existsSync(dir)).toBe(false);
    expect(getRepo(deps.db, "ada", "gone")).toBeNull();
  });
});

describe("permissions", () => {
  it("hides private repos from strangers and anonymous users", async () => {
    const repo = await createRepo(deps, ada, { name: "secret", description: "", isPrivate: true, initReadme: false });
    expect(accessLevel(deps.db, null, repo)).toBe("none");
    expect(accessLevel(deps.db, bob, repo)).toBe("none");
    expect(accessLevel(deps.db, ada, repo)).toBe("admin");
    expect(accessLevel(deps.db, root, repo)).toBe("admin");
    addCollaborator(deps.db, repo.id, bob.id, "read");
    expect(accessLevel(deps.db, bob, repo)).toBe("read");
    addCollaborator(deps.db, repo.id, bob.id, "write");
    expect(accessLevel(deps.db, bob, repo)).toBe("write");
    expect(listReposForOwner(deps.db, ada.id, null)).toEqual([]);
    expect(listReposForOwner(deps.db, ada.id, bob).map((r) => r.name)).toEqual(["secret"]);
  });

  it("gives everyone read access to public repos", async () => {
    const repo = await createRepo(deps, ada, { name: "open", description: "", isPrivate: false, initReadme: false });
    expect(accessLevel(deps.db, null, repo)).toBe("read");
    expect(accessLevel(deps.db, bob, repo)).toBe("read");
  });
});

describe("stars", () => {
  it("stars and unstars idempotently", async () => {
    const repo = await createRepo(deps, ada, { name: "s", description: "", isPrivate: false, initReadme: false });
    star(deps.db, bob.id, repo.id);
    star(deps.db, bob.id, repo.id);
    expect(isStarred(deps.db, bob.id, repo.id)).toBe(true);
    expect(getRepo(deps.db, "ada", "s")?.stars).toBe(1);
    expect(listStarred(deps.db, bob.id, bob).map((r) => r.name)).toEqual(["s"]);
    unstar(deps.db, bob.id, repo.id);
    expect(getRepo(deps.db, "ada", "s")?.stars).toBe(0);
  });
});

describe("issues and pulls", () => {
  it("shares one number sequence between issues and pull requests", async () => {
    const repo = await createRepo(deps, ada, { name: "n", description: "", isPrivate: false, initReadme: true });
    const i1 = createIssue(deps.db, repo.id, ada.id, { title: "First", body: "" });
    const p2 = createPull(deps.db, repo.id, bob.id, { title: "PR", body: "", baseRef: "main", headRef: "feature" });
    const i3 = createIssue(deps.db, repo.id, bob.id, { title: "Third", body: "" });
    expect([i1.number, p2.number, i3.number]).toEqual([1, 2, 3]);
    expect(getIssue(deps.db, repo.id, 2)?.isPull).toBe(true);
    expect(getPull(deps.db, repo.id, 2)).toMatchObject({ baseRef: "main", headRef: "feature", mergedAt: null });
    expect(getPull(deps.db, repo.id, 1)).toBeNull();
    expect(countIssues(deps.db, repo.id, false)).toEqual({ open: 2, closed: 0 });
    expect(countIssues(deps.db, repo.id, true)).toEqual({ open: 1, closed: 0 });
  });

  it("tracks comments, state changes, events and labels", async () => {
    const repo = await createRepo(deps, ada, { name: "c", description: "", isPrivate: false, initReadme: false });
    const issue = createIssue(deps.db, repo.id, ada.id, { title: "Bug", body: "It breaks" });
    addComment(deps.db, issue.id, bob.id, "Me too");
    setIssueState(deps.db, issue.id, "closed", ada.id);
    expect(listComments(deps.db, issue.id).map((c) => [c.author, c.body])).toEqual([["bob", "Me too"]]);
    expect(listEvents(deps.db, issue.id).map((e) => [e.actor, e.kind])).toEqual([["ada", "closed"]]);
    expect(getIssue(deps.db, repo.id, issue.number)).toMatchObject({ state: "closed", commentCount: 1 });

    const bug = listLabels(deps.db, repo.id).find((l) => l.name === "bug")!;
    const custom = createLabel(deps.db, repo.id, "needs-design", "#ff00aa");
    setIssueLabels(deps.db, repo.id, issue.id, [bug.id, custom.id]);
    expect(getIssue(deps.db, repo.id, issue.number)?.labels.map((l) => l.name).sort()).toEqual(["bug", "needs-design"]);
    const other = createIssue(deps.db, repo.id, ada.id, { title: "Other", body: "" });
    expect(listIssues(deps.db, repo.id, { state: "closed", isPull: false, labelId: bug.id, page: 1 }).items.map((i) => i.title)).toEqual(["Bug"]);
    expect(listIssues(deps.db, repo.id, { state: "open", isPull: false, page: 1 }).items.map((i) => i.id)).toEqual([other.id]);
    expect(listIssues(deps.db, repo.id, { state: "all", isPull: false, q: "oth", page: 1 }).items.map((i) => i.id)).toEqual([other.id]);
    expect(() => createLabel(deps.db, repo.id, "bad", "red")).toThrow(ValidationError);
  });

  it("marks pull requests merged and filters them", async () => {
    const repo = await createRepo(deps, ada, { name: "m", description: "", isPrivate: false, initReadme: false });
    const pr = createPull(deps.db, repo.id, bob.id, { title: "Feature", body: "", baseRef: "main", headRef: "f" });
    expect(() => createPull(deps.db, repo.id, bob.id, { title: "Again", body: "", baseRef: "main", headRef: "f" })).toThrow(/already exists/);
    expect(() => createPull(deps.db, repo.id, bob.id, { title: "Same", body: "", baseRef: "main", headRef: "main" })).toThrow(ValidationError);
    markMerged(deps.db, pr.id, ada.id, "a".repeat(40));
    expect(getPull(deps.db, repo.id, pr.number)).toMatchObject({ state: "closed", mergedBy: "ada", mergeCommit: "a".repeat(40) });
    expect(listPulls(deps.db, repo.id, { state: "merged", page: 1 }).items.map((p) => p.number)).toEqual([pr.number]);
    expect(listPulls(deps.db, repo.id, { state: "open", page: 1 }).items).toEqual([]);
    expect(listEvents(deps.db, pr.id).map((e) => e.kind)).toEqual(["merged"]);
  });
});
