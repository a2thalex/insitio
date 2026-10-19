import { describe, expect, it, beforeEach } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createPull } from "../src/services/pulls.js";
import { createRepo, gitFor, type RepoRow } from "../src/services/repos.js";
import { createAccessToken } from "../src/services/users.js";
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
  repo = await createRepo(t.deps, ada, { name: "hello", description: "A test repo", isPrivate: false, initReadme: true });
});

const MIT = "Permission is hereby granted, free of charge, to any person obtaining a copy of this software.\n";

function multipart(fields: { name: string; filename?: string; value: string }[]): { body: Buffer; type: string } {
  const boundary = "----insitio-test";
  const chunks: Buffer[] = [];
  for (const field of fields) {
    const disposition = field.filename
      ? `Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"`
      : `Content-Disposition: form-data; name="${field.name}"`;
    chunks.push(Buffer.from(`--${boundary}\r\n${disposition}\r\n\r\n${field.value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}` };
}

describe("editing files", () => {
  it("commits an edit on the branch and keeps the text when the branch moved", async () => {
    const created = await t.post("/ada/hello/edit/main/README.md", { content: "# changed\n", message: "", base_sha: (await gitFor(t.deps, repo).branchTip("main"))! }, adaWho);
    expect(created.status).toBe(302);
    expect(created.headers.get("location")).toBe("/ada/hello/blob/main/README.md");
    expect(await (await t.get("/ada/hello/raw/main/README.md")).text()).toBe("# changed\n");
    const page = await (await t.get("/ada/hello/blob/main/README.md", adaWho)).text();
    expect(page).toContain("Blame");
    expect(page).toContain("Edit");

    const seen = (await gitFor(t.deps, repo).branchTip("main"))!;
    await gitFor(t.deps, repo).commitFiles("main", { "other.txt": "x\n" }, "raced", { name: "Ada", email: "ada@example.com" });
    const raced = await t.post("/ada/hello/edit/main/README.md", { content: "# mine\n", message: "Mine", base_sha: seen }, adaWho);
    expect(raced.status).toBe(409);
    const html = await raced.text();
    expect(html).toContain("This branch changed while you were editing");
    expect(html).toContain("# mine");
    expect(await (await t.get("/ada/hello/raw/main/README.md")).text()).toBe("# changed\n");
  });

  it("creates a file on a new branch and sends you to compare", async () => {
    const sha = (await gitFor(t.deps, repo).branchTip("main"))!;
    const res = await t.post(
      "/ada/hello/new/main",
      { filename: "docs/guide.md", content: "guide\n", message: "", commit_to: "branch", new_branch: "docs", base_sha: sha },
      adaWho,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ada/hello/compare/main...docs");
    expect(await (await t.get("/ada/hello/raw/docs/docs/guide.md")).text()).toBe("guide\n");
    expect((await t.get("/ada/hello/raw/main/docs/guide.md")).status).toBe(404);
  });

  it("keeps CRLF when the file already used it on every line", async () => {
    await gitFor(t.deps, repo).commitFiles("main", { "crlf.txt": "a\r\nb\r\n" }, "crlf", { name: "Ada", email: "ada@example.com" });
    const sha = (await gitFor(t.deps, repo).branchTip("main"))!;
    const res = await t.post("/ada/hello/edit/main/crlf.txt", { content: "a\nc\n", message: "c", base_sha: sha }, adaWho);
    expect(res.status).toBe(302);
    expect(await (await t.get("/ada/hello/raw/main/crlf.txt")).text()).toBe("a\r\nc\r\n");
  });

  it("rejects a path that escapes the tree and hides a private repo", async () => {
    const sha = (await gitFor(t.deps, repo).branchTip("main"))!;
    const bad = await t.post("/ada/hello/new/main", { filename: "../secret.txt", content: "nope", base_sha: sha }, adaWho);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("not allowed");
    const bob = t.loginAs(t.user("bob"));
    expect((await t.post("/ada/hello/edit/main/README.md", { content: "x", base_sha: sha }, bob)).status).toBe(403);
    await createRepo(t.deps, ada, { name: "secret", description: "", isPrivate: true, initReadme: true });
    expect((await t.get("/ada/secret/blame/main/README.md")).status).toBe(404);
    expect((await t.get("/ada/secret/archive/refs/heads/main.zip")).status).toBe(404);
  });
});

describe("blame, branches, tags and archives", () => {
  it("shows blame hunks and refuses a binary file", async () => {
    await gitFor(t.deps, repo).commitFiles("main", { "notes.txt": "one\ntwo\n" }, "notes", { name: "Ada", email: "ada@example.com" });
    await gitFor(t.deps, repo).commitFiles("main", { "notes.txt": "one\nchanged\n" }, "Second line", { name: "Ada", email: "ada@example.com" });
    const html = await (await t.get("/ada/hello/blame/main/notes.txt")).text();
    expect(html).toContain("Second line");
    expect(html).toContain("changed");
    expect(html).toContain('id="L2"');
    const sha = (await gitFor(t.deps, repo).resolve("main"))!;
    expect(html).toContain(`/ada/hello/blob/${sha}/notes.txt#L1`);
    await gitFor(t.deps, repo).commitFiles("main", { "bin.dat": "a\0b" }, "bin", { name: "Ada", email: "ada@example.com" });
    expect(await (await t.get("/ada/hello/blame/main/bin.dat")).text()).toContain("show blame");
  });

  it("creates, refuses and restores branches", async () => {
    const made = await t.post("/ada/hello/branches", { name: "feature", source: "main" }, adaWho);
    expect(made.status).toBe(302);
    expect(await gitFor(t.deps, repo).branchTip("feature")).toBe(await gitFor(t.deps, repo).branchTip("main"));
    const blocked = await t.post("/ada/hello/branches/delete", { name: "main" }, adaWho);
    expect(await blocked.text()).toContain("default branch");
    createPull(t.deps.db, repo.id, ada.id, { title: "Work", body: "", baseRef: "main", headRef: "feature" });
    const used = await t.post("/ada/hello/branches/delete", { name: "feature" }, adaWho);
    expect(await used.text()).toContain("pull request #1");
    t.deps.db.prepare("update issues set state = 'closed' where repo_id = ?").run(repo.id);
    const removed = await t.post("/ada/hello/branches/delete", { name: "feature" }, adaWho);
    expect(removed.status).toBe(302);
    expect(removed.headers.get("location")).toMatch(/deleted=feature&sha=[0-9a-f]{40}/);
    const page = await (await t.get(removed.headers.get("location")!, adaWho)).text();
    expect(page).toContain("Restore");
    await t.post("/ada/hello/branches/restore", { name: "feature", sha: removed.headers.get("location")!.split("sha=")[1] }, adaWho);
    expect(await gitFor(t.deps, repo).branchTip("feature")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("lists an annotated tag and serves a zip of the branch", async () => {
    await gitFor(t.deps, repo).createTag("v1.0.0", "main", "First release", { name: "Ada", email: "ada@example.com" });
    const tags = await (await t.get("/ada/hello/tags")).text();
    expect(tags).toContain("v1.0.0");
    expect(tags).toContain("First release");
    expect(tags).toContain("/ada/hello/archive/refs/tags/v1.0.0.zip");
    const zip = await t.get("/ada/hello/archive/refs/heads/main.zip");
    expect(zip.headers.get("content-type")).toContain("application/zip");
    expect(zip.headers.get("content-disposition")).toContain("attachment");
    const bytes = Buffer.from(await zip.arrayBuffer());
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    expect(bytes.includes(Buffer.from("hello-main/README.md"))).toBe(true);
  });
});

describe("releases", () => {
  it("publishes a release, counts a download, and keeps the tag when the release is deleted", async () => {
    const res = await t.post("/ada/hello/releases/new", { tag: "v1.0.0", target: "main", title: "One", body: "Hello **notes**", set_latest: "1" }, adaWho);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ada/hello/releases/tag/v1.0.0");
    const page = await (await t.get("/ada/hello/releases/tag/v1.0.0")).text();
    expect(page).toContain("Hello");
    expect(page).toContain("<strong>notes</strong>");
    const sha = (await gitFor(t.deps, repo).resolve("v1.0.0"))!;
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const body = multipart([{ name: "file", filename: "notes.txt", value: "hi" }, { name: "base_sha", value: "unused" }]);
    const up = await t.app.request(`/ada/hello/releases/1/assets?_csrf=${adaWho.csrf}`, {
      method: "POST",
      headers: { cookie: adaWho.cookie, "content-type": body.type },
      body: new Uint8Array(body.body),
    });
    expect(up.status).toBe(302);
    const dir = join(t.deps.config.dataDir, "releases", String(repo.id), "1");
    expect(readdirSync(dir).some((name) => name === "notes.txt")).toBe(false);
    expect(readdirSync(dir).some((name) => /^\d+$/.test(name))).toBe(true);
    const download = await t.get("/ada/hello/releases/download/v1.0.0/notes.txt");
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(await download.text()).toBe("hi");
    expect(await (await t.get("/ada/hello/releases/download/v1.0.0/notes.txt")).text()).toBe("hi");
    expect(await (await t.get("/ada/hello/releases/tag/v1.0.0")).text()).toContain("2 downloads");
    const latest = await t.get("/ada/hello/releases/latest");
    expect(latest.status).toBe(302);
    expect(latest.headers.get("location")).toBe("/ada/hello/releases/tag/v1.0.0");
    await t.post("/ada/hello/releases/delete", { tag: "v1.0.0" }, adaWho);
    expect(await gitFor(t.deps, repo).hasRef("tags", "v1.0.0")).toBe(true);
  });

  it("hides a draft from a reader", async () => {
    await t.post("/ada/hello/releases/new", { tag: "v0.1.0", target: "main", title: "Soon", body: "", draft: "1" }, adaWho);
    const bob = t.loginAs(t.user("bob"));
    expect((await t.get("/ada/hello/releases/tag/v0.1.0", bob)).status).toBe(404);
    expect(await (await t.get("/ada/hello/releases/tag/v0.1.0", adaWho)).text()).toContain("Draft");
  });

  it("creates a release and attaches a raw asset over the API", async () => {
    const token = createAccessToken(t.deps.db, ada.id, "cli");
    const created = await t.app.request("/api/v1/repos/ada/hello/releases", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tag_name: "v2.0.0", name: "Two", body: "via api" }),
    });
    expect(created.status).toBe(201);
    const release = (await created.json()) as { id: number; tag_name: string };
    const asset = await t.app.request(`/api/v1/repos/ada/hello/releases/${release.id}/assets?name=note.txt`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
      body: "hello api",
    });
    expect(asset.status).toBe(201);
    expect(await (await t.get("/ada/hello/releases/download/v2.0.0/note.txt")).text()).toBe("hello api");
    const latest = await t.app.request("/api/v1/repos/ada/hello/releases/latest", { headers: { authorization: `Bearer ${token}` } });
    expect(latest.status).toBe(200);
    expect(((await latest.json()) as { tag_name: string }).tag_name).toBe("v2.0.0");
  });
});

describe("forks, watches and the about sidebar", () => {
  it("forks a public repo and keeps a private fork private", async () => {
    const res = await t.post("/ada/hello/fork", {}, t.loginAs(t.user("bob")));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/bob/hello");
    const page = await (await t.get("/bob/hello")).text();
    expect(page).toContain("forked from");
    expect(page).toContain("ada/hello");
    expect(await (await t.get("/bob/hello/raw/main/README.md")).text()).toContain("# hello");
    await createRepo(t.deps, ada, { name: "secret", description: "", isPrivate: true, initReadme: true });
    const hidden = await t.post("/ada/secret/fork", {}, t.loginAs(t.user("cam")));
    expect(hidden.status).toBe(404);
    const allowed = await t.post("/ada/secret/fork", {}, adaWho);
    expect(allowed.headers.get("location")).toBe("/ada/secret-1");
    expect((await t.get("/ada/secret-1")).status).toBe(404);
    expect((await t.get("/ada/secret-1", adaWho)).status).toBe(200);
  });

  it("stores watch levels and lists only all-activity watchers", async () => {
    const bob = t.user("bob");
    const bobWho = t.loginAs(bob);
    await t.post("/ada/hello/watch", { level: "all" }, bobWho);
    await t.post("/ada/hello/watch", { level: "ignore" }, adaWho);
    const page = await (await t.get("/ada/hello/watchers")).text();
    const list = page.split("<h1")[1] ?? page;
    expect(list).toContain("bob");
    expect(list).not.toContain('href="/ada"');
    const home = await (await t.get("/ada/hello", bobWho)).text();
    expect(home).toContain(">1<");
  });

  it("shows topics, a detected license, languages and contributors", async () => {
    await gitFor(t.deps, repo).commitFiles(
      "main",
      { "LICENSE": MIT, "src/app.ts": "export const n = 1;\n", "pic.png": "not really", "node_modules/pkg/index.js": "hidden\n" },
      "meta",
      { name: "Ada", email: "ada@example.com" },
    );
    await t.post("/ada/hello/about", { description: "Widgets", website: "https://example.com", topics: "Widgets, cool-stuff" }, adaWho);
    const html = await (await t.get("/ada/hello")).text();
    expect(html).toContain("Widgets");
    expect(html).toContain("https://example.com");
    expect(html).toContain('href="/topics/widgets"');
    expect(html).toContain("MIT");
    expect(html).toContain("TypeScript");
    expect(html).not.toContain("JavaScript");
    const people = await (await t.get("/ada/hello/graphs/contributors")).text();
    expect(people).toContain("ada");
    const search = await (await t.get("/search?q=topic:widgets")).text();
    expect(search).toContain("ada/hello");
    const other = await (await t.get("/search?q=topic:nope")).text();
    expect(other).not.toContain("ada/hello");
  });
});
