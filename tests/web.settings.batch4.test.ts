import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { installPushHook } from "../src/git/hooks.js";
import { runGit } from "../src/git/run.js";
import { repoDir } from "../src/git/storage.js";
import { assertWebhookUrl, deployKeyAccess } from "../src/services/repoAdmin.js";
import { addCollaborator, createRepo, gitFor, type RepoRow } from "../src/services/repos.js";
import { ValidationError } from "../src/services/errors.js";
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

describe("repository settings", () => {
  it("renames, transfers, archives, and hides a turned-off feature", async () => {
    const renamed = await t.post("/ada/hello/settings/rename", { name: "world" }, adaWho);
    expect(renamed.status).toBe(302);
    expect(renamed.headers.get("location")).toBe("/ada/world/settings");
    expect((await t.get("/ada/hello")).status).toBe(404);
    expect((await t.get("/ada/world")).status).toBe(200);

    const bob = t.user("bob");
    const moved = await t.post("/ada/world/settings/transfer", { target: "bob/world" }, adaWho);
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe("/bob/world/settings");
    expect((await t.get("/ada/world")).status).toBe(404);
    const bobWho = t.loginAs(bob);
    expect(await (await t.get("/bob/world/settings", bobWho)).text()).toContain("Archive this repository");

    expect((await t.post("/bob/world/settings/archive", {}, bobWho)).status).toBe(302);
    const archived = await (await t.get("/bob/world")).text();
    expect(archived).toContain("Archived");
    expect((await t.post("/bob/world/issues", { title: "Nope", body: "" }, bobWho)).status).toBe(403);

    expect((await t.post("/bob/world/settings/archive", {}, bobWho)).status).toBe(302);
    expect((await t.post("/bob/world/settings/features", { pulls: "1", merge: "1" }, bobWho)).status).toBe(302);
    expect((await t.get("/bob/world/issues")).status).toBe(404);
    expect(await (await t.get("/bob/world")).text()).not.toContain('href="/bob/world/issues"');
  });

  it("turns off squash, requires an approving review, and rejects a private webhook", async () => {
    await gitFor(t.deps, repo).commitFiles("feature", { "a.txt": "a\n" }, "a", { name: "Ada", email: "ada@example.com" }, "main");
    await t.post("/ada/hello/pulls", { base: "main", head: "feature", title: "Add", body: "" }, adaWho);
    expect((await t.post("/ada/hello/settings/features", { issues: "1", pulls: "1", merge: "1", rebase: "1" }, adaWho)).status).toBe(302);
    expect((await t.post("/ada/hello/pull/1/merge", { method: "squash" }, adaWho)).status).toBe(409);
    expect((await t.post("/ada/hello/settings/protection", { branch: "main", require_pr: "1", approvals: "1" }, adaWho)).status).toBe(302);
    expect((await t.post("/ada/hello/pull/1/merge", { method: "merge" }, adaWho)).status).toBe(409);
    const bob = t.user("bob");
    addCollaborator(t.deps.db, repo.id, bob.id, "write");
    expect((await t.post("/ada/hello/pull/1/reviews", { state: "approve", body: "yes" }, t.loginAs(bob))).status).toBe(302);
    expect((await t.post("/ada/hello/pull/1/merge", { method: "merge" }, adaWho)).status).toBe(302);

    expect(() => assertWebhookUrl("http://127.0.0.1/hook")).toThrow(ValidationError);
    expect(() => assertWebhookUrl("http://10.1.1.1/hook")).toThrow(ValidationError);
    expect(() => assertWebhookUrl("http://user:pass@example.com/hook")).toThrow(ValidationError);
    expect((await t.post("/ada/hello/settings/hooks", { url: "http://169.254.1.1/hook", events: "push" }, adaWho)).status).toBe(400);
  });

  it("delivers an issue webhook to loopback when tests allow it", async () => {
    const hits: { signature: string | undefined; body: string }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        hits.push({ signature: req.headers["x-insitio-signature"] as string | undefined, body: Buffer.concat(chunks).toString("utf8") });
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    t.deps.config.webhookAllowLoopback = true;
    try {
      expect((await t.post("/ada/hello/settings/hooks", { url: `http://127.0.0.1:${port}/hook`, secret: "s3cret", events: "issues" }, adaWho)).status).toBe(302);
      expect((await t.post("/ada/hello/issues", { title: "Hooked", body: "" }, adaWho)).status).toBe(302);
      expect(hits).toHaveLength(1);
      expect(hits[0].body).toContain("Hooked");
      expect(hits[0].signature).toMatch(/^sha256=[0-9a-f]{64}$/);
      const page = await (await t.get("/ada/hello/settings", adaWho)).text();
      expect(page).toContain("last HTTP 200");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("shows a deploy key once and limits it to that repository", async () => {
    const other = await createRepo(t.deps, ada, { name: "other", description: "", isPrivate: false, initReadme: false });
    const created = await t.post("/ada/hello/settings/keys", { title: "ci", write: "1" }, adaWho);
    expect(created.status).toBe(200);
    const html = await created.text();
    const token = /idk_[A-Za-z0-9_-]+/.exec(html)?.[0];
    expect(token).toBeTruthy();
    expect(deployKeyAccess(t.deps.db, token!, repo.id)).toBe("write");
    expect(deployKeyAccess(t.deps.db, token!, other.id)).toBeNull();
    const again = await (await t.get("/ada/hello/settings", adaWho)).text();
    expect(again).not.toContain(token);
    expect(again).toContain("ci");
  });

  it("rejects a non-admin push to a protected branch and lets an admin through", async () => {
    const bare = repoDir(t.deps.config.dataDir, "ada", "hello");
    await installPushHook(bare);
    const work = join(t.deps.config.dataDir, "push-work");
    mkdirSync(work);
    const git = (args: string[], env: Record<string, string> = {}) => runGit(work, args, { env });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "ada@example.com"]);
    await git(["config", "user.name", "Ada"]);
    writeFileSync(join(work, "n.txt"), "n\n");
    await git(["add", "n.txt"]);
    await git(["commit", "-q", "-m", "n"]);
    const before = await gitFor(t.deps, repo).resolve("main");
    const denied = git(["push", "--force", bare, "main"], { INSITIO_PROTECTED_REFS: "refs/heads/main", INSITIO_PUSH_ADMIN: "0" });
    await expect(denied).rejects.toThrow(/protected branch/i);
    expect(await gitFor(t.deps, repo).resolve("main")).toBe(before);
    await git(["push", "--force", bare, "main"], { INSITIO_PROTECTED_REFS: "refs/heads/main", INSITIO_PUSH_ADMIN: "1" });
    expect(await gitFor(t.deps, repo).resolve("main")).not.toBe(before);
  });
});
