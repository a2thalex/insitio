import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { EmptyCommitError, PathConflictError, RefMovedError, Repo } from "../src/git/repo.js";
import { archivePrefix } from "../src/git/paths.js";
import { startArchive } from "../src/git/archive.js";
import { initBareRepo } from "../src/git/storage.js";
import { makeRepoWithCommits, tmpDir } from "./helpers.js";

const author = { name: "Ada", email: "ada@example.com" };

async function repoWith(files: Record<string, string>): Promise<Repo> {
  const dir = join(tmpDir(), "r.git");
  await initBareRepo(dir, "main");
  const repo = new Repo(dir);
  await repo.commitFiles("main", files, "init", author);
  return repo;
}

describe("web commits", () => {
  it("updates, deletes and refuses a path that is both a file and a folder", async () => {
    const repo = await repoWith({ "README.md": "hello\n", "src/a.ts": "export const a = 1;\n" });
    const base = (await repo.branchTip("main"))!;
    const next = await repo.commitChanges(
      "main",
      [{ path: "README.md", content: Buffer.from("hello world\n") }, { path: "src/a.ts", delete: true }],
      "Edit readme and drop a",
      author,
      { expected: base, parent: base },
    );
    expect(await repo.branchTip("main")).toBe(next);
    expect((await repo.blob("main", "README.md", 100)).content.toString()).toBe("hello world\n");
    expect(await repo.objectType("main", "src/a.ts")).toBeNull();
    await expect(
      repo.commitChanges(
        "main",
        [
          { path: "both", content: Buffer.from("file\n") },
          { path: "both/child", content: Buffer.from("nope\n") },
        ],
        "bad",
        author,
        { expected: next, parent: next },
      ),
    ).rejects.toBeInstanceOf(PathConflictError);
  });

  it("does not move the branch when the expected sha is stale, and keeps an unchanged edit from committing", async () => {
    const repo = await repoWith({ "README.md": "hello\n" });
    const base = (await repo.branchTip("main"))!;
    await repo.commitFiles("main", { "other.txt": "x\n" }, "someone else", author);
    await expect(
      repo.commitChanges("main", [{ path: "README.md", content: Buffer.from("mine\n") }], "mine", author, { expected: base, parent: base }),
    ).rejects.toBeInstanceOf(RefMovedError);
    expect((await repo.blob("main", "README.md", 100)).content.toString()).toBe("hello\n");
    const tip = (await repo.branchTip("main"))!;
    await expect(
      repo.commitChanges("main", [{ path: "README.md", content: Buffer.from("hello\n") }], "same", author, { expected: tip, parent: tip }),
    ).rejects.toBeInstanceOf(EmptyCommitError);
  });

  it("creates a branch from a commit and refuses a second copy, and deletes only the sha it was shown", async () => {
    const repo = await repoWith({ "README.md": "hello\n" });
    const base = (await repo.branchTip("main"))!;
    await repo.createBranch("feature", "main");
    expect(await repo.branchTip("feature")).toBe(base);
    await expect(repo.createBranch("feature", "main")).rejects.toBeInstanceOf(RefMovedError);
    await expect(repo.validBranchName("bad name")).resolves.toBeNull();
    await repo.deleteBranch("feature", base);
    expect(await repo.branchTip("feature")).toBeNull();
    await repo.createBranch("feature", base);
    await repo.commitFiles("feature", { "z.txt": "z\n" }, "move", author);
    await expect(repo.deleteBranch("feature", base)).rejects.toBeInstanceOf(RefMovedError);
  });

  it("blames lines back to the commits that wrote them", async () => {
    const repo = await repoWith({ "notes.txt": "one\ntwo\n" });
    await repo.commitFiles("main", { "notes.txt": "one\nchanged\n" }, "Second line", author);
    const hunks = await repo.blame("main", "notes.txt");
    expect(hunks.map((hunk) => hunk.lines.join("\n"))).toEqual(["one", "changed"]);
    expect(hunks[1]).toMatchObject({ summary: "Second line", authorName: "Ada", startLine: 2 });
    expect(hunks[0].sha).not.toBe(hunks[1].sha);
  });

  it("creates an annotated tag and lists its message", async () => {
    const repo = await repoWith({ "README.md": "hello\n" });
    await repo.createTag("v1.0.0", "main", "First release\n\nNotes", author);
    const [tag] = await repo.tagList();
    expect(tag).toMatchObject({ name: "v1.0.0", annotated: true, message: expect.stringContaining("First release") });
    expect(tag.sha).toBe(await repo.branchTip("main"));
    const people = await repo.contributors("main");
    expect(people[0]).toMatchObject({ email: "ada@example.com", commits: 1 });
  });
});

describe("git archive", () => {
  it("streams a zip whose paths start with the repo and ref", async () => {
    const repo = await repoWith({ "README.md": "hello\n" });
    const sha = (await repo.branchTip("main"))!;
    expect(archivePrefix("hello", "feature/x")).toBe("hello-feature-x/");
    const child = startArchive(repo.dir, sha, "hello", "main", "zip");
    const chunks: Buffer[] = [];
    child.stdout!.on("data", (chunk) => chunks.push(chunk));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(0);
    const zip = Buffer.concat(chunks);
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    expect(zip.includes(Buffer.from("hello-main/README.md"))).toBe(true);
    const tar = startArchive(repo.dir, sha, "hello", "main", "tar.gz");
    const gz: Buffer[] = [];
    tar.stdout!.on("data", (chunk) => gz.push(chunk));
    expect(await new Promise((resolve) => tar.on("close", resolve))).toBe(0);
    const unpacked = gunzipSync(Buffer.concat(gz));
    expect(unpacked.includes(Buffer.from("hello-main/README.md"))).toBe(true);
  });
});
