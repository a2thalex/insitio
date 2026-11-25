import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { authorFor, createRepo, gitFor, type RepoRow } from "../src/services/repos.js";
import { createAccessToken, createUser, type User } from "../src/services/users.js";
import { addPushMirror, listPushMirrors, sweepPushMirrors, syncPushMirror, syncPushMirrors } from "../src/services/mirrors.js";
import { startInsitio, testApp, testDeps, tmpDir, type Insitio } from "./helpers.js";

const run = promisify(execFile);

// An isolated git client, as in githttp.e2e: no system or global config and no credential helpers.
const home = tmpDir();
const globalConfig = join(home, "gitconfig");
writeFileSync(globalConfig, "[user]\n\tname = E2E\n\temail = e2e@example.com\n[init]\n\tdefaultBranch = main\n");
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" };
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "credential.helper=", ...args], { cwd, env: gitEnv });

let insitio: Insitio;
let ada: User;
let adaToken: string;
let bobToken: string;
let src: RepoRow;
let dst: RepoRow;
let work: string;
let pushUrl: string;

const repo = (name: string, initReadme = false) => createRepo(insitio.deps, ada, { name, description: "", isPrivate: true, initReadme });
const tips = async (r: RepoRow) => Object.fromEntries((await gitFor(insitio.deps, r).branches()).map((b) => [b.name, b.sha]));
async function until(check: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting for the mirror");
    await new Promise((r) => setTimeout(r, 50));
  }
}
const mirrorRow = (id: number) => insitio.deps.db.prepare("select * from push_mirrors where id = ?").get(id) as Record<string, any>;

beforeAll(async () => {
  insitio = await startInsitio({ mirrorAllowLoopback: true });
  ada = createUser(insitio.deps.db, { username: "ada", password: "longenough", email: "ada@example.com" });
  const bob = createUser(insitio.deps.db, { username: "bob", password: "longenough", email: "bob@example.com" });
  adaToken = createAccessToken(insitio.deps.db, ada.id, "mirror");
  bobToken = createAccessToken(insitio.deps.db, bob.id, "mirror");
  src = await repo("src");
  dst = await repo("dst");
  addPushMirror(insitio.deps.db, src.id, { url: `${insitio.base}/ada/dst.git`, username: "ada", token: adaToken }, true);
  work = join(tmpDir(), "work");
  mkdirSync(work);
  await git(work, "init", "-q");
  pushUrl = insitio.base.replace("http://", `http://ada:${adaToken}@`) + "/ada/src.git";
});

afterAll(async () => {
  await insitio?.close();
});

describe("push mirrors", () => {
  it("pushes branches and tags after a git push, and prunes a branch deleted here", async () => {
    writeFileSync(join(work, "a.txt"), "one\n");
    await git(work, "add", "a.txt");
    await git(work, "commit", "-q", "-m", "one");
    await git(work, "push", "-q", pushUrl, "main");
    // Nothing here starts the mirror: the push itself must.
    await until(async () => JSON.stringify(await tips(dst)) === JSON.stringify(await tips(src)));

    await git(work, "switch", "-q", "-c", "feature");
    writeFileSync(join(work, "b.txt"), "two\n");
    await git(work, "add", "b.txt");
    await git(work, "commit", "-q", "-m", "two");
    await git(work, "tag", "v1");
    await git(work, "push", "-q", pushUrl, "feature", "v1");
    await syncPushMirrors(insitio.deps, src.id);
    expect(Object.keys(await tips(dst)).sort()).toEqual(["feature", "main"]);
    expect(await gitFor(insitio.deps, dst).tags()).toContain("v1");

    await git(work, "push", "-q", pushUrl, ":feature");
    await syncPushMirrors(insitio.deps, src.id);
    expect(Object.keys(await tips(dst))).toEqual(["main"]);
    expect(await gitFor(insitio.deps, dst).tags()).toContain("v1");

    const [mirror] = listPushMirrors(insitio.deps.db, src.id);
    expect(mirror.lastError).toBe("");
    expect(mirror.lastSyncedAt).not.toBeNull();
  });

  it("catches a commit made in the web UI on the sweep, and skips mirrors with nothing new", async () => {
    await gitFor(insitio.deps, src).commitFiles("main", { "web.txt": "edited in the browser\n" }, "Edit in the browser", authorFor(ada));
    await sweepPushMirrors(insitio.deps);
    expect((await tips(dst)).main).toBe((await tips(src)).main);

    const [mirror] = listPushMirrors(insitio.deps.db, src.id);
    insitio.deps.db.prepare("update push_mirrors set last_attempt_at = 1 where id = ?").run(mirror.id);
    await sweepPushMirrors(insitio.deps);
    expect(mirrorRow(mirror.id).last_attempt_at).toBe(1);
  });

  it("records a refused push without the token, and the sweep waits before retrying", async () => {
    const other = await repo("other", true);
    const id = addPushMirror(insitio.deps.db, other.id, { url: `${insitio.base}/ada/dst.git`, username: "bob", token: bobToken }, true);
    await syncPushMirror(insitio.deps, other.id, id);
    const failed = listPushMirrors(insitio.deps.db, other.id)[0];
    expect(failed.lastError).not.toBe("");
    expect(failed.lastError).not.toContain(bobToken);
    expect(failed.lastSyncedAt).toBeNull();

    const recent = Math.floor(Date.now() / 1000) - 60;
    insitio.deps.db.prepare("update push_mirrors set last_attempt_at = ? where id = ?").run(recent, id);
    await sweepPushMirrors(insitio.deps);
    expect(mirrorRow(id).last_attempt_at).toBe(recent);
  });

  it("never pushes an empty repository, so the other side keeps its branches", async () => {
    const empty = await repo("empty");
    const kept = await repo("kept", true);
    const before = await tips(kept);
    const id = addPushMirror(insitio.deps.db, empty.id, { url: `${insitio.base}/ada/kept.git`, username: "ada", token: adaToken }, true);
    await syncPushMirror(insitio.deps, empty.id, id);
    expect(listPushMirrors(insitio.deps.db, empty.id)[0].lastError).toMatch(/no branches/);
    expect(await tips(kept)).toEqual(before);
  });
});

describe("push mirror settings", () => {
  it("refuses a URL that is not https or that points inside", () => {
    const { db } = testDeps();
    const add = (url: string, token = "t0ken") => () => addPushMirror(db, 1, { url, username: "ada", token });
    expect(add("http://github.com/a/b.git")).toThrow(/must be https/);
    expect(add("https://ada:pw@github.com/a/b.git")).toThrow(/username or password/);
    expect(add("https://127.0.0.1/a/b.git")).toThrow(/not allowed/);
    expect(add("https://10.1.2.3/a/b.git")).toThrow(/not allowed/);
    expect(add("https://metadata.google.internal/a")).toThrow(/not allowed/);
    expect(add("https://github.com/a/b.git", "two words")).toThrow(/access token/);
  });

  it("lets an admin add and delete a mirror, never shows the token, and refuses everyone else", async () => {
    const t = testApp();
    const owner = t.user("ada");
    const outsider = t.user("bob");
    const r = await createRepo(t.deps, owner, { name: "r", description: "", isPrivate: false, initReadme: true });
    const token = "ghp_example_token_never_shown";
    const url = "https://mirror.invalid/ada/r.git";

    const denied = await t.post("/ada/r/settings/mirrors", { url, username: "ada", token }, t.loginAs(outsider));
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(listPushMirrors(t.deps.db, r.id)).toHaveLength(0);

    const added = await t.post("/ada/r/settings/mirrors", { url, username: "ada", token }, t.loginAs(owner));
    expect(added.status).toBe(302);
    await syncPushMirrors(t.deps, r.id);
    const html = await (await t.get("/ada/r/settings", t.loginAs(owner))).text();
    expect(html).toContain(url);
    expect(html).toContain("Last attempt failed");
    expect(html).not.toContain(token);

    const [mirror] = listPushMirrors(t.deps.db, r.id);
    await t.post(`/ada/r/settings/mirrors/${mirror.id}/delete`, {}, t.loginAs(owner));
    expect(listPushMirrors(t.deps.db, r.id)).toHaveLength(0);
  });
});
