import { describe, it, expect } from "vitest";
import { Repo } from "../src/git/repo.js";
import { splitRefAndPath } from "../src/git/refs.js";
import { makeRepoWithCommits, tmpDir } from "./helpers.js";

describe("Repo reads", () => {
  it("lists a tree with dirs first and reads a blob", async () => {
    const bare = makeRepoWithCommits(tmpDir(), [
      { files: { "README.md": "# hi\n", "src/a.ts": "export const a = 1;\n" }, message: "init" },
    ]);
    const repo = new Repo(bare);
    const entries = await repo.tree("main", "");
    expect(entries.map((e) => [e.name, e.type])).toEqual([["src", "tree"], ["README.md", "blob"]]);
    const sub = await repo.tree("main", "src");
    expect(sub.map((e) => e.path)).toEqual(["src/a.ts"]);
    const blob = await repo.blob("main", "src/a.ts", 1e6);
    expect(blob.content.toString()).toBe("export const a = 1;\n");
    expect(blob.truncated).toBe(false);
  });

  it("reports object types and resolves refs", async () => {
    const bare = makeRepoWithCommits(tmpDir(), [{ files: { "src/a.ts": "a" }, message: "init" }]);
    const repo = new Repo(bare);
    expect(await repo.objectType("main", "src")).toBe("tree");
    expect(await repo.objectType("main", "src/a.ts")).toBe("blob");
    expect(await repo.objectType("main", "nope")).toBeNull();
    expect(await repo.resolve("main")).toMatch(/^[0-9a-f]{40}$/);
    expect(await repo.resolve("does-not-exist")).toBeNull();
    await expect(repo.resolve("--upload-pack=evil")).rejects.toThrow();
  });

  it("lists branches, log and commit counts", async () => {
    const bare = makeRepoWithCommits(tmpDir(), [
      { files: { "a.txt": "1" }, message: "first" },
      { files: { "a.txt": "2" }, message: "second\n\nbody text" },
      { files: { "b.txt": "x" }, message: "on feature", branch: "feature/x" },
    ]);
    const repo = new Repo(bare);
    expect((await repo.branches()).map((b) => b.name).sort()).toEqual(["feature/x", "main"]);
    expect(await repo.defaultBranch()).toBe("main");
    const log = await repo.log("main", { skip: 0, limit: 10 });
    expect(log.map((c) => c.subject)).toEqual(["second", "first"]);
    expect(log[0].body).toBe("body text");
    expect(log[0].authorName).toBe("Test User");
    expect(await repo.commitCount("feature/x")).toBe(3);
    const pathLog = await repo.log("feature/x", { path: "b.txt", skip: 0, limit: 10 });
    expect(pathLog.map((c) => c.subject)).toEqual(["on feature"]);
  });

  it("shows a commit with its diff against the first parent", async () => {
    const bare = makeRepoWithCommits(tmpDir(), [
      { files: { "a.txt": "one\ntwo\n" }, message: "first" },
      { files: { "a.txt": "one\nTWO\n", "new.txt": "n\n" }, message: "second" },
    ]);
    const repo = new Repo(bare);
    const head = (await repo.resolve("main"))!;
    const c = await repo.commit(head);
    expect(c.subject).toBe("second");
    expect(c.parents).toHaveLength(1);
    expect(c.files.map((f) => [f.newPath, f.status, f.additions, f.deletions])).toEqual([
      ["a.txt", "modified", 1, 1],
      ["new.txt", "added", 1, 0],
    ]);
    const root = await repo.commit(c.parents[0]);
    expect(root.files.map((f) => f.status)).toEqual(["added"]);
  });

  it("finds the last commit for each entry", async () => {
    const bare = makeRepoWithCommits(tmpDir(), [
      { files: { "a.txt": "1", "b.txt": "1", "src/x.ts": "1" }, message: "first" },
      { files: { "b.txt": "2" }, message: "second" },
      { files: { "src/y.ts": "1" }, message: "third" },
    ]);
    const repo = new Repo(bare);
    const last = await repo.lastCommitsFor("main", "", ["a.txt", "b.txt", "src"]);
    expect(last["a.txt"].subject).toBe("first");
    expect(last["b.txt"].subject).toBe("second");
    expect(last["src"].subject).toBe("third");
    const inSrc = await repo.lastCommitsFor("main", "src", ["x.ts", "y.ts"]);
    expect(inSrc["x.ts"].subject).toBe("first");
    expect(inSrc["y.ts"].subject).toBe("third");
  });
});

describe("splitRefAndPath", () => {
  it("splits refs containing slashes by longest match", () => {
    const refs = ["main", "feature", "feature/x"];
    expect(splitRefAndPath("feature/x/src/a.ts", refs)).toEqual({ ref: "feature/x", path: "src/a.ts" });
    expect(splitRefAndPath("feature/y", refs)).toEqual({ ref: "feature", path: "y" });
    expect(splitRefAndPath("main", refs)).toEqual({ ref: "main", path: "" });
    expect(splitRefAndPath("0123abc/src", refs)).toEqual({ ref: "0123abc", path: "src" });
    expect(splitRefAndPath("unknown/x", refs)).toBeNull();
  });
});
