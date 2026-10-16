import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { MergeConflictError, Repo } from "../src/git/repo.js";
import { initBareRepo } from "../src/git/storage.js";
import { makeRepoWithCommits, tmpDir } from "./helpers.js";

const author = { name: "Ada", email: "ada@example.com" };

describe("Repo writes", () => {
  it("creates an initial commit without a worktree", async () => {
    const dir = join(tmpDir(), "new.git");
    await initBareRepo(dir, "main");
    const repo = new Repo(dir);
    expect(await repo.isEmpty()).toBe(true);
    const sha = await repo.commitFiles("main", { "README.md": "# new\n", "docs/a.md": "a\n" }, "Initial commit", author);
    expect(await repo.resolve("main")).toBe(sha);
    expect((await repo.tree("main", "")).map((e) => e.name)).toEqual(["docs", "README.md"]);
    const [c] = await repo.log("main", { skip: 0, limit: 1 });
    expect(c).toMatchObject({ subject: "Initial commit", authorName: "Ada" });
    await repo.commitFiles("main", { "docs/b.md": "b\n" }, "Add b", author);
    expect((await repo.tree("main", "docs")).map((e) => e.name)).toEqual(["a.md", "b.md"]);
  });

  it("compares branches with three-dot semantics", async () => {
    const repo = new Repo(
      makeRepoWithCommits(tmpDir(), [
        { files: { "a.txt": "1\n" }, message: "base" },
        { files: { "f.txt": "feature\n" }, message: "feature work", branch: "feature" },
        { files: { "m.txt": "main\n" }, message: "main moves on", branch: "main" },
      ]),
    );
    const cmp = await repo.compare("main", "feature");
    expect(cmp.commits.map((c) => c.subject)).toEqual(["feature work"]);
    expect(cmp.files.map((f) => f.newPath)).toEqual(["f.txt"]);
    expect(cmp.mergeBase).toMatch(/^[0-9a-f]{40}$/);
  });

  it("merges cleanly with a two-parent commit", async () => {
    const repo = new Repo(
      makeRepoWithCommits(tmpDir(), [
        { files: { "a.txt": "1\n" }, message: "base" },
        { files: { "f.txt": "feature\n" }, message: "feature work", branch: "feature" },
        { files: { "m.txt": "main\n" }, message: "main moves on", branch: "main" },
      ]),
    );
    expect(await repo.mergeability("main", "feature")).toBe("clean");
    const before = await repo.resolve("main");
    const sha = await repo.merge("main", "feature", "Merge pull request #1", author);
    expect(await repo.resolve("main")).toBe(sha);
    const merged = await repo.commit(sha);
    expect(merged.parents).toEqual([before, await repo.resolve("feature")]);
    expect((await repo.tree("main", "")).map((e) => e.name).sort()).toEqual(["a.txt", "f.txt", "m.txt"]);
    expect(await repo.mergeability("main", "feature")).toBe("up_to_date");
  });

  it("detects conflicts and refuses to merge", async () => {
    const repo = new Repo(
      makeRepoWithCommits(tmpDir(), [
        { files: { "a.txt": "1\n" }, message: "base" },
        { files: { "a.txt": "feature\n" }, message: "feature edit", branch: "feature" },
        { files: { "a.txt": "main\n" }, message: "main edit", branch: "main" },
      ]),
    );
    expect(await repo.mergeability("main", "feature")).toBe("conflict");
    await expect(repo.merge("main", "feature", "m", author)).rejects.toBeInstanceOf(MergeConflictError);
    expect(await repo.mergeability("main", "nope")).toBe("missing");
  });

  it("greps file contents at a ref", async () => {
    const repo = new Repo(
      makeRepoWithCommits(tmpDir(), [
        { files: { "src/a.ts": "const x = 1;\nconst Needle = 2;\n", "b.md": "no match\n" }, message: "init" },
      ]),
    );
    expect(await repo.grep("main", "needle", 50)).toEqual([
      { path: "src/a.ts", lines: [{ no: 2, text: "const Needle = 2;" }] },
    ]);
    expect(await repo.grep("main", "absent", 50)).toEqual([]);
  });
});
