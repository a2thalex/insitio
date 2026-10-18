import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { createInsitioServer } from "../src/server.js";
import { addCollaborator, createRepo, getRepo, gitFor } from "../src/services/repos.js";
import { createAccessToken, createSession, createUser, getUserByName } from "../src/services/users.js";
import { matchGitRoute } from "../src/githttp/handler.js";
import { testDeps, tmpDir } from "./helpers.js";


const run = promisify(execFile);

// An isolated git client: no system/global config, no credential helpers, no prompts,
// so the test never touches the developer's own git setup or credential store.
const home = tmpDir();
const globalConfig = join(home, "gitconfig");
writeFileSync(globalConfig, "[user]\n\tname = E2E\n\temail = e2e@example.com\n[init]\n\tdefaultBranch = main\n");
const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: globalConfig,
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
};

function git(cwd: string, ...args: string[]) {
  return run("git", ["-c", "credential.helper=", "-c", "core.autocrlf=false", ...args], { cwd, env: gitEnv });
}

async function gitFails(cwd: string, ...args: string[]): Promise<string> {
  try {
    await git(cwd, ...args);
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
  throw new Error(`expected git ${args.join(" ")} to fail`);
}

const deps = testDeps();
let server: Server;
let base: string;
let adaToken: string;
let bobToken: string;
let adaSession: string;

beforeAll(async () => {
  const ada = createUser(deps.db, { username: "ada", password: "longenough", email: "ada@example.com" });
  const bob = createUser(deps.db, { username: "bob", password: "longenough", email: "bob@example.com" });
  adaToken = createAccessToken(deps.db, ada.id, "e2e");
  bobToken = createAccessToken(deps.db, bob.id, "e2e");
  adaSession = createSession(deps.db, ada.id).id;
  const secret = await createRepo(deps, ada, { name: "secret", description: "", isPrivate: true, initReadme: false });
  await createRepo(deps, ada, { name: "open", description: "", isPrivate: false, initReadme: true });
  addCollaborator(deps.db, secret.id, bob.id, "read");
  server = createInsitioServer(deps);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
});

const withAuth = (user: string, token: string, path: string) => base.replace("http://", `http://${user}:${token}@`) + path;

describe("matchGitRoute", () => {
  it("matches smart HTTP paths only", () => {
    expect(matchGitRoute("/ada/x.git/info/refs?service=git-upload-pack")).toMatchObject({ owner: "ada", repo: "x", service: "git-upload-pack" });
    expect(matchGitRoute("/ada/x/git-receive-pack")).toMatchObject({ repo: "x", service: "git-receive-pack" });
    expect(matchGitRoute("/ada/x.git/info/refs")).toBeNull();
    expect(matchGitRoute("/ada/x/issues")).toBeNull();
  });
});

describe("git over HTTP", () => {
  it("clones an empty private repo, pushes to it, and shows the push in the UI", async () => {
    const dir = tmpDir();
    await git(dir, "clone", "-q", withAuth("ada", adaToken, "/ada/secret.git"), "work");
    const work = join(dir, "work");
    writeFileSync(join(work, "hello.txt"), "pushed over http\n");
    await git(work, "add", "hello.txt");
    await git(work, "commit", "-q", "-m", "First push");
    await git(work, "push", "-q", "origin", "HEAD:main");

    const local = (await git(work, "rev-parse", "HEAD")).stdout.trim();
    const repo = getRepo(deps.db, "ada", "secret")!;
    expect(await gitFor(deps, repo).resolve("main")).toBe(local);

    const page = await fetch(`${base}/ada/secret/blob/main/hello.txt`, { headers: { cookie: `gfk_session=${adaSession}` } });
    expect(await page.text()).toContain("pushed over http");
  });

  it("points HEAD at the first pushed branch when it isn't main", async () => {
    const ada = getUserByName(deps.db, "ada")!;
    await createRepo(deps, ada, { name: "legacy", description: "", isPrivate: false, initReadme: false });
    const dir = tmpDir();
    await git(dir, "init", "-q", "-b", "master", "work");
    const work = join(dir, "work");
    writeFileSync(join(work, "a.txt"), "a\n");
    await git(work, "add", "a.txt");
    await git(work, "commit", "-q", "-m", "On master");
    await git(work, "push", "-q", withAuth("ada", adaToken, "/ada/legacy.git"), "master");
    expect(getRepo(deps.db, "ada", "legacy")!.defaultBranch).toBe("master");
    const home = await fetch(`${base}/ada/legacy`);
    expect(await home.text()).toContain("a.txt");
  });

  it("lets anyone clone a public repo", async () => {
    const dir = tmpDir();
    await git(dir, "clone", "-q", `${base}/ada/open.git`, "open");
    expect((await git(join(dir, "open"), "log", "--format=%s")).stdout.trim()).toBe("Initial commit");
  });

  it("refuses anonymous access to private repos and bad tokens", async () => {
    const dir = tmpDir();
    expect(await gitFails(dir, "clone", "-q", `${base}/ada/secret.git`, "a")).toMatch(/Authentication|could not read Username|terminal prompts disabled/i);
    expect(await gitFails(dir, "clone", "-q", withAuth("ada", "gfk_wrong", "/ada/secret.git"), "b")).toMatch(/Authentication failed|Invalid username or token/i);
    expect(await gitFails(dir, "clone", "-q", withAuth("ada", adaToken, "/ada/missing.git"), "c")).toMatch(/not found|404/i);
  });

  it("lets read collaborators clone but not push", async () => {
    const dir = tmpDir();
    await git(dir, "clone", "-q", withAuth("bob", bobToken, "/ada/secret.git"), "work");
    const work = join(dir, "work");
    writeFileSync(join(work, "bob.txt"), "nope\n");
    await git(work, "add", "bob.txt");
    await git(work, "commit", "-q", "-m", "Bob tries");
    expect(await gitFails(work, "push", "-q", "origin", "HEAD:main")).toMatch(/403|denied/i);
  });
});
