import { describe, it, expect, beforeEach } from "vitest";
import { createRepo, gitFor, type RepoRow } from "../src/services/repos.js";
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
  const git = gitFor(t.deps, repo);
  await git.commitFiles("main", { "src/a.ts": "export const a = 1;\nconst Needle = 2;\n", "docs/guide.md": "# Guide\n" }, "Add source", { name: "Ada", email: "ada@example.com" });
});

describe("repository code pages", () => {
  it("shows the repo home with files, README and clone URL", async () => {
    const html = await (await t.get("/ada/hello")).text();
    expect(html).toContain("README.md");
    expect(html).toContain("src");
    expect(html).toContain("<h1>hello</h1>");
    expect(html).toContain("http://localhost:3000/ada/hello.git");
    expect(html).toContain("A test repo");
    expect(html).toMatch(/2 Commits/);
  });

  it("lists a subdirectory and shows a blob with line numbers", async () => {
    const tree = await (await t.get("/ada/hello/tree/main/src")).text();
    expect(tree).toContain('data-entry="a.ts"');
    const blob = await (await t.get("/ada/hello/blob/main/src/a.ts")).text();
    expect(blob).toContain('id="L2"');
    expect(blob).toContain("Needle");
    expect(blob).toMatch(/2 lines/);
  });

  it("redirects tree URLs that point at files, and 404s unknown paths", async () => {
    const res = await t.get("/ada/hello/tree/main/src/a.ts");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ada/hello/blob/main/src/a.ts");
    expect((await t.get("/ada/hello/tree/main/nope")).status).toBe(404);
    expect((await t.get("/ada/hello/tree/no-such-branch")).status).toBe(404);
  });

  it("serves raw file content as plain text in a sandbox", async () => {
    const res = await t.get("/ada/hello/raw/main/src/a.ts");
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(await res.text()).toBe("export const a = 1;\nconst Needle = 2;\n");
  });

  it("returns per-entry last commit info as JSON", async () => {
    const res = await t.get("/ada/hello/tree-commit-info/main");
    const json = (await res.json()) as { entries: Record<string, { subject: string; url: string }> };
    expect(json.entries["README.md"].subject).toBe("Initial commit");
    expect(json.entries["src"].subject).toBe("Add source");
    expect(json.entries["src"].url).toMatch(/^\/ada\/hello\/commit\/[0-9a-f]{40}$/);
  });

  it("shows commit history and a commit diff", async () => {
    const commits = await (await t.get("/ada/hello/commits/main")).text();
    expect(commits).toContain("Add source");
    expect(commits).toContain("Initial commit");
    expect(commits).toMatch(/Commits on /);
    const sha = (await gitFor(t.deps, repo).resolve("main"))!;
    const commit = await (await t.get(`/ada/hello/commit/${sha}`)).text();
    expect(commit).toContain("Add source");
    expect(commit).toContain("src/a.ts");
    expect(commit).toContain("2 additions");
  });

  it("lists branches", async () => {
    const html = await (await t.get("/ada/hello/branches")).text();
    expect(html).toContain("main");
    expect(html).toContain("default");
  });

  it("searches code on the default branch", async () => {
    const html = await (await t.get("/ada/hello/search?q=needle")).text();
    expect(html).toContain("src/a.ts");
    expect(html).toContain("/ada/hello/blob/main/src/a.ts#L2");
  });

  it("stars and unstars", async () => {
    await t.post("/ada/hello/star", {}, adaWho);
    expect(await (await t.get("/ada/hello", adaWho)).text()).toContain("Starred");
    await t.post("/ada/hello/unstar", {}, adaWho);
    expect(await (await t.get("/ada/hello", adaWho)).text()).not.toContain("Starred");
  });
});

describe("private repositories", () => {
  it("are invisible to anonymous users and strangers", async () => {
    await createRepo(t.deps, ada, { name: "secret", description: "", isPrivate: true, initReadme: true });
    expect((await t.get("/ada/secret")).status).toBe(404);
    expect((await t.get("/ada/secret/raw/main/README.md")).status).toBe(404);
    expect((await t.get("/ada/secret/tree-commit-info/main")).status).toBe(404);
    const bob = t.loginAs(t.user("bob"));
    expect((await t.get("/ada/secret", bob)).status).toBe(404);
    expect((await t.get("/ada/secret", adaWho)).status).toBe(200);
  });
});

describe("new repository", () => {
  it("creates an empty repo and shows push instructions", async () => {
    const res = await t.post("/new", { name: "empty-one", description: "", visibility: "public" }, adaWho);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ada/empty-one");
    const html = await (await t.get("/ada/empty-one", adaWho)).text();
    expect(html).toContain("git remote add origin http://localhost:3000/ada/empty-one.git");
  });

  it("re-renders with an error for invalid names", async () => {
    const res = await t.post("/new", { name: "bad name", description: "", visibility: "public" }, adaWho);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Repository names may contain");
  });

  it("requires sign in", async () => {
    const res = await t.get("/new");
    expect(res.status).toBe(302);
  });
});
