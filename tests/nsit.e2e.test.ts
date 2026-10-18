import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { repoDir } from "../src/git/storage.js";
import { decideDevice, findPendingByUserCode } from "../src/services/devices.js";
import { addCollaborator, createRepo, getRepo } from "../src/services/repos.js";
import { createAccessToken, createUser, getUserByName, listAccessTokens, type User } from "../src/services/users.js";
import vitestConfig from "../vitest.config.js";
import { NSIT_TIMEOUT_MS, nsitBin, runNsit, startInsitio, startNsit, tmpDir, type Insitio, type NsitOptions, type NsitResult } from "./helpers.js";

// These tests run the real `nsit` binary against a real Insitio server in this process. Every
// run gets its own config directory, no OS credential store (NSIT_NO_KEYCHAIN=1) and none of
// the developer's NSIT_* variables, so nothing here touches their keychain or config.

// The first build compiles the vendored libgit2 and can take many minutes.
const BUILD_TIMEOUT = 15 * 60_000;
// The device flow waits one poll interval (5 s) before the first poll. The per-test timeout is
// above the 30 s default of vitest.config.ts, and the process limit stays below the test's, so a
// stuck `nsit` is killed (and reported with its output) before vitest gives up on the test.
const DEVICE_TIMEOUT = 60_000;
const DEVICE_PROCESS_TIMEOUT = 50_000;
const USER_CODE = /First copy your one-time code: ([BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4})\r?\n/;
const TOKEN_SHAPE = /ins_[A-Za-z0-9_-]{20,}/;

let ins: Insitio;
let ada: User;
/** What nsit calls this server: `127.0.0.1:<port>`. */
let hostKey: string;

// Everything nsit printed, to prove at the end that no token ever showed up in it.
const secrets = new Set<string>();
const transcript: { command: string; text: string }[] = [];

function assertNoTokens() {
  for (const { command, text } of transcript) {
    expect(text, `${command} printed something shaped like a token`).not.toMatch(TOKEN_SHAPE);
    for (const secret of secrets) expect(text, `${command} printed a token`).not.toContain(secret);
  }
}

function remember(command: string, result: NsitResult) {
  transcript.push({ command, text: `${result.stdout}\n${result.stderr}` });
  assertNoTokens();
}

async function nsit(args: string[], opts: NsitOptions = {}): Promise<NsitResult> {
  const result = await runNsit(args, opts);
  remember(`nsit ${args.join(" ")}`, result);
  return result;
}

/** `nsit auth <args> --host <this server>` */
const auth = (...args: string[]) => ["auth", ...args, "--host", ins.base];

/** A new access token for ada, as if she had made it on her settings page. */
function newToken(name = "e2e"): string {
  const token = createAccessToken(ins.deps.db, ada.id, name);
  secrets.add(token);
  return token;
}

async function signIn(configDir: string, token = newToken()): Promise<string> {
  const result = await nsit(auth("login", "--with-token"), { configDir, input: token });
  expect(result.code, result.stderr).toBe(0);
  return token;
}

async function statusJson(configDir: string, env: NsitOptions["env"] = {}) {
  const result = await nsit(auth("status", "--json"), { configDir, env });
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

/** The HTTP status the server gives this token on a call that needs one. */
async function tokenStatus(token: string): Promise<number> {
  const response = await fetch(`${ins.base}/api/v1/user`, { headers: { authorization: `Bearer ${token}` } });
  return response.status;
}

const files = (dir: string) => readdirSync(dir);
const oneLine = (text: string) => text.trimEnd().split("\n").length === 1;
/** The bare repository on the server's disk: what the server really has, for real git to read. */
const serverRepo = (owner: string, name: string) => repoDir(ins.deps.config.dataDir, owner, name);

beforeAll(async () => {
  await nsitBin();
  ins = await startInsitio();
  hostKey = new URL(ins.base).host;
  ada = createUser(ins.deps.db, { username: "ada", password: "longenough", email: "ada@example.com", displayName: "Ada Lovelace" });
}, BUILD_TIMEOUT);

afterAll(async () => {
  try {
    assertNoTokens();
  } finally {
    await ins?.close();
  }
});

describe("nsit auth login --with-token", () => {
  it("reads the token from stdin; status then shows the account and where the token is kept", async () => {
    const configDir = tmpDir();
    const token = newToken();
    const login = await nsit(auth("login", "--with-token"), { configDir, input: token });
    expect(login.code, login.stderr).toBe(0);
    expect(login.stdout).toBe(`Signed in to ${hostKey} as ada.\n`);
    // No OS credential store here, so the token went to a file, and nsit said so.
    expect(login.stderr).toContain("no OS credential store");
    expect(login.stderr).toContain(join(configDir, "tokens.toml"));

    const status = await statusJson(configDir);
    expect(status).toEqual({ host: hostKey, user: "ada", token_source: "File" });

    // The config remembers who, never the token; the token file holds it.
    const config = readFileSync(join(configDir, "nsit.toml"), "utf8");
    expect(config).toContain('user = "ada"');
    expect(config).toContain('name = "Ada Lovelace"');
    expect(config).toContain('email = "ada@example.com"');
    expect(config).not.toContain(token);
    expect(readFileSync(join(configDir, "tokens.toml"), "utf8")).toContain(token);
  });

  it("trims whitespace around the token", async () => {
    const configDir = tmpDir();
    const token = newToken();
    const login = await nsit(auth("login", "--with-token"), { configDir, input: `\n  ${token} \r\n` });
    expect(login.code, login.stderr).toBe(0);
    expect((await statusJson(configDir)).user).toBe("ada");
  });

  it("ignores a leading UTF-8 byte-order mark, as Windows PowerShell and editors write one", async () => {
    const configDir = tmpDir();
    const login = await nsit(auth("login", "--with-token"), { configDir, input: `\uFEFF${newToken()}\r\n` });
    expect(login.code, login.stderr).toBe(0);
    expect((await statusJson(configDir)).user).toBe("ada");
  });

  it("rejects empty input and anything that cannot be one token (exit 2), storing nothing", async () => {
    for (const input of ["", "   \r\n", "ins_one ins_two", "ins_one\nins_two\n"]) {
      const configDir = tmpDir();
      const result = await nsit(auth("login", "--with-token"), { configDir, input });
      expect(result.code, `input ${JSON.stringify(input)}: ${result.stderr}`).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/^nsit: /);
      expect(oneLine(result.stderr), result.stderr).toBe(true);
      expect(files(configDir)).toEqual([]);
    }
  });

  it("never takes the token as an argument (exit 2)", async () => {
    for (const args of [["--token", "ins_abc"], ["--with-token", "ins_abc"], ["ins_abc"]]) {
      const configDir = tmpDir();
      const result = await nsit(auth("login", ...args), { configDir });
      expect(result.code, `login ${args.join(" ")}: ${result.stderr}`).toBe(2);
      expect(result.stdout).toBe("");
      expect(files(configDir)).toEqual([]);
    }
  });

  it("a token the server does not accept exits 3 and stores nothing", async () => {
    const configDir = tmpDir();
    const login = await nsit(auth("login", "--with-token"), { configDir, input: "ins_this-token-was-never-issued-0000000000\n" });
    expect(login.code, login.stderr).toBe(3);
    expect(login.stdout).toBe("");
    expect(login.stderr).toMatch(/^nsit: /);
    expect(oneLine(login.stderr), login.stderr).toBe(true);
    expect(files(configDir)).toEqual([]);

    const status = await nsit(auth("status"), { configDir });
    expect(status.code).toBe(3);
  });

  it("warns that NSIT_TOKEN, when set, takes precedence over the token it just saved", async () => {
    const configDir = tmpDir();
    const login = await nsit(auth("login", "--with-token"), { configDir, input: newToken(), env: { NSIT_TOKEN: newToken("env") } });
    expect(login.code, login.stderr).toBe(0);
    expect(login.stderr).toMatch(/warning: NSIT_TOKEN is set/);
  });
});

describe("the nsit test helpers", () => {
  it("give a run less time than vitest gives a test, and kill a nsit that does not finish", async () => {
    expect(NSIT_TIMEOUT_MS).toBeLessThan(vitestConfig.test?.testTimeout ?? 5_000);

    // --with-token reads stdin, and the open, silent pipe makes that wait for ever.
    const started = Date.now();
    await expect(runNsit(auth("login", "--with-token"), { stdin: "open", timeoutMs: 1_000 })).rejects.toThrow(/did not finish in 1000 ms/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("nsit auth status", () => {
  it("with nothing stored exits 3 at once with a sign-in hint, never waiting for input", async () => {
    for (const extra of [[], ["--json"]]) {
      const result = await nsit([...auth("status"), ...extra], { stdin: "open", timeoutMs: 20_000 });
      expect(result.code, result.stderr).toBe(3);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`nsit: not signed in to ${hostKey}; run nsit auth login\n`);
    }
  });

  it("--jq .user prints the user name", async () => {
    const configDir = tmpDir();
    await signIn(configDir);
    const result = await nsit(auth("status", "--jq", ".user"), { configDir });
    expect(result.code, result.stderr).toBe(0);
    // gh's rule: a string result is printed as its text, without quotes.
    expect(result.stdout).toBe("ada\n");
  });

  it("prints a readable line without --json, and never the token", async () => {
    const configDir = tmpDir();
    const token = await signIn(configDir);
    const text = await nsit(auth("status"), { configDir });
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toBe(`Signed in to ${hostKey} as ada; token from the token file.\n`);
    const json = await nsit(auth("status", "--json"), { configDir });
    expect(Object.keys(JSON.parse(json.stdout)).sort()).toEqual(["host", "token_source", "user"]);
    for (const out of [text, json]) {
      expect(out.stdout + out.stderr).not.toContain(token);
    }
  });

  it("a token from NSIT_TOKEN is checked with the server and reported as Env", async () => {
    const token = newToken("agent");
    const status = await statusJson(tmpDir(), { NSIT_TOKEN: token });
    expect(status).toEqual({ host: hostKey, user: "ada", token_source: "Env" });
  });

  it("an NSIT_TOKEN the server does not accept exits 3", async () => {
    const result = await nsit(auth("status"), { env: { NSIT_TOKEN: "ins_this-token-was-never-issued-0000000000" } });
    expect(result.code, result.stderr).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("NSIT_TOKEN");
    expect(oneLine(result.stderr), result.stderr).toBe(true);
  });

  it("a saved token the server has since revoked exits 3", async () => {
    const configDir = tmpDir();
    const token = await signIn(configDir);
    const revoke = await fetch(`${ins.base}/api/v1/user/tokens/current`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    expect(revoke.status).toBe(204);
    const status = await nsit(auth("status"), { configDir });
    expect(status.code, status.stderr).toBe(3);
    expect(status.stdout).toBe("");
    expect(status.stderr).toContain("nsit auth login");
  });
});

describe("nsit auth login (device flow)", () => {
  // Each takes about one poll interval (5 s); they do not share anything, so they run together.

  it.concurrent(
    "approving the one-time code signs in, with no prompt and no stdin",
    async () => {
      const configDir = tmpDir();
      // stdin is an open pipe that is never written to: any attempt to read it would hang.
      const proc = await startNsit(auth("login"), { configDir, stdin: "open", timeoutMs: DEVICE_PROCESS_TIMEOUT });
      try {
        const [, userCode] = await proc.waitForStderr(USER_CODE);
        const pending = findPendingByUserCode(ins.deps.db, userCode!);
        expect(pending, "the server should know the code nsit printed").not.toBeNull();
        expect(decideDevice(ins.deps.db, pending!.id, ada.id, true)).toBe(true);

        const login = await proc.done;
        remember("nsit auth login", login);
        expect(login.code, login.stderr).toBe(0);
        expect(login.stdout).toBe(`Signed in to ${hostKey} as ada.\n`);
        // The URL is the one this server hands out, built from its (test-set) base URL.
        expect(login.stderr).toContain(`Then open: ${ins.base}/login/device\n`);
      } finally {
        proc.kill();
      }

      // The token the server minted is on disk, named after this machine, and works.
      const tokenFile = readFileSync(join(configDir, "tokens.toml"), "utf8");
      const minted = TOKEN_SHAPE.exec(tokenFile)?.[0];
      expect(minted).toBeDefined();
      secrets.add(minted!);
      expect(await tokenStatus(minted!)).toBe(200);
      expect(listAccessTokens(ins.deps.db, ada.id).some((t) => t.name.startsWith("nsit on "))).toBe(true);

      const status = await statusJson(configDir);
      expect(status).toEqual({ host: hostKey, user: "ada", token_source: "File" });
    },
    DEVICE_TIMEOUT,
  );

  it.concurrent(
    "denying the one-time code exits 3 and stores nothing",
    async () => {
      const configDir = tmpDir();
      const proc = await startNsit(auth("login"), { configDir, timeoutMs: DEVICE_PROCESS_TIMEOUT });
      try {
        const [, userCode] = await proc.waitForStderr(USER_CODE);
        const pending = findPendingByUserCode(ins.deps.db, userCode!);
        expect(pending).not.toBeNull();
        expect(decideDevice(ins.deps.db, pending!.id, ada.id, false)).toBe(true);

        const login = await proc.done;
        remember("nsit auth login (denied)", login);
        expect(login.code, login.stderr).toBe(3);
        expect(login.stdout).toBe("");
        expect(login.stderr).toMatch(/nsit: .*denied/);
      } finally {
        proc.kill();
      }
      expect(files(configDir)).toEqual([]);
      const status = await nsit(auth("status"), { configDir });
      expect(status.code).toBe(3);
    },
    DEVICE_TIMEOUT,
  );
});

describe("nsit auth logout", () => {
  it("revokes the token on the server and forgets it here; status then exits 3", async () => {
    const configDir = tmpDir();
    const token = await signIn(configDir);
    expect(await tokenStatus(token)).toBe(200);

    const logout = await nsit(auth("logout"), { configDir });
    expect(logout.code, logout.stderr).toBe(0);
    expect(logout.stdout).toBe(`Signed out of ${hostKey}; the token was revoked.\n`);

    expect(await tokenStatus(token)).toBe(401);
    expect(existsSync(join(configDir, "tokens.toml"))).toBe(false);
    expect(readFileSync(join(configDir, "nsit.toml"), "utf8")).not.toContain("ada");
    const status = await nsit(auth("status"), { configDir });
    expect(status.code, status.stderr).toBe(3);
  });

  it("reports what it did with --json", async () => {
    const configDir = tmpDir();
    await signIn(configDir);
    const logout = await nsit(auth("logout", "--json"), { configDir });
    expect(logout.code, logout.stderr).toBe(0);
    expect(JSON.parse(logout.stdout)).toEqual({ host: hostKey, user: "ada", revoked: true });
  });

  it("signing out twice: the second time there is nothing to sign out of (exit 3)", async () => {
    const configDir = tmpDir();
    await signIn(configDir);
    expect((await nsit(auth("logout"), { configDir })).code).toBe(0);
    const again = await nsit(auth("logout"), { configDir });
    expect(again.code, again.stderr).toBe(3);
    expect(again.stdout).toBe("");
    expect(again.stderr).toBe(`nsit: not signed in to ${hostKey}; nothing to sign out of\n`);
  });

  it("still signs out here when the server had already revoked the token", async () => {
    const configDir = tmpDir();
    const token = await signIn(configDir);
    await fetch(`${ins.base}/api/v1/user/tokens/current`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });

    const logout = await nsit(auth("logout"), { configDir });
    expect(logout.code, logout.stderr).toBe(0);
    expect(logout.stdout).toBe(`Signed out of ${hostKey}; the token had already been revoked.\n`);
    expect(existsSync(join(configDir, "tokens.toml"))).toBe(false);
  });

  it("when the server cannot be reached: forgets the token here anyway, exits 1 and says it stays valid", async () => {
    const gone = await startInsitio();
    try {
      const user = createUser(gone.deps.db, { username: "ada", password: "longenough", email: "ada@example.com" });
      const token = createAccessToken(gone.deps.db, user.id, "e2e");
      secrets.add(token);
      const configDir = tmpDir();
      const login = await nsit(["auth", "login", "--with-token", "--host", gone.base], { configDir, input: token });
      expect(login.code, login.stderr).toBe(0);
      await gone.close();

      const logout = await nsit(["auth", "logout", "--host", gone.base], { configDir });
      expect(logout.code, logout.stderr).toBe(1);
      expect(logout.stdout).toBe("");
      expect(logout.stderr).toMatch(/^nsit: .*could not be revoked.*stays valid/);
      expect(oneLine(logout.stderr), logout.stderr).toBe(true);

      // The local copy is gone either way.
      expect(existsSync(join(configDir, "tokens.toml"))).toBe(false);
      const status = await nsit(["auth", "status", "--host", gone.base], { configDir });
      expect(status.code, status.stderr).toBe(3);
    } finally {
      await gone.close();
    }
  });

  it("a token that cannot be read still fails with the original reason (exit 1), and keeps the account so logout can be retried", async () => {
    const configDir = tmpDir();
    const token = await signIn(configDir);
    writeFileSync(join(configDir, "tokens.toml"), "this is [not toml");

    const logout = await nsit(auth("logout"), { configDir });
    expect(logout.code, logout.stderr).toBe(1);
    expect(logout.stdout).toBe("");
    expect(logout.stderr).toMatch(/^nsit: .*not a valid token file/);
    expect(oneLine(logout.stderr), logout.stderr).toBe(true);
    // The token could not even be read, so it was not revoked; nothing was thrown away.
    expect(await tokenStatus(token)).toBe(200);
    expect(readFileSync(join(configDir, "nsit.toml"), "utf8")).toContain('user = "ada"');

    // Once the file is out of the way, logout can run again and finish the job.
    rmSync(join(configDir, "tokens.toml"));
    const again = await nsit(auth("logout"), { configDir });
    expect(again.code, again.stderr).toBe(0);
    expect(readFileSync(join(configDir, "nsit.toml"), "utf8")).not.toContain("ada");
  });

  it("refuses while NSIT_TOKEN is set (exit 2) and revokes nothing", async () => {
    const configDir = tmpDir();
    const saved = await signIn(configDir);
    const fromEnv = newToken("env");

    const logout = await nsit(auth("logout"), { configDir, env: { NSIT_TOKEN: fromEnv } });
    expect(logout.code, logout.stderr).toBe(2);
    expect(logout.stdout).toBe("");
    expect(logout.stderr).toContain("NSIT_TOKEN");
    expect(oneLine(logout.stderr), logout.stderr).toBe(true);

    // Neither token was revoked, and the saved one is still saved.
    expect(await tokenStatus(fromEnv)).toBe(200);
    expect(await tokenStatus(saved)).toBe(200);
    expect(await statusJson(configDir)).toEqual({ host: hostKey, user: "ada", token_source: "File" });
  });
});

describe("nsit repo", () => {
  // The two users each have their own signed-in config directory. The tests run in this order
  // and share the server: ada's `tools` (private) is made first, `open` (public) later.
  let grace: User;
  let adaDir: string;
  let adaToken: string;
  let graceDir: string;

  const repo = (...args: string[]) => ["repo", ...args, "--host", ins.base];
  const REPO_FIELDS = ["clone_url", "created_at", "default_branch", "description", "full_name", "html_url", "name", "owner", "private"];

  async function serverJson(path: string, token: string) {
    const response = await fetch(`${ins.base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    return response.json();
  }

  beforeAll(async () => {
    grace = createUser(ins.deps.db, { username: "grace", password: "longenough", email: "grace@example.com" });
    adaDir = tmpDir();
    adaToken = await signIn(adaDir);
    graceDir = tmpDir();
    const graceToken = createAccessToken(ins.deps.db, grace.id, "e2e");
    secrets.add(graceToken);
    await signIn(graceDir, graceToken);
  });

  it("signed out, with stdin an open pipe: exits 3 within 5 s with a sign-in hint and never waits for input (Review Focus 2)", async () => {
    for (const args of [["list"], ["list", "--json"], ["list", "--owner", "ada"], ["create", "tools"], ["view", "ada/tools"], ["view", "tools"]]) {
      const started = performance.now();
      // No NSIT_TOKEN (the test environment removes it), no config, stdin open and silent: a read would hang.
      const result = await nsit(repo(...args), { stdin: "open", timeoutMs: 5_000 });
      const elapsed = performance.now() - started;
      expect(result.code, `repo ${args.join(" ")}: ${result.stderr}`).toBe(3);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("nsit auth login");
      expect(result.stderr).toBe(`nsit: not signed in to ${hostKey}; run nsit auth login\n`);
      expect(elapsed, `repo ${args.join(" ")} took ${elapsed} ms`).toBeLessThan(5_000);
    }
  });

  it("with no repositories: [] for --json, and a note on stderr (not stdout) that -q silences", async () => {
    const json = await nsit(repo("list", "--json"), { configDir: graceDir });
    expect(json.code, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual([]);

    const human = await nsit(repo("list"), { configDir: graceDir });
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toBe("");
    expect(human.stderr).toBe("No repositories.\n");

    const quiet = await nsit(repo("list", "-q"), { configDir: graceDir });
    expect(quiet.code).toBe(0);
    expect(quiet.stdout + quiet.stderr).toBe("");
  });

  it("create makes a private repository by default and prints where it is", async () => {
    const result = await nsit(repo("create", "tools"), { configDir: adaDir });
    expect(result.code, result.stderr).toBe(0);
    const row = getRepo(ins.deps.db, "ada", "tools");
    expect(row, "the server should have ada/tools").not.toBeNull();
    expect(row!.isPrivate).toBe(true);
    expect(result.stdout).toContain("Created ada/tools (private).");
    expect(result.stdout).toContain(`${ins.base}/ada/tools\n`);
    expect(result.stdout).toContain(`${ins.base}/ada/tools.git`);
    expect(result.stderr).toBe("");
  });

  it("list --json --jq '.[].name' prints the names", async () => {
    const result = await nsit(repo("list", "--json", "--jq", ".[].name"), { configDir: adaDir });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe("tools\n");
  });

  it("--jq prints strings raw and everything else as compact JSON, one result per line", async () => {
    const run = async (expr: string) => {
      const result = await nsit(repo("view", "ada/tools", "--jq", expr), { configDir: adaDir });
      expect(result.code, `${expr}: ${result.stderr}`).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    expect(await run(".name, .private, .description, .default_branch")).toBe("tools\ntrue\n\nmain\n");
    expect(await run("[.name, .private]")).toBe('["tools",true]\n');
    expect(await run("{name, private}")).toBe('{"name":"tools","private":true}\n');
    expect(await run(".missing")).toBe("null\n");
    expect(await run('"owner is " + .owner')).toBe("owner is ada\n");
  });

  it("list prints an aligned table; --json is the server's own fields, unchanged", async () => {
    const table = await nsit(repo("list"), { configDir: adaDir });
    expect(table.code, table.stderr).toBe(0);
    const [header, row, ...rest] = table.stdout.trimEnd().split("\n");
    expect(rest).toEqual([]);
    expect(header).toMatch(/^NAME\s+VISIBILITY\s+DESCRIPTION$/);
    expect(row).toMatch(/^ada\/tools\s+private$/);
    expect(row!.indexOf("private")).toBe(header!.indexOf("VISIBILITY"));
    expect(table.stdout).not.toContain("\u001b");

    const json = await nsit(repo("list", "--json"), { configDir: adaDir });
    const parsed = JSON.parse(json.stdout);
    expect(parsed).toEqual(await serverJson("/repos", adaToken));
    expect(Object.keys(parsed[0]).sort()).toEqual(REPO_FIELDS);
  });

  it("creating a name that is taken exits 1 with the server's message and prints nothing", async () => {
    const result = await nsit(repo("create", "tools"), { configDir: adaDir });
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("nsit: Repository ada/tools already exists\n");
  });

  it("create --public --description makes a public repository; --json is the server's fields", async () => {
    const result = await nsit(repo("create", "open", "--public", "--description", "Open source", "--json"), { configDir: adaDir });
    expect(result.code, result.stderr).toBe(0);
    const made = JSON.parse(result.stdout);
    expect(Object.keys(made).sort()).toEqual(REPO_FIELDS);
    expect(made).toMatchObject({ owner: "ada", name: "open", full_name: "ada/open", private: false, description: "Open source" });
    expect(made.clone_url).toBe(`${ins.base}/ada/open.git`);
    const row = getRepo(ins.deps.db, "ada", "open");
    expect(row).toMatchObject({ isPrivate: false, description: "Open source" });
  });

  it("names the server would refuse are usage errors (exit 2) and create nothing", async () => {
    for (const name of ["bad name", "tools.git", "a/b", ".."]) {
      const result = await nsit(repo("create", name), { configDir: adaDir });
      expect(result.code, `create ${JSON.stringify(name)}: ${result.stderr}`).toBe(2);
      expect(result.stdout).toBe("");
      expect(oneLine(result.stderr), result.stderr).toBe(true);
    }
    expect(getRepo(ins.deps.db, "ada", "bad name")).toBeNull();
    expect(getRepo(ins.deps.db, "ada", "tools")!.isPrivate).toBe(true);
  });

  it("view shows a repository by owner/name, by bare name (yours), and by URL", async () => {
    const byPair = await nsit(repo("view", "ada/tools", "--json"), { configDir: adaDir });
    expect(byPair.code, byPair.stderr).toBe(0);
    expect(JSON.parse(byPair.stdout)).toEqual(await serverJson("/repos/ada/tools", adaToken));

    const bare = await nsit(repo("view", "tools"), { configDir: adaDir });
    expect(bare.code, bare.stderr).toBe(0);
    expect(bare.stdout).toContain("ada/tools (private)");
    expect(bare.stdout).toContain(`${ins.base}/ada/tools.git`);
    expect(bare.stdout).toMatch(/default branch: main/);

    for (const input of [`${ins.base}/ada/tools.git`, `${ins.base}/ada/tools`, "ada/tools.git"]) {
      const result = await nsit(repo("view", input, "--jq", ".full_name"), { configDir: adaDir });
      expect(result.code, `${input}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toBe("ada/tools\n");
    }
  });

  it("view of a repository that is missing, or private to someone else, is the same exit-1 message", async () => {
    const hidden = await nsit(repo("view", "ada/tools"), { configDir: graceDir });
    const missing = await nsit(repo("view", "ada/does-not-exist"), { configDir: graceDir });
    const bareMissing = await nsit(repo("view", "tools"), { configDir: graceDir });
    for (const result of [hidden, missing, bareMissing]) {
      expect(result.code, result.stderr).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("nsit: repository not found or no access\n");
    }
    // A public repository is visible to everyone.
    const open = await nsit(repo("view", "ada/open"), { configDir: graceDir });
    expect(open.code, open.stderr).toBe(0);
    expect(open.stdout).toContain("ada/open (public)");
    expect(open.stdout).toContain("Open source");
  });

  it("view with something that is not a repository is a usage error (exit 2)", async () => {
    for (const input of ["a/b/c", "https://example.com/", `${ins.base}/ada/tools/tree/main`, "ro cket"]) {
      const result = await nsit(repo("view", input), { configDir: adaDir });
      expect(result.code, `view ${JSON.stringify(input)}: ${result.stderr}`).toBe(2);
      expect(result.stdout).toBe("");
      expect(oneLine(result.stderr), result.stderr).toBe(true);
    }
  });

  it("list --owner shows only what the caller may see of that owner's repositories", async () => {
    const asGrace = await nsit(repo("list", "--owner", "ada", "--jq", ".[].full_name"), { configDir: graceDir });
    expect(asGrace.code, asGrace.stderr).toBe(0);
    expect(asGrace.stdout).toBe("ada/open\n");

    const asAda = await nsit(repo("list", "--owner", "ada", "--jq", ".[].full_name"), { configDir: adaDir });
    expect(asAda.code, asAda.stderr).toBe(0);
    expect(asAda.stdout.trimEnd().split("\n").sort()).toEqual(["ada/open", "ada/tools"]);

    const nobody = await nsit(repo("list", "--owner", "nobody"), { configDir: adaDir });
    expect(nobody.code, nobody.stderr).toBe(1);
    expect(nobody.stderr).toBe("nsit: User nobody not found\n");
  });

  it("works with only NSIT_TOKEN: the account is asked of the server, and NSIT_TOKEN's owner wins over the saved account", async () => {
    // No config at all: a bare name is resolved with the owner of the token.
    const agent = newToken("agent");
    const bare = await nsit(repo("view", "tools"), { env: { NSIT_TOKEN: agent } });
    expect(bare.code, bare.stderr).toBe(0);
    expect(bare.stdout).toContain("ada/tools (private)");

    const made = await nsit(repo("create", "agent-made"), { env: { NSIT_TOKEN: agent } });
    expect(made.code, made.stderr).toBe(0);
    expect(getRepo(ins.deps.db, "ada", "agent-made")!.isPrivate).toBe(true);

    // Signed in as ada, but NSIT_TOKEN is grace's: "tools" now means grace/tools.
    const graceToken = createAccessToken(ins.deps.db, grace.id, "agent");
    secrets.add(graceToken);
    const mixed = await nsit(repo("view", "tools"), { configDir: adaDir, env: { NSIT_TOKEN: graceToken } });
    expect(mixed.code, mixed.stderr).toBe(1);
    expect(mixed.stderr).toBe("nsit: repository not found or no access\n");
  });

  it("NSIT_TOKEN is not sent to a server other than the selected one, even when a URL names it (exit 3)", async () => {
    const agent = newToken("agent");
    const result = await nsit(repo("view", "https://other.example/ada/tools"), { env: { NSIT_TOKEN: agent }, timeoutMs: 5_000 });
    expect(result.code, result.stderr).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("NSIT_TOKEN");
    expect(result.stderr).toBe("nsit: NSIT_TOKEN is sent only to the selected host, and other.example is not it\n");
    expect(result.stderr).not.toContain("--host");
    expect(oneLine(result.stderr), result.stderr).toBe(true);
  });

  it("never prints a token, in the output or in an error", async () => {
    // Every command above ran through `nsit()`, which scans its transcript; this adds the odd ones.
    const odd = await nsit(repo("view", `https://ada:${adaToken}@other.example/ada/tools`), { configDir: adaDir, timeoutMs: 5_000 });
    expect(odd.code, odd.stderr).toBe(2);
    expect(odd.stdout + odd.stderr).not.toContain(adaToken);
    const bad = await nsit(["repo", "list", "--host", `http://ada:${adaToken}@127.0.0.1:9`], { configDir: adaDir, timeoutMs: 5_000 });
    expect(bad.code, bad.stderr).toBe(2);
    expect(bad.stdout + bad.stderr).not.toContain(adaToken);
  });
});

// ---- the local commands, and real git on what they make --------------------------------------

const execFileAsync = promisify(execFile);

/**
 * The "home" the nsit processes see. libgit2 looks for ~/.gitconfig (HOME, or USERPROFILE on
 * Windows) and does not read GIT_CONFIG_GLOBAL, so this is how a test gives nsit a git identity,
 * and keeps the developer's own git configuration out. `autocrlf` is off unless asked for, so
 * file contents are exactly what the test wrote.
 */
function homeWith(identity: boolean, autocrlf = false): Record<string, string | undefined> {
  const home = tmpDir();
  const user = identity ? "[user]\n\tname = Local Tester\n\temail = tester@example.com\n" : "";
  writeFileSync(join(home, ".gitconfig"), `${user}[core]\n\tautocrlf = ${autocrlf}\n`);
  return { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: undefined };
}

// An isolated real git (the pattern of githttp.e2e.test.ts): no system or global configuration
// but its own, no credential helper, no prompts. Git is only ever used here, to check nsit's work.
const gitHome = tmpDir();
const gitGlobalConfig = join(gitHome, "gitconfig");
writeFileSync(gitGlobalConfig, "[user]\n\tname = Real Git\n\temail = git@example.com\n[init]\n\tdefaultBranch = main\n");
const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: gitGlobalConfig,
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  // Git's own sentences ("You have unmerged paths") are matched below: always the English ones.
  LC_ALL: "C",
  LANGUAGE: "C",
};

/** Runs real git in `cwd` and returns stdout; rejects, with git's own words, when git fails. */
async function realGit(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-c", "credential.helper=", "-c", "core.autocrlf=false", "-c", "core.quotepath=false", ...args], {
      cwd,
      env: gitEnv,
      encoding: "utf8",
    });
    return stdout;
  } catch (err) {
    const { stderr } = err as { stderr?: string };
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr ?? err}`);
  }
}

describe("nsit local commands and real git", () => {
  it("init --readme and two commits make a repository that git fsck --strict accepts and git reads the same way", async () => {
    // Review Focus 1 as well: a directory with spaces and an accent, and an accented file name.
    const dir = join(tmpDir(), "Vidéo Ink - OG Edition");
    mkdirSync(dir);
    const env = homeWith(true);
    const run = async (...args: string[]) => {
      const result = await nsit(["-C", dir, ...args], { env });
      expect(result.code, `nsit ${args.join(" ")}: ${result.stderr}`).toBe(0);
      return result;
    };

    await run("init", "--readme");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "notes.txt"), "first notes\n");
    writeFileSync(join(dir, "src", "ünï côdé.txt"), "accented\n");
    await run("commit", "-m", "Add notes");
    writeFileSync(join(dir, "notes.txt"), "second notes\n");
    await run("commit", "-m", "Edit notes");

    await realGit(dir, "fsck", "--strict"); // exits non-zero on any problem
    expect((await realGit(dir, "log", "--format=%s")).trimEnd().split("\n")).toEqual(["Edit notes", "Add notes", "Initial commit"]);
    expect((await realGit(dir, "log", "-1", "--format=%an <%ae>")).trim()).toBe("Local Tester <tester@example.com>");
    expect((await realGit(dir, "branch", "--show-current")).trim()).toBe("main");
    expect((await realGit(dir, "ls-tree", "-r", "--name-only", "-z", "HEAD")).split("\0").filter(Boolean)).toEqual(["README.md", "notes.txt", "src/ünï côdé.txt"]);
    expect(await realGit(dir, "show", "HEAD:notes.txt")).toBe("second notes\n");
    expect(await realGit(dir, "show", "HEAD:src/ünï côdé.txt")).toBe("accented\n");
    // Git agrees that nothing is left to commit: nsit wrote the index the way git reads it.
    expect(await realGit(dir, "status", "--porcelain")).toBe("");
  });

  it("works on a repository made by real git: a clean status, and a commit that lands in git's history", async () => {
    const dir = tmpDir();
    await realGit(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "one\n");
    await realGit(dir, "add", "a.txt");
    await realGit(dir, "commit", "-q", "-m", "From git");
    const env = homeWith(true);

    const clean = await nsit(["-C", dir, "status", "--json"], { env });
    expect(clean.code, clean.stderr).toBe(0);
    expect(JSON.parse(clean.stdout)).toEqual({ branch: "main", upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [] });

    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "b.txt"), "new\n");
    const committed = await nsit(["-C", dir, "commit", "-m", "From nsit", "--json"], { env });
    expect(committed.code, committed.stderr).toBe(0);
    expect(JSON.parse(committed.stdout).files).toEqual(["a.txt", "b.txt"]);

    await realGit(dir, "fsck", "--strict");
    expect((await realGit(dir, "log", "--format=%s")).trimEnd().split("\n")).toEqual(["From nsit", "From git"]);
    expect(await realGit(dir, "status", "--porcelain")).toBe("");
    const log = await nsit(["-C", dir, "log", "--json"], { env });
    expect(JSON.parse(log.stdout).map((e: { subject: string }) => e.subject)).toEqual(["From nsit", "From git"]);
  });

  it("a commit refused by the secret guard leaves nothing for git to see but the untracked file", async () => {
    const dir = tmpDir();
    const env = homeWith(true);
    expect((await nsit(["-C", dir, "init"], { env })).code).toBe(0);
    writeFileSync(join(dir, "a.txt"), "one\n");
    writeFileSync(join(dir, ".env"), "TOKEN=abc\n");
    const refused = await nsit(["-C", dir, "commit", "-m", "x"], { env });
    expect(refused.code, refused.stderr).toBe(5);
    expect(refused.stderr).toContain(".env");
    expect(refused.stdout).toBe("");
    // The index is as it was (no entries), so real git sees both files as untracked and no commit.
    expect((await realGit(dir, "status", "--porcelain")).split("\n").filter(Boolean).sort()).toEqual(["?? .env", "?? a.txt"]);
    await expect(realGit(dir, "rev-parse", "--verify", "HEAD")).rejects.toThrow();
  });
});

describe("nsit init <name> against a server", () => {
  let configDir: string;

  beforeAll(async () => {
    configDir = tmpDir();
    await signIn(configDir);
  });

  it("creates the private repository, makes origin its plain clone URL, and commits the README", async () => {
    const cwd = tmpDir();
    // No git identity: the commit is by the account nsit signed in with.
    const env = homeWith(false);
    const made = await nsit(["init", "demo", "--readme", "--json", "--host", ins.base], { cwd, configDir, env });
    expect(made.code, made.stderr).toBe(0);
    const json = JSON.parse(made.stdout);
    expect(json).toMatchObject({
      created: true,
      branch: "main",
      readme: true,
      // The first commit is pushed as part of init: the repository is not left half made.
      pushed: true,
      remote: { owner: "ada", name: "demo", clone_url: `${ins.base}/ada/demo.git`, private: true, created: true },
    });
    expect(json.commit).toMatch(/^[0-9a-f]{40}$/);

    const row = getRepo(ins.deps.db, "ada", "demo");
    expect(row, "the server should have ada/demo").not.toBeNull();
    expect(row!.isPrivate).toBe(true);

    const repoDir = join(cwd, "demo");
    const config = readFileSync(join(repoDir, ".git", "config"), "utf8");
    expect(config).toContain(`url = ${ins.base}/ada/demo.git`);
    expect(config, "no token in .git/config").not.toMatch(/ins_/);
    expect(config, "no user name or token in the URL").not.toMatch(/\/\/[^/\s]*@/);
    expect(readFileSync(join(repoDir, "README.md"), "utf8")).toContain("nsit clone ada/demo");
    expect((await realGit(repoDir, "log", "--format=%s")).trim()).toBe("Initial commit");
    expect((await realGit(repoDir, "remote", "get-url", "origin")).trim()).toBe(`${ins.base}/ada/demo.git`);
    await realGit(repoDir, "fsck", "--strict");

    // The server has the commit: real git, asked about the bare repository on the server's disk.
    const bare = serverRepo("ada", "demo");
    expect(await realGit(cwd, "ls-remote", bare)).toContain(`${json.commit}\trefs/heads/main`);
    expect((await realGit(bare, "rev-parse", "refs/heads/main")).trim()).toBe(json.commit);
    expect((await realGit(bare, "log", "--format=%s", "refs/heads/main")).trim()).toBe("Initial commit");
    await realGit(bare, "fsck", "--strict");
    // The branch tracks what was pushed, so status and later pushes need no setup.
    expect((await realGit(repoDir, "rev-parse", "refs/remotes/origin/main")).trim()).toBe(json.commit);
    expect((await realGit(repoDir, "config", "branch.main.remote")).trim()).toBe("origin");
    expect((await realGit(repoDir, "config", "branch.main.merge")).trim()).toBe("refs/heads/main");
    const status = await nsit(["-C", repoDir, "status", "--json"], { env });
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 0, behind: 0 });
    // Nothing of the token is anywhere in what the push wrote.
    for (const file of filesUnder(join(repoDir, ".git"))) {
      for (const secret of secrets) expect(readFileSync(file).includes(secret), `a token is in ${file}`).toBe(false);
    }
    expect(made.stderr, "no progress or notes off a terminal").toBe("");
  });

  it("without --readme there is no commit, so init says it pushed nothing and succeeds", async () => {
    const cwd = tmpDir();
    const result = await nsit(["init", "no-commits", "--json", "--host", ins.base], { cwd, configDir, env: homeWith(false) });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ commit: null, pushed: false });
    expect(result.stderr).toMatch(/nothing was pushed/);
    expect(await realGit(serverRepo("ada", "no-commits"), "for-each-ref")).toBe("");
  });

  it("when the first push fails the repository and its commit stay, and the error says how to go on", async () => {
    // The server knows the repository, but by the time the push reaches its git endpoint the bare
    // repository on disk is gone. The hook runs before the server's own handler for the same
    // request, so this is deterministic: init creates the repository over the API, and only then
    // does the push find nothing behind it.
    const cwd = tmpDir();
    const env = homeWith(false);
    const bare = serverRepo("ada", "pushless");
    const breakIt = (req: IncomingMessage) => {
      if (req.url?.startsWith("/ada/pushless.git/info/refs")) rmSync(bare, { recursive: true, force: true });
    };
    ins.server.prependListener("request", breakIt);
    let result: NsitResult;
    try {
      result = await nsit(["init", "pushless", "--readme", "--host", ins.base], { cwd, configDir, env });
    } finally {
      ins.server.off("request", breakIt);
    }
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(oneLine(result.stderr), result.stderr).toBe(true);
    expect(result.stderr).toMatch(/^nsit: .*run nsit push/);
    // Nothing is lost: the repository exists on the server, origin is set, and the commit is here.
    expect(getRepo(ins.deps.db, "ada", "pushless")).not.toBeNull();
    const work = join(cwd, "pushless");
    expect((await realGit(work, "log", "--format=%s")).trim()).toBe("Initial commit");
    expect((await realGit(work, "remote", "get-url", "origin")).trim()).toBe(`${ins.base}/ada/pushless.git`);
    expect(await realGit(work, "for-each-ref", "refs/remotes")).toBe("");
  });

  it("run again, it leaves the repository and origin alone and asks the server for nothing", async () => {
    const cwd = tmpDir();
    const env = homeWith(false);
    const args = ["init", "again", "--json", "--host", ins.base];
    expect((await nsit(args, { cwd, configDir, env })).code).toBe(0);
    const second = await nsit(args, { cwd, configDir, env });
    expect(second.code, second.stderr).toBe(0);
    const json = JSON.parse(second.stdout);
    expect(json.created).toBe(false);
    expect(json.remote).toMatchObject({ created: false, clone_url: `${ins.base}/ada/again.git` });
    expect(getRepo(ins.deps.db, "ada", "again")).not.toBeNull();
  });

  it("--public makes a public repository, and --remote alone names it after the directory", async () => {
    const cwd = tmpDir();
    const env = homeWith(false);
    const pub = await nsit(["init", "open-demo", "--public", "--host", ins.base], { cwd, configDir, env });
    expect(pub.code, pub.stderr).toBe(0);
    expect(pub.stdout).toContain("Created ada/open-demo on Insitio (public)");
    expect(getRepo(ins.deps.db, "ada", "open-demo")!.isPrivate).toBe(false);

    const dir = join(cwd, "named-by-folder");
    mkdirSync(dir);
    const remote = await nsit(["-C", dir, "init", "--remote", "--host", ins.base], { configDir, env });
    expect(remote.code, remote.stderr).toBe(0);
    expect(getRepo(ins.deps.db, "ada", "named-by-folder")!.isPrivate).toBe(true);
    expect(readFileSync(join(dir, ".git", "config"), "utf8")).toContain(`url = ${ins.base}/ada/named-by-folder.git`);
  });

  it("a name the server already has is exit 1 with the server's message, and origin is not set", async () => {
    const cwd = tmpDir();
    const env = homeWith(false);
    const first = await nsit(["repo", "create", "taken", "--host", ins.base], { configDir });
    expect(first.code, first.stderr).toBe(0);
    const again = await nsit(["init", "taken", "--host", ins.base], { cwd, configDir, env });
    expect(again.code, again.stderr).toBe(1);
    expect(again.stdout).toBe("");
    expect(oneLine(again.stderr), again.stderr).toBe(true);
    // The repository made before the server said no is left in place, and the error says so.
    expect(again.stderr).toContain("without an origin; running nsit init taken again is safe");
    expect(readFileSync(join(cwd, "taken", ".git", "config"), "utf8")).not.toContain("origin");
  });

  it("a first push refused as a non-fast-forward says to run nsit pull, and does not also say to run nsit push again", async () => {
    // The directory already has history of its own, and its origin (a repository with other history).
    await seedRepo("init-diverged", { "a.txt": "base\n" });
    const dir = join(tmpDir(), "init-diverged");
    mkdirSync(dir);
    await realGit(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "mine.txt"), "mine\n");
    await realGit(dir, "add", "-A");
    await realGit(dir, "commit", "-q", "-m", "Mine");
    await realGit(dir, "remote", "add", "origin", `${ins.base}/ada/init-diverged.git`);

    const result = await nsit(["-C", dir, "init", "--remote", "--host", ins.base], { configDir, env: homeWith(false) });
    expect(result.code, result.stderr).toBe(6);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("nsit: refs/heads/main: non-fast-forward; run nsit pull\n");
  });

  it("signed out it is exit 3 at once and creates no directory", async () => {
    const cwd = tmpDir();
    const result = await nsit(["init", "nobody-home", "--host", ins.base], { cwd, env: homeWith(false), stdin: "open", timeoutMs: 5_000 });
    expect(result.code, result.stderr).toBe(3);
    expect(result.stderr).toBe(`nsit: not signed in to ${hostKey}; run nsit auth login\n`);
    expect(existsSync(join(cwd, "nobody-home"))).toBe(false);
  });
});

// ---- nsit clone --------------------------------------------------------------------------------

/** What a repository seeded on the server holds: file name to text or bytes. */
type Seed = Record<string, string | Buffer>;

/**
 * A repository ada owns on the server, holding `files` in one commit on `main`. Real git (with
 * core.autocrlf off, so the bytes are exactly these) builds the commit, and pushes it straight into
 * the bare repository on the server's disk.
 */
async function seedRepo(name: string, files: Seed, isPrivate = true): Promise<void> {
  await createRepo(ins.deps, ada, { name, description: "", isPrivate, initReadme: false });
  const work = tmpDir();
  await realGit(work, "init", "-q", "-b", "main");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), content);
  }
  await realGit(work, "add", "-A");
  await realGit(work, "commit", "-q", "-m", "Seed");
  await realGit(work, "push", "-q", repoDir(ins.deps.config.dataDir, "ada", name), "HEAD:refs/heads/main");
}

/** Real git reading `home`'s .gitconfig (and no system one): the same core.autocrlf nsit sees. */
async function gitSeeing(home: Record<string, string | undefined>, cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-c", "credential.helper=", ...args], {
      cwd,
      env: { ...gitEnv, GIT_CONFIG_GLOBAL: join(home.HOME!, ".gitconfig") },
      encoding: "utf8",
    });
    return stdout;
  } catch (err) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${(err as { stderr?: string }).stderr ?? err}`);
  }
}

/** Every file under `dir`, as paths. */
const filesUnder = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

const same = (a: string, b: string) => realpathSync(a) === realpathSync(b);

/** A working copy made by `nsit clone`: where it is, and the environment and sign-in its nsit runs use. */
type Work = { dir: string; env: Record<string, string | undefined>; configDir: string };

/** A ref of the repository in `dir`, from real git; "" when it is not there. */
async function ref(dir: string, name: string): Promise<string> {
  try {
    return (await realGit(dir, "rev-parse", "--verify", "-q", name)).trim();
  } catch {
    return "";
  }
}

async function configValue(dir: string, key: string): Promise<string | null> {
  try {
    return (await realGit(dir, "config", "--get", key)).trim();
  } catch {
    return null;
  }
}

/** Everything a command must leave alone when it fails: all refs, HEAD and the repository's own config. */
async function snapshot(dir: string) {
  return {
    refs: await realGit(dir, "for-each-ref", "--format=%(refname) %(objectname)"),
    head: (await realGit(dir, "rev-parse", "HEAD")).trim(),
    config: readFileSync(join(dir, ".git", "config"), "utf8"),
  };
}

/** `nsit clone` of `repo` (as `owner/name`) into a fresh directory, signed in with `configDir`. */
async function cloneOf(repo: string, configDir: string, env = homeWith(true)): Promise<Work> {
  const cwd = tmpDir();
  const result = await nsit(["clone", repo, "work", "--host", ins.base], { cwd, configDir, env });
  expect(result.code, result.stderr).toBe(0);
  return { dir: join(cwd, "work"), env, configDir };
}

/** Writes `file` and commits it with `nsit commit`; returns the new HEAD. */
async function commitIn(work: Work, file: string, content: string | Buffer, message: string): Promise<string> {
  writeFileSync(join(work.dir, file), content);
  const result = await nsit(["-C", work.dir, "commit", "-m", message], { configDir: work.configDir, env: work.env });
  expect(result.code, result.stderr).toBe(0);
  return ref(work.dir, "HEAD");
}

describe("nsit clone", () => {
  const SEED: Seed = { "README.md": "# tools\n", "src/main.txt": "hello\n", "docs/ünï côdé.txt": "accented\n" };
  const CLEAN = { branch: "main", upstream: "origin/main", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [] };
  // One text file with LF, one with CRLF, and a binary that has CR LF bytes in it. Seeded once, in
  // `beforeAll`, because both the Review Focus 3 test and its autocrlf=false control clone it, and
  // each of them must also pass when it is the only test that runs.
  const CRLF_FILES: Seed = { "lf.txt": "alpha\nbeta\n", "crlf.txt": "one\r\ntwo\r\n", "bin/data.bin": Buffer.from([0x00, 0x0d, 0x0a, 0x01, 0x0a]) };
  let configDir: string;

  const clone = (...args: string[]) => ["clone", ...args, "--host", ins.base];

  async function repoStatus(dir: string, env: NsitOptions["env"]) {
    const result = await nsit(["-C", dir, "status", "--json"], { env });
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }

  beforeAll(async () => {
    configDir = tmpDir();
    await signIn(configDir);
    await seedRepo("clone-tools", SEED);
    await seedRepo("crlf-repo", CRLF_FILES);
  });

  it("clones a private repository with NSIT_TOKEN: the files are there, origin is the plain URL, and no token reaches .git", async () => {
    const cwd = tmpDir();
    const token = newToken("agent");
    const env = { ...homeWith(true), NSIT_TOKEN: token };
    const result = await nsit(clone("ada/clone-tools"), { cwd, env });
    expect(result.code, result.stderr).toBe(0);
    const dir = join(cwd, "clone-tools");
    expect(result.stdout).toMatch(/^Cloned ada\/clone-tools into .*clone-tools\n$/);
    expect(result.stderr).toBe("");

    for (const [path, content] of Object.entries(SEED)) expect(readFileSync(join(dir, path), "utf8"), path).toBe(content);

    const config = readFileSync(join(dir, ".git", "config"), "utf8");
    expect(config).toContain(`url = ${ins.base}/ada/clone-tools.git`);
    expect(config, "no token in .git/config").not.toMatch(/ins_/);
    expect(config, "no user name or token in the URL").not.toMatch(/\/\/[^/\s]*@/);
    for (const file of filesUnder(join(dir, ".git"))) {
      expect(readFileSync(file).includes(token), `the token is in ${file}`).toBe(false);
    }

    // The default branch is checked out and tracks origin/main, so push and pull need no -u.
    expect(await repoStatus(dir, env)).toEqual(CLEAN);
    // Real git reads the clone the same way.
    await realGit(dir, "fsck", "--strict");
    expect(await realGit(dir, "log", "--format=%s")).toBe("Seed\n");
    expect((await realGit(dir, "branch", "--show-current")).trim()).toBe("main");
    expect((await realGit(dir, "rev-parse", "--abbrev-ref", "main@{upstream}")).trim()).toBe("origin/main");
    expect(await realGit(dir, "status", "--porcelain")).toBe("");
  });

  it("without a token it exits 3 at once with a sign-in hint, never waits for input, and creates nothing", async () => {
    const cwd = tmpDir();
    for (const args of [["ada/clone-tools"], ["clone-tools"], ["ada/clone-tools", "target dir"], [`${ins.base}/ada/clone-tools.git`]]) {
      const started = performance.now();
      // No NSIT_TOKEN, no config, stdin open and silent: a read would hang.
      const result = await nsit(clone(...args), { cwd, env: homeWith(true), stdin: "open", timeoutMs: 5_000 });
      expect(result.code, `clone ${args.join(" ")}: ${result.stderr}`).toBe(3);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`nsit: not signed in to ${hostKey}; run nsit auth login\n`);
      expect(performance.now() - started).toBeLessThan(5_000);
    }
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("NSIT_TOKEN is not sent to another server, even when a URL names it (exit 3), and nothing is created", async () => {
    const cwd = tmpDir();
    const result = await nsit(clone("https://other.example/ada/clone-tools"), { cwd, env: { ...homeWith(true), NSIT_TOKEN: newToken("agent") }, timeoutMs: 5_000 });
    expect(result.code, result.stderr).toBe(3);
    expect(result.stderr).toBe("nsit: NSIT_TOKEN is sent only to the selected host, and other.example is not it\n");
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("a repository that is missing, or private to someone else, is the same exit-1 message, and creates nothing", async () => {
    const grace = getUserByName(ins.deps.db, "grace") ?? createUser(ins.deps.db, { username: "grace", password: "longenough", email: "grace@example.com" });
    const graceToken = createAccessToken(ins.deps.db, grace.id, "e2e");
    secrets.add(graceToken);
    const cwd = tmpDir();
    const cases: [string, NsitOptions["env"]][] = [
      ["nobody/missing", { NSIT_TOKEN: newToken("agent") }],
      ["missing-bare-name", { NSIT_TOKEN: newToken("agent") }],
      ["ada/clone-tools", { NSIT_TOKEN: graceToken }],
    ];
    for (const [repo, env] of cases) {
      const result = await nsit(clone(repo), { cwd, env: { ...homeWith(true), ...env } });
      expect(result.code, `${repo}: ${result.stderr}`).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("nsit: repository not found or no access\n");
    }
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("(Review Focus 3) with core.autocrlf=true a fresh clone is clean: nothing unstaged, and commit has nothing to commit", async () => {
    const files = CRLF_FILES;
    // libgit2 does not read GIT_CONFIG_GLOBAL: its global git configuration is this home's .gitconfig.
    const home = homeWith(true, true);
    const env = { ...home, NSIT_TOKEN: newToken("agent") };
    const cwd = tmpDir();
    const result = await nsit(clone("ada/crlf-repo"), { cwd, env });
    expect(result.code, result.stderr).toBe(0);
    const dir = join(cwd, "crlf-repo");

    // The conversion really happened on checkout: the LF-in-repository file has CRLF in the working
    // tree. The CRLF file was not converted twice, and the binary was left alone.
    expect(readFileSync(join(dir, "lf.txt")), "LF text became CRLF").toEqual(Buffer.from("alpha\r\nbeta\r\n"));
    expect(readFileSync(join(dir, "crlf.txt")), "CRLF text stayed CRLF").toEqual(Buffer.from("one\r\ntwo\r\n"));
    expect(readFileSync(join(dir, "bin", "data.bin")), "binary untouched").toEqual(files["bin/data.bin"]);

    // Yet nothing counts as changed.
    expect(await repoStatus(dir, env)).toEqual(CLEAN);
    const head = (await realGit(dir, "rev-parse", "HEAD")).trim();
    const commit = await nsit(["-C", dir, "commit", "-m", "x"], { env });
    expect(commit.code, commit.stderr).toBe(0);
    expect(commit.stdout).toBe("nothing to commit\n");
    expect((await realGit(dir, "rev-parse", "HEAD")).trim(), "no commit was made").toBe(head);
    // Real git, reading the same configuration, agrees that the checkout is clean.
    expect(await gitSeeing(home, dir, "status", "--porcelain")).toBe("");
    expect(await gitSeeing(home, dir, "rev-list", "--count", "HEAD")).toBe("1\n");
  });

  it("the home's core.autocrlf decides the line endings on checkout (the control for the test above)", async () => {
    const env = { ...homeWith(true, false), NSIT_TOKEN: newToken("agent") };
    const cwd = tmpDir();
    const result = await nsit(clone("ada/crlf-repo"), { cwd, env });
    expect(result.code, result.stderr).toBe(0);
    const dir = join(cwd, "crlf-repo");
    // With conversion off, every byte is what the repository holds.
    expect(readFileSync(join(dir, "lf.txt"))).toEqual(Buffer.from("alpha\nbeta\n"));
    expect(readFileSync(join(dir, "crlf.txt"))).toEqual(Buffer.from("one\r\ntwo\r\n"));
    expect(await repoStatus(dir, env)).toEqual(CLEAN);
  });

  it("an empty repository clones to an unborn main with origin set and tracking configured", async () => {
    await createRepo(ins.deps, ada, { name: "empty-one", description: "", isPrivate: true, initReadme: false });
    const env = { ...homeWith(true), NSIT_TOKEN: newToken("agent") };
    const cwd = tmpDir();
    const result = await nsit(clone("ada/empty-one", "--json"), { cwd, env });
    expect(result.code, result.stderr).toBe(0);
    const dir = join(cwd, "empty-one");
    const json = JSON.parse(result.stdout);
    expect(Object.keys(json).sort()).toEqual(["default_branch", "dir", "name", "owner"]);
    expect(json).toMatchObject({ owner: "ada", name: "empty-one", default_branch: "main" });
    expect(same(json.dir, dir)).toBe(true);
    // Stdout is the data; the explanation goes to stderr.
    expect(result.stderr).toMatch(/^The repository is empty: .*nsit commit.*\n$/);

    expect(readFileSync(join(dir, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    const config = readFileSync(join(dir, ".git", "config"), "utf8");
    expect(config).toContain(`url = ${ins.base}/ada/empty-one.git`);
    expect(config).not.toMatch(/ins_/);
    // libgit2 starts an empty clone on the branch init.defaultBranch names (master, unless set),
    // with tracking settings for it. Only the server's default branch keeps any. (An empty
    // [branch "master"] header can stay in the file: libgit2 removes settings, not sections, and
    // git reads an empty section as nothing.)
    expect((await realGit(dir, "config", "--get-regexp", "^branch\\.")).trimEnd().split("\n")).toEqual([
      "branch.main.remote origin",
      "branch.main.merge refs/heads/main",
    ]);
    expect((await realGit(dir, "config", "branch.main.remote")).trim()).toBe("origin");
    expect((await realGit(dir, "config", "branch.main.merge")).trim()).toBe("refs/heads/main");
    expect(await repoStatus(dir, env)).toEqual({ ...CLEAN, upstream: null });

    // The unborn main is a real branch: the first commit lands on it.
    writeFileSync(join(dir, "first.txt"), "one\n");
    const commit = await nsit(["-C", dir, "commit", "-m", "first"], { env });
    expect(commit.code, commit.stderr).toBe(0);
    expect(commit.stdout).toMatch(/^\[main [0-9a-f]{7}\] first\n/);
    expect((await realGit(dir, "log", "--format=%s")).trim()).toBe("first");
  });

  it("(Review Focus 1) clones into a directory with spaces and an accent: as [dir] from the working directory, and with -C", async () => {
    const name = "Vidéo Ink - OG Edition";
    const env = homeWith(true);

    // [dir] is relative to the working directory.
    const cwd = tmpDir();
    const relative = await nsit(clone("ada/clone-tools", name), { cwd, configDir, env });
    expect(relative.code, relative.stderr).toBe(0);
    expect(relative.stdout).toMatch(/^Cloned ada\/clone-tools into .*Vidéo Ink - OG Edition\n$/);
    const first = join(cwd, name);
    expect(readFileSync(join(first, "docs", "ünï côdé.txt"), "utf8")).toBe("accented\n");

    // -C names the directory it is run from; [dir] is relative to that, and the process stays elsewhere.
    const parent = tmpDir();
    const elsewhere = tmpDir();
    const viaC = await nsit(["-C", parent, ...clone("ada/clone-tools", name, "--json")], { cwd: elsewhere, configDir, env });
    expect(viaC.code, viaC.stderr).toBe(0);
    const second = join(parent, name);
    expect(same(JSON.parse(viaC.stdout).dir, second)).toBe(true);
    expect(readdirSync(elsewhere)).toEqual([]);

    for (const dir of [first, second]) {
      expect(await repoStatus(dir, env)).toEqual(CLEAN);
      await realGit(dir, "fsck", "--strict");
      expect(await realGit(dir, "show", "HEAD:docs/ünï côdé.txt")).toBe("accented\n");
    }
  });

  it("refuses a directory that has anything in it (exit 2) and leaves it exactly as it was; an empty one is fine, and so is .", async () => {
    const env = homeWith(true);
    const cwd = tmpDir();
    mkdirSync(join(cwd, "taken"));
    writeFileSync(join(cwd, "taken", "keep.txt"), "mine\n");
    writeFileSync(join(cwd, "afile"), "not a directory\n");
    for (const target of ["taken", "afile"]) {
      const result = await nsit(clone("ada/clone-tools", target), { cwd, configDir, env });
      expect(result.code, `${target}: ${result.stderr}`).toBe(2);
      expect(result.stdout).toBe("");
      expect(oneLine(result.stderr), result.stderr).toBe(true);
    }
    expect(readdirSync(join(cwd, "taken"))).toEqual(["keep.txt"]);
    expect(readFileSync(join(cwd, "taken", "keep.txt"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(cwd, "afile"), "utf8")).toBe("not a directory\n");
    // The same for the working directory itself, which is not empty now.
    const dot = await nsit(clone("ada/clone-tools", "."), { cwd, configDir, env });
    expect(dot.code, dot.stderr).toBe(2);
    expect(readdirSync(cwd).sort()).toEqual(["afile", "taken"]);

    // An empty directory is cloned into (git does the same), by name or as the working directory.
    mkdirSync(join(cwd, "empty"));
    const empty = await nsit(clone("ada/clone-tools", "empty"), { cwd, configDir, env });
    expect(empty.code, empty.stderr).toBe(0);
    expect(existsSync(join(cwd, "empty", "README.md"))).toBe(true);
    const here = tmpDir();
    const inPlace = await nsit(clone("ada/clone-tools", "."), { cwd: here, configDir, env });
    expect(inPlace.code, inPlace.stderr).toBe(0);
    expect(existsSync(join(here, "README.md"))).toBe(true);
    expect(existsSync(join(here, ".git", "config"))).toBe(true);
  });

  it("names the repository three ways, prints --json and --jq, and the clone is the same each time", async () => {
    const env = homeWith(true);
    const cwd = tmpDir();
    const byPair = await nsit(clone("ada/clone-tools", "a", "--json"), { cwd, configDir, env });
    expect(byPair.code, byPair.stderr).toBe(0);
    expect(Object.keys(JSON.parse(byPair.stdout)).sort()).toEqual(["default_branch", "dir", "name", "owner"]);
    expect(JSON.parse(byPair.stdout)).toMatchObject({ owner: "ada", name: "clone-tools", default_branch: "main" });
    // A bare name is yours; the URL may or may not end in .git.
    for (const [input, target] of [["clone-tools", "b"], [`${ins.base}/ada/clone-tools.git`, "c"], [`${ins.base}/ada/clone-tools`, "d"]]) {
      const result = await nsit(clone(input!, target!, "--jq", ".owner + \"/\" + .name"), { cwd, configDir, env });
      expect(result.code, `${input}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toBe("ada/clone-tools\n");
    }
    for (const target of ["a", "b", "c", "d"]) {
      expect(readFileSync(join(cwd, target, "src", "main.txt"), "utf8")).toBe("hello\n");
      expect(readFileSync(join(cwd, target, ".git", "config"), "utf8")).toContain(`url = ${ins.base}/ada/clone-tools.git`);
    }
    const quiet = await nsit(clone("ada/clone-tools", "e", "-q"), { cwd, configDir, env });
    expect(quiet.code, quiet.stderr).toBe(0);
    expect(quiet.stderr).toBe("");
  });

  it("a clone that fails midway removes what nsit made, and nothing else (exit 1, no token in the message)", async () => {
    // The server knows the repository, but its bare repository is gone: the lookup works, git does not.
    await createRepo(ins.deps, ada, { name: "broken", description: "", isPrivate: true, initReadme: false });
    rmSync(repoDir(ins.deps.config.dataDir, "ada", "broken"), { recursive: true, force: true });
    const env = homeWith(true);
    const cwd = tmpDir();
    mkdirSync(join(cwd, "keep"));
    writeFileSync(join(cwd, "keep", "mine.txt"), "mine\n");
    mkdirSync(join(cwd, "empty"));

    // Every attempt must get as far as asking the server's git endpoint for the refs: that is what
    // makes this a clone that failed midway, and not one that never began.
    const asked: string[] = [];
    const record = (req: IncomingMessage) => void asked.push(req.url ?? "");
    ins.server.on("request", record);
    const attempts = [["broken"], ["broken", "deep/er/dir"], ["broken", "keep/new"], ["broken", "empty"]];
    try {
      for (const args of attempts) {
        const before = asked.filter((url) => url.startsWith("/ada/broken.git/info/refs")).length;
        const result = await nsit(clone(...args), { cwd, configDir, env });
        expect(result.code, `${args.join(" ")}: ${result.stderr}`).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toMatch(/^nsit: /);
        expect(result.stderr).not.toContain("not implemented");
        expect(oneLine(result.stderr), result.stderr).toBe(true);
        const after = asked.filter((url) => url.startsWith("/ada/broken.git/info/refs")).length;
        expect(after, `${args.join(" ")} never reached the git endpoint`).toBeGreaterThan(before);
      }
    } finally {
      ins.server.off("request", record);
    }
    // What did not exist before is gone, parents nsit would have made included...
    expect(readdirSync(cwd).sort()).toEqual(["empty", "keep"]);
    expect(readdirSync(join(cwd, "keep"))).toEqual(["mine.txt"]);
    // ...and a directory that was there is still there, and empty.
    expect(readdirSync(join(cwd, "empty"))).toEqual([]);
    expect(readFileSync(join(cwd, "keep", "mine.txt"), "utf8")).toBe("mine\n");
  });
});

// ---- nsit push ---------------------------------------------------------------------------------

describe("nsit push", () => {
  let adaDir: string;
  let bob: User;
  let bobDir: string;
  let bobToken: string;

  /** `nsit push` against this server, with `args` before the global --host. */
  const push = (...args: string[]) => ["push", ...args, "--host", ins.base];

  /** The server's own tip of a branch, read from the bare repository by real git; "" when it has none. */
  async function serverTip(repo: string, branch = "main"): Promise<string> {
    return (await realGit(serverRepo("ada", repo), "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`)).trim();
  }

  /** A repository ada owns on the server with one commit on main, and a fresh nsit clone of it. */
  async function seededClone(name: string, isPrivate = true): Promise<Work> {
    await seedRepo(name, { "README.md": "# x\n", "a.txt": "base\n" }, isPrivate);
    return cloneOf(`ada/${name}`, adaDir);
  }

  const pushFrom = (work: Work, ...args: string[]) => nsit(["-C", work.dir, ...push(...args)], { configDir: work.configDir, env: work.env });

  /** Every POST the server's git endpoint receives while `during` runs: an upload, which a refused push must never start. */
  async function uploadsDuring<T>(during: () => Promise<T>): Promise<{ result: T; uploads: string[] }> {
    const uploads: string[] = [];
    const record = (req: IncomingMessage) => {
      if (req.method === "POST" && req.url?.endsWith("/git-receive-pack")) uploads.push(req.url);
    };
    ins.server.prependListener("request", record);
    try {
      return { result: await during(), uploads };
    } finally {
      ins.server.off("request", record);
    }
  }

  beforeAll(async () => {
    adaDir = tmpDir();
    await signIn(adaDir);
    bob = getUserByName(ins.deps.db, "bob") ?? createUser(ins.deps.db, { username: "bob", password: "longenough", email: "bob@example.com" });
    bobToken = createAccessToken(ins.deps.db, bob.id, "e2e");
    secrets.add(bobToken);
    bobDir = tmpDir();
    await signIn(bobDir, bobToken);
  });

  it("a second commit advances the server's branch; the output is one line, nothing else moves, and no token is written", async () => {
    const work = await seededClone("advance");
    const first = await serverTip("advance");
    const head = await commitIn(work, "b.txt", "two\n", "Add b");
    expect(head).not.toBe(first);

    const result = await pushFrom(work);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe("Pushed main to ada/advance\n");
    expect(result.stderr, "nothing but data off a terminal").toBe("");

    // Real git, reading the server's repository: the branch is at the new commit, with its history.
    expect(await serverTip("advance")).toBe(head);
    expect(await realGit(serverRepo("ada", "advance"), "log", "--format=%s", "main")).toBe("Add b\nSeed\n");
    await realGit(serverRepo("ada", "advance"), "fsck", "--strict");
    // Locally, the tracking branch caught up and the branch itself is untouched.
    expect(await ref(work.dir, "refs/remotes/origin/main")).toBe(head);
    expect(await ref(work.dir, "refs/heads/main")).toBe(head);
    const status = await nsit(["-C", work.dir, "status", "--json"], { env: work.env, configDir: work.configDir });
    expect(JSON.parse(status.stdout)).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 0, behind: 0 });
    // The token went to the server as a password and nowhere else.
    const config = readFileSync(join(work.dir, ".git", "config"), "utf8");
    expect(config).not.toMatch(/ins_/);
    expect(config).not.toMatch(/\/\/[^/\s]*@/);
    for (const file of filesUnder(join(work.dir, ".git"))) {
      for (const secret of secrets) expect(readFileSync(file).includes(secret), `a token is in ${file}`).toBe(false);
    }
  });

  it("when the server already has everything it says so and sends nothing; --json says what changed", async () => {
    const work = await seededClone("uptodate");
    const base = await ref(work.dir, "HEAD");
    const { result: again, uploads } = await uploadsDuring(() => pushFrom(work));
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toBe("Everything up to date\n");
    expect(uploads, "nothing was uploaded").toEqual([]);

    const same = await pushFrom(work, "--json");
    expect(JSON.parse(same.stdout)).toEqual({ branch: "main", remote: "ada/uptodate", updated: false, old: base, new: base });

    const head = await commitIn(work, "c.txt", "c\n", "Add c");
    const sent = await pushFrom(work, "--json");
    expect(sent.code, sent.stderr).toBe(0);
    expect(JSON.parse(sent.stdout)).toEqual({ branch: "main", remote: "ada/uptodate", updated: true, old: base, new: head });
    const jq = await pushFrom(work, "--jq", ".updated");
    expect(jq.stdout).toBe("false\n");
  });

  it("[branch] pushes that branch, creating it on the server, and leaves the current branch alone", async () => {
    const work = await seededClone("branches");
    expect((await nsit(["-C", work.dir, "branch", "feature"], { configDir: work.configDir, env: work.env })).code).toBe(0);
    const tip = await ref(work.dir, "refs/heads/feature");
    expect(await serverTip("branches", "feature")).toBe("");

    const result = await pushFrom(work, "feature", "--json");
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ branch: "feature", remote: "ada/branches", updated: true, old: null, new: tip });
    expect(await serverTip("branches", "feature")).toBe(tip);
    expect(await ref(work.dir, "refs/remotes/origin/feature")).toBe(tip);
    expect(await configValue(work.dir, "branch.feature.remote")).toBe("origin");
    expect(await configValue(work.dir, "branch.feature.merge")).toBe("refs/heads/feature");
    expect((await realGit(work.dir, "branch", "--show-current")).trim(), "still on main").toBe("main");
  });

  it("sets the upstream by itself on the first push; an upstream that is set is left alone, and -u sets it again", async () => {
    const dir = join(tmpDir(), "upstream-demo");
    mkdirSync(dir);
    const env = homeWith(true);
    const run = (...args: string[]) => nsit(["-C", dir, ...args, "--host", ins.base], { configDir: adaDir, env });
    expect((await run("init", "--remote")).code).toBe(0);
    writeFileSync(join(dir, "one.txt"), "1\n");
    expect((await run("commit", "-m", "one")).code).toBe(0);
    expect(await configValue(dir, "branch.main.remote"), "no upstream yet").toBeNull();
    expect(JSON.parse((await run("status", "--json")).stdout).upstream).toBeNull();

    const first = await run("push");
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toBe("Pushed main to ada/upstream-demo\n");
    expect(await configValue(dir, "branch.main.remote")).toBe("origin");
    expect(await configValue(dir, "branch.main.merge")).toBe("refs/heads/main");
    expect(JSON.parse((await run("status", "--json")).stdout)).toMatchObject({ upstream: "origin/main", ahead: 0, behind: 0 });
    // The server really has it (the repository did not exist until init made it).
    expect(await serverTip("upstream-demo")).toBe(await ref(dir, "HEAD"));

    // A plain push does not rewrite an upstream somebody set; -u does, even when there is nothing to send.
    await realGit(dir, "config", "branch.main.merge", "refs/heads/other");
    writeFileSync(join(dir, "two.txt"), "2\n");
    expect((await run("commit", "-m", "two")).code).toBe(0);
    expect((await run("push")).code).toBe(0);
    expect(await configValue(dir, "branch.main.merge")).toBe("refs/heads/other");
    const again = await run("push", "-u");
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toBe("Everything up to date\n");
    expect(await configValue(dir, "branch.main.merge")).toBe("refs/heads/main");
  });

  it("diverged history is refused by the client (exit 6, non-fast-forward): nothing is uploaded and nothing moves, locally or on the server", async () => {
    // The server would accept this push (its repositories have receive.denyNonFastForwards off),
    // so the refusal has to come from libgit2's own check on this side.
    await seedRepo("diverge", { "a.txt": "base\n" });
    const a = await cloneOf("ada/diverge", adaDir);
    const b = await cloneOf("ada/diverge", adaDir);
    const fromA = await commitIn(a, "a.txt", "from a\n", "A's change");
    const pushedA = await pushFrom(a);
    expect(pushedA.code, pushedA.stderr).toBe(0);
    expect(await serverTip("diverge")).toBe(fromA);

    await commitIn(b, "b.txt", "from b\n", "B's change");
    const before = await snapshot(b.dir);
    expect(await ref(b.dir, "refs/remotes/origin/main")).not.toBe(await ref(b.dir, "refs/heads/main"));

    const { result, uploads } = await uploadsDuring(() => pushFrom(b));
    expect(result.code, result.stderr).toBe(6);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("nsit: refs/heads/main: non-fast-forward; run nsit pull\n");
    expect(uploads, "the refusal came before any upload").toEqual([]);
    // B: every ref (so refs/heads/main and refs/remotes/origin/main), HEAD and the config are as they were.
    expect(await snapshot(b.dir)).toEqual(before);
    // The server: still A's commit.
    expect(await serverTip("diverge")).toBe(fromA);
  });

  it("a branch whose history was rewritten is refused unless --force-with-lease and the server's branch is where nsit last saw it", async () => {
    const work = await seededClone("lease-ok");
    const seen = await serverTip("lease-ok");
    // Rewrite the commit the server has (real git, as an editor or an agent's tooling might).
    await realGit(work.dir, "commit", "--amend", "-q", "-m", "Seed, reworded");
    const rewritten = await ref(work.dir, "HEAD");
    expect(rewritten).not.toBe(seen);

    const plain = await pushFrom(work);
    expect(plain.code, plain.stderr).toBe(6);
    expect(plain.stderr).toBe("nsit: refs/heads/main: non-fast-forward; run nsit pull\n");
    expect(await serverTip("lease-ok")).toBe(seen);

    const forced = await pushFrom(work, "--force-with-lease", "--json");
    expect(forced.code, forced.stderr).toBe(0);
    expect(JSON.parse(forced.stdout)).toEqual({ branch: "main", remote: "ada/lease-ok", updated: true, old: seen, new: rewritten });
    expect(await serverTip("lease-ok"), "the server took the rewritten branch").toBe(rewritten);
    expect(await ref(work.dir, "refs/remotes/origin/main")).toBe(rewritten);
    await realGit(serverRepo("ada", "lease-ok"), "fsck", "--strict");
  });

  it("--force-with-lease is refused with 'stale info' when somebody else pushed since nsit last looked: nothing is uploaded and nothing moves", async () => {
    await seedRepo("lease-stale", { "a.txt": "base\n" });
    const mine = await cloneOf("ada/lease-stale", adaDir);
    const theirs = await cloneOf("ada/lease-stale", adaDir);
    const their = await commitIn(theirs, "a.txt", "theirs\n", "Their commit");
    expect((await pushFrom(theirs)).code).toBe(0);
    await realGit(mine.dir, "commit", "--amend", "-q", "-m", "Mine, reworded");
    const before = await snapshot(mine.dir);

    const { result, uploads } = await uploadsDuring(() => pushFrom(mine, "--force-with-lease"));
    expect(result.code, result.stderr).toBe(6);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^nsit: refs\/heads\/main: stale info/);
    expect(oneLine(result.stderr), result.stderr).toBe(true);
    expect(uploads, "cancelled before the upload").toEqual([]);
    expect(await snapshot(mine.dir)).toEqual(before);
    expect(await serverTip("lease-stale"), "their commit is still the server's").toBe(their);
  });

  it("signed out, with stdin an open pipe: exit 3 within 5 s with a sign-in hint, and nothing moves (Review Focus 2)", async () => {
    const work = await seededClone("signedout");
    await commitIn(work, "late.txt", "late\n", "Late");
    const before = await snapshot(work.dir);
    for (const extra of [[], ["--json"]]) {
      const started = performance.now();
      // A fresh config directory, no NSIT_TOKEN, stdin open and silent: a read would hang.
      const result = await nsit(["-C", work.dir, ...push(...extra)], { env: work.env, stdin: "open", timeoutMs: 5_000 });
      expect(result.code, result.stderr).toBe(3);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`nsit: not signed in to ${hostKey}; run nsit auth login\n`);
      expect(performance.now() - started).toBeLessThan(5_000);
    }
    expect(await snapshot(work.dir)).toEqual(before);
  });

  it("says what is wrong when it cannot tell what to push (exit 2): no origin, no commits, detached HEAD, no such branch", async () => {
    const env = homeWith(true);
    const usage = async (result: Promise<NsitResult>, pattern: RegExp) => {
      const done = await result;
      expect(done.code, done.stderr).toBe(2);
      expect(done.stdout).toBe("");
      expect(done.stderr).toMatch(pattern);
      expect(oneLine(done.stderr), done.stderr).toBe(true);
    };

    // A repository that was never given an origin.
    const local = tmpDir();
    expect((await nsit(["-C", local, "init"], { env })).code).toBe(0);
    writeFileSync(join(local, "a.txt"), "a\n");
    expect((await nsit(["-C", local, "commit", "-m", "one"], { env })).code).toBe(0);
    await usage(nsit(["-C", local, ...push()], { configDir: adaDir, env }), /^nsit: .*origin/);

    // An origin and no commit yet.
    const empty = join(tmpDir(), "no-commits-yet");
    mkdirSync(empty);
    expect((await nsit(["-C", empty, "init", "--remote", "--host", ins.base], { configDir: adaDir, env })).code).toBe(0);
    await usage(nsit(["-C", empty, ...push()], { configDir: adaDir, env }), /^nsit: .*no commits yet/);

    // A detached HEAD wants the branch named; naming it works.
    const work = await seededClone("usage");
    await realGit(work.dir, "checkout", "--detach", "-q");
    await usage(pushFrom(work), /^nsit: .*detached/);
    const named = await pushFrom(work, "main");
    expect(named.code, named.stderr).toBe(0);
    expect(named.stdout).toBe("Everything up to date\n");

    // A branch that is not there, and a name that cannot be one.
    await usage(pushFrom(work, "nope"), /^nsit: .*no branch named nope/);
    await usage(pushFrom(work, "a..b"), /^nsit: .*not a valid branch name/);
  });

  it("an origin on another server never gets NSIT_TOKEN (exit 3), and nothing moves", async () => {
    const work = await seededClone("elsewhere");
    await commitIn(work, "x.txt", "x\n", "X");
    await realGit(work.dir, "remote", "set-url", "origin", "https://other.example/ada/elsewhere.git");
    const before = await snapshot(work.dir);
    const result = await nsit(["-C", work.dir, ...push()], { env: { ...work.env, NSIT_TOKEN: newToken("agent") }, timeoutMs: 5_000 });
    expect(result.code, result.stderr).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("nsit: NSIT_TOKEN is sent only to the selected host, and other.example is not it\n");
    expect(await snapshot(work.dir)).toEqual(before);
  });

  it("a read-only collaborator's push is refused by the server (403): exit 6 with 'permission', and nothing moves", async () => {
    await seedRepo("readonly", { "a.txt": "base\n" }, true);
    const row = getRepo(ins.deps.db, "ada", "readonly")!;
    addCollaborator(ins.deps.db, row.id, bob.id, "read");
    // Read access is enough to clone...
    const work = await cloneOf("ada/readonly", bobDir);
    const head = await commitIn(work, "bob.txt", "bob\n", "Bob's commit");
    const before = await snapshot(work.dir);
    const tip = await serverTip("readonly");
    expect(tip).not.toBe(head);

    // ...and not to push.
    const result = await pushFrom(work);
    expect(result.code, result.stderr).toBe(6);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^nsit: permission denied: .*ada\/readonly/);
    expect(oneLine(result.stderr), result.stderr).toBe(true);
    expect(result.stderr).not.toMatch(/ins_/);
    expect(await snapshot(work.dir)).toEqual(before);
    expect(await serverTip("readonly")).toBe(tip);

    // It was the account's access that was refused, not nsit's request: with write access the same push goes through.
    addCollaborator(ins.deps.db, row.id, bob.id, "write");
    const allowed = await pushFrom(work);
    expect(allowed.code, allowed.stderr).toBe(0);
    expect(await serverTip("readonly")).toBe(head);
  });

  it("(Review Focus 4) a server that has stopped: exit 1, one line, no token anywhere, and no ref moves", async () => {
    const gone = await startInsitio();
    try {
      const user = createUser(gone.deps.db, { username: "ada", password: "longenough", email: "ada@example.com" });
      const token = createAccessToken(gone.deps.db, user.id, "e2e");
      secrets.add(token);
      const configDir = tmpDir();
      const env = homeWith(true);
      const login = await nsit(["auth", "login", "--with-token", "--host", gone.base], { configDir, input: token });
      expect(login.code, login.stderr).toBe(0);
      const cwd = tmpDir();
      const init = await nsit(["init", "stopped", "--readme", "--host", gone.base], { cwd, configDir, env });
      expect(init.code, init.stderr).toBe(0);
      const dir = join(cwd, "stopped");
      writeFileSync(join(dir, "later.txt"), "not pushed yet\n");
      expect((await nsit(["-C", dir, "commit", "-m", "later"], { configDir, env })).code).toBe(0);
      const before = await snapshot(dir);
      expect(await ref(dir, "refs/heads/main")).not.toBe(await ref(dir, "refs/remotes/origin/main"));

      // The server goes away: the address is still in .git/config.
      await gone.close();

      // Once with the token nsit saved, once with NSIT_TOKEN (which is asked about first, over the API).
      for (const [how, opts] of [
        ["saved token", { configDir, env }],
        ["NSIT_TOKEN", { configDir: tmpDir(), env: { ...env, NSIT_TOKEN: token } }],
      ] as const) {
        const result = await nsit(["-C", dir, "push", "--host", gone.base], { ...opts, timeoutMs: 15_000 });
        expect(result.code, `${how}: ${result.stderr}`).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toMatch(/^nsit: \S/);
        expect(oneLine(result.stderr), `${how}: ${result.stderr}`).toBe(true);
        expect(result.stderr).not.toMatch(/ins_/);
        expect(result.stderr + result.stdout).not.toContain(token);
        expect(await snapshot(dir), `${how}: nothing moved`).toEqual(before);
      }
      expect(readFileSync(join(dir, ".git", "config"), "utf8")).not.toMatch(/ins_/);
    } finally {
      await gone.close();
    }
  });

  it("(Review Focus 4) a connection that dies in the middle of the upload: exit 1, one line, no ref moves, and the server's branch stays", async () => {
    const work = await seededClone("drop");
    await commitIn(work, "payload.bin", randomBytes(256 * 1024), "Payload");
    const before = await snapshot(work.dir);
    const tip = await serverTip("drop");
    // Cut the connection the moment the upload begins (before the server's own handler reads a byte of it).
    const cut = (req: IncomingMessage) => {
      if (req.method === "POST" && req.url?.endsWith("/git-receive-pack")) req.socket.destroy();
    };
    ins.server.prependListener("request", cut);
    let result: NsitResult;
    try {
      result = await pushFrom(work);
    } finally {
      ins.server.off("request", cut);
    }
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^nsit: \S/);
    expect(oneLine(result.stderr), result.stderr).toBe(true);
    expect(result.stderr).not.toMatch(/ins_/);
    expect(await snapshot(work.dir)).toEqual(before);
    expect(await serverTip("drop")).toBe(tip);

    // Nothing was left in a state that blocks the next try.
    const retry = await pushFrom(work);
    expect(retry.code, retry.stderr).toBe(0);
    expect(await serverTip("drop")).toBe(await ref(work.dir, "HEAD"));
  });

  it("a pack the server refuses to store is rejected by the server (exit 6, its own words, not 'cannot reach'), and nothing moves", async () => {
    const work = await seededClone("unpackfail");
    // Far more than the sockets between the two hold, so nsit is still sending when the server gives up.
    await commitIn(work, "payload.bin", randomBytes(16 * 1024 * 1024), "Payload");
    const before = await snapshot(work.dir);
    const tip = await serverTip("unpackfail");
    // The server's own limit on what one push may carry, the way a server refuses a very big push:
    // the real receive-pack stops reading the pack at the limit, cannot unpack it, and says
    // `ng <ref> unpacker error` for the branch. (The Rust test of `plain_failure` covers a server that
    // fails to unpack and names no ref.) The server has to read the rest of the upload and drop it, or
    // the connection breaks under nsit and it reports a write failure instead of the server's answer.
    const bare = serverRepo("ada", "unpackfail");
    await realGit(bare, "config", "receive.maxInputSize", "1024");

    const result = await pushFrom(work);
    expect(result.code, result.stderr).toBe(6);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("nsit: refs/heads/main: unpacker error\n");
    expect(result.stderr).not.toMatch(/cannot reach|ins_/);
    expect(await snapshot(work.dir)).toEqual(before);
    expect(await serverTip("unpackfail")).toBe(tip);

    // Nothing is stuck: without the limit the same push goes through.
    await realGit(bare, "config", "--unset", "receive.maxInputSize");
    const retry = await pushFrom(work);
    expect(retry.code, retry.stderr).toBe(0);
    expect(await serverTip("unpackfail")).toBe(await ref(work.dir, "HEAD"));
    await realGit(bare, "fsck", "--strict");
  });

  it("a few megabytes of data that does not compress go through in one push, and real git agrees about the object", async () => {
    const work = await seededClone("bulk");
    const blob = randomBytes(6 * 1024 * 1024);
    const head = await commitIn(work, "blob.bin", blob, "Add a blob");
    const result = await pushFrom(work);
    expect(result.code, result.stderr).toBe(0);
    expect(await serverTip("bulk")).toBe(head);
    const bare = serverRepo("ada", "bulk");
    expect((await realGit(bare, "cat-file", "-s", "main:blob.bin")).trim()).toBe(String(blob.length));
    await realGit(bare, "fsck", "--strict");
  });
});

// ---- nsit pull ---------------------------------------------------------------------------------

/** Every file of a working tree (`.git` left out) with its text: what an abort has to put back. */
function workingFiles(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const name = relative(dir, path).split(sep).join("/");
    if (name === ".git" || name.startsWith(".git/")) continue;
    found[name] = readFileSync(path, "utf8");
  }
  return found;
}

describe("nsit pull", () => {
  // Two clones of one server repository stand for two people. They run in order, share the server,
  // and each test makes its own repository so none depends on another.
  const SLOW = 60_000;
  let adaDir: string;

  /** `nsit pull` against this server, with `args` before the global --host. */
  const pull = (...args: string[]) => ["pull", ...args, "--host", ins.base];
  const pullIn = (work: Work, ...args: string[]) => nsit(["-C", work.dir, ...pull(...args)], { configDir: work.configDir, env: work.env });
  const nsitIn = (work: Work, ...args: string[]) => nsit(["-C", work.dir, ...args], { configDir: work.configDir, env: work.env });
  const MERGE_STATE = ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE"];
  const merging = (work: Work) => existsSync(join(work.dir, ".git", "MERGE_HEAD"));

  async function pushIn(work: Work): Promise<void> {
    const result = await nsit(["-C", work.dir, "push", "--host", ins.base], { configDir: work.configDir, env: work.env });
    expect(result.code, result.stderr).toBe(0);
  }

  /** Writes and commits `file` in `work`, then pushes: what one person does to leave something for the other to pull. */
  async function publish(work: Work, file: string, content: string, message: string): Promise<string> {
    const head = await commitIn(work, file, content, message);
    await pushIn(work);
    return head;
  }

  async function statusOf(work: Work) {
    const result = await nsitIn(work, "status", "--json");
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }

  /** The parents of HEAD, from real git, first parent first. */
  async function parentsOfHead(dir: string): Promise<string[]> {
    return (await realGit(dir, "rev-list", "--parents", "-n", "1", "HEAD")).trim().split(" ").slice(1);
  }

  /** Two clones of a fresh server repository, each with its own commit identity in its own repository config. */
  async function twoClones(name: string, seed: Seed = { "a.txt": "base\n", "keep.txt": "keep\n" }, envOfB = homeWith(true)) {
    await seedRepo(name, seed);
    const a = await cloneOf(`ada/${name}`, adaDir);
    const b = await cloneOf(`ada/${name}`, adaDir, envOfB);
    for (const [work, who, email] of [[a, "Clone A", "a@example.com"], [b, "Clone B", "b@example.com"]] as const) {
      await realGit(work.dir, "config", "user.name", who);
      await realGit(work.dir, "config", "user.email", email);
    }
    return { a, b };
  }

  beforeAll(async () => {
    adaDir = tmpDir();
    await signIn(adaDir);
  });

  it(
    "fast-forwards to a commit another clone pushed: the branch, the files, the tracking ref and ORIG_HEAD move, and nothing else",
    async () => {
      const { a, b } = await twoClones("pull-ff");
      const before = await ref(b.dir, "HEAD");
      const theirs = await publish(a, "new.txt", "from a\n", "A adds new.txt");
      expect(theirs).not.toBe(before);

      const result = await pullIn(b);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe(`Fast-forwarded main to ${theirs.slice(0, 7)}\n`);
      expect(result.stderr, "nothing but data off a terminal").toBe("");
      expect(await ref(b.dir, "HEAD")).toBe(theirs);
      expect(await ref(b.dir, "refs/heads/main")).toBe(theirs);
      expect(await ref(b.dir, "refs/remotes/origin/main")).toBe(theirs);
      expect(readFileSync(join(b.dir, "new.txt"), "utf8")).toBe("from a\n");
      // Real git finds ORIG_HEAD where it looks for it: the commit the branch was at before the pull.
      expect(await ref(b.dir, "ORIG_HEAD")).toBe(before);
      expect((await realGit(b.dir, "log", "--format=%s")).trimEnd().split("\n")).toEqual(["A adds new.txt", "Seed"]);
      expect(await realGit(b.dir, "status", "--porcelain")).toBe("");
      expect(await statusOf(b)).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 0, behind: 0, conflicted: [] });
      for (const state of MERGE_STATE) expect(existsSync(join(b.dir, ".git", state)), state).toBe(false);
      await realGit(b.dir, "fsck", "--strict");

      // Asked again there is nothing to do, and nothing is touched (ORIG_HEAD included).
      const again = await pullIn(b);
      expect(again.code, again.stderr).toBe(0);
      expect(again.stdout).toBe("Already up to date\n");
      expect(await ref(b.dir, "HEAD")).toBe(theirs);
      expect(await ref(b.dir, "ORIG_HEAD")).toBe(before);

      // --json and --jq say what happened.
      const next = await publish(a, "newer.txt", "again\n", "A adds newer.txt");
      const json = await pullIn(b, "--json");
      expect(json.code, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual({ result: "fast_forward", head: next, conflicts: [] });
      expect(JSON.parse((await pullIn(b, "--json")).stdout)).toEqual({ result: "up_to_date", head: next, conflicts: [] });
      expect((await pullIn(b, "--jq", ".result")).stdout).toBe("up_to_date\n");
    },
    SLOW,
  );

  it(
    "merges edits to different files into a merge commit with two parents, made as the person pulling; it pushes as a fast-forward",
    async () => {
      const { a, b } = await twoClones("pull-merge");
      const theirs = await publish(a, "a.txt", "from a\n", "A edits a.txt");
      const mine = await commitIn(b, "keep.txt", "from b\n", "B edits keep.txt");

      const result = await pullIn(b);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("Merged origin/main\n");
      expect(result.stderr).toBe("");
      const head = await ref(b.dir, "HEAD");
      expect(await parentsOfHead(b.dir)).toEqual([mine, theirs]);
      expect(await realGit(b.dir, "log", "-1", "--format=%s")).toBe(`Merge branch 'main' of ${ins.base}/ada/pull-merge.git\n`);
      expect((await realGit(b.dir, "log", "-1", "--format=%an <%ae>|%cn <%ce>")).trim()).toBe("Clone B <b@example.com>|Clone B <b@example.com>");
      expect(readFileSync(join(b.dir, "a.txt"), "utf8")).toBe("from a\n");
      expect(readFileSync(join(b.dir, "keep.txt"), "utf8")).toBe("from b\n");
      expect(await ref(b.dir, "ORIG_HEAD")).toBe(mine);
      expect(await ref(b.dir, "refs/remotes/origin/main")).toBe(theirs);
      for (const state of MERGE_STATE) expect(existsSync(join(b.dir, ".git", state)), state).toBe(false);
      expect(await realGit(b.dir, "status", "--porcelain")).toBe("");
      await realGit(b.dir, "fsck", "--strict");
      expect(await statusOf(b)).toMatchObject({ ahead: 2, behind: 0, conflicted: [] });
      // The token went to the server as a password and nowhere else.
      for (const file of filesUnder(join(b.dir, ".git"))) {
        for (const secret of secrets) expect(readFileSync(file).includes(secret), `a token is in ${file}`).toBe(false);
      }

      // The merge goes up as a fast-forward, and the other clone fast-forwards to it.
      await pushIn(b);
      expect((await realGit(serverRepo("ada", "pull-merge"), "rev-parse", "refs/heads/main")).trim()).toBe(head);
      const back = await pullIn(a);
      expect(back.code, back.stderr).toBe(0);
      expect(back.stdout).toBe(`Fast-forwarded main to ${head.slice(0, 7)}\n`);
      expect(readFileSync(join(a.dir, "keep.txt"), "utf8")).toBe("from b\n");

      // --json
      const theirs2 = await publish(a, "more-a.txt", "a\n", "A again");
      const mine2 = await commitIn(b, "more-b.txt", "b\n", "B again");
      const json = await pullIn(b, "--json");
      expect(json.code, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual({ result: "merged", head: await ref(b.dir, "HEAD"), conflicts: [] });
      expect(await parentsOfHead(b.dir)).toEqual([mine2, theirs2]);
    },
    SLOW,
  );

  it("with no git identity on the machine the merge commit is by the account nsit is signed in as", async () => {
    await seedRepo("pull-identity", { "a.txt": "base\n", "keep.txt": "keep\n" });
    const a = await cloneOf("ada/pull-identity", adaDir);
    const b = await cloneOf("ada/pull-identity", adaDir, homeWith(false));
    await realGit(a.dir, "config", "user.name", "Clone A");
    await realGit(a.dir, "config", "user.email", "a@example.com");
    await publish(a, "a.txt", "from a\n", "A edits a.txt");
    // B's own commit is by that account too (with --host: its name and email are saved per server).
    writeFileSync(join(b.dir, "keep.txt"), "from b\n");
    const own = await nsitIn(b, "commit", "-m", "B edits keep.txt", "--host", ins.base);
    expect(own.code, own.stderr).toBe(0);

    const result = await pullIn(b);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe("Merged origin/main\n");
    expect((await realGit(b.dir, "log", "-1", "--format=%an <%ae>")).trim()).toBe("Ada Lovelace <ada@example.com>");
    expect((await parentsOfHead(b.dir)).length).toBe(2);
  }, SLOW);

  it(
    "a conflict exits 4 and leaves the merge in progress for real git to see; nsit commit finishes it once it is resolved",
    async () => {
      const { a, b } = await twoClones("pull-conflict");
      const theirs = await publish(a, "a.txt", "from a\n", "A edits a.txt");
      const mine = await commitIn(b, "a.txt", "from b\n", "B edits a.txt");

      const result = await pullIn(b);
      expect(result.code, result.stderr).toBe(4);
      expect(result.stdout).toContain("a.txt");
      expect(result.stderr).toContain("merge conflict in a.txt");
      expect(result.stderr).toContain("nsit commit");
      expect(result.stderr).toContain("nsit pull --abort");
      const content = readFileSync(join(b.dir, "a.txt"), "utf8");
      expect(content).toContain("<<<<<<<");
      expect(content).toContain("from b");
      expect(content).toContain("from a");
      expect(content).toContain(">>>>>>> origin/main");

      // Real git sees an ordinary merge that stopped on a conflict.
      expect(await realGit(b.dir, "status")).toContain("You have unmerged paths");
      expect((await realGit(b.dir, "status", "--porcelain")).trimEnd()).toBe("UU a.txt");
      expect(readFileSync(join(b.dir, ".git", "MERGE_HEAD"), "utf8").trim()).toBe(theirs);
      expect(readFileSync(join(b.dir, ".git", "MERGE_MSG"), "utf8")).toContain(`Merge branch 'main' of ${ins.base}/ada/pull-conflict.git`);
      expect(await ref(b.dir, "HEAD")).toBe(mine);
      expect(await ref(b.dir, "ORIG_HEAD")).toBe(mine);
      expect(await ref(b.dir, "refs/remotes/origin/main")).toBe(theirs);
      expect(await statusOf(b)).toMatchObject({ conflicted: ["a.txt"], staged: [], unstaged: [] });

      // Finishing before the conflict is resolved is refused (exit 4), and changes nothing.
      const early = await nsitIn(b, "commit", "-m", "done");
      expect(early.code, early.stderr).toBe(4);
      expect(early.stderr).toContain("a.txt");
      expect(await ref(b.dir, "HEAD")).toBe(mine);
      expect(merging(b)).toBe(true);
      // A second pull is refused while a merge is waiting, and says how to go on.
      const second = await pullIn(b);
      expect(second.code, second.stderr).toBe(2);
      expect(second.stdout).toBe("");
      expect(second.stderr).toMatch(/nsit commit.*nsit pull --abort/);
      expect(oneLine(second.stderr), second.stderr).toBe(true);
      expect(await ref(b.dir, "HEAD")).toBe(mine);

      // What a person adds while resolving is still held to the secret guard...
      const token = `ghp_${"Ab1".repeat(14)}`;
      writeFileSync(join(b.dir, "a.txt"), `resolved, with ${token}\n`);
      const guarded = await nsitIn(b, "commit", "-m", "done");
      expect(guarded.code, guarded.stderr).toBe(5);
      expect(guarded.stderr).toContain("a.txt");
      expect(guarded.stderr).not.toContain(token);
      expect(merging(b)).toBe(true);
      // ...and a clean resolution finishes the merge: two parents, no merge state, a clean tree for real git.
      writeFileSync(join(b.dir, "a.txt"), "resolved\n");
      const done = await nsitIn(b, "commit", "-m", "done", "--json");
      expect(done.code, done.stderr).toBe(0);
      const merged = await ref(b.dir, "HEAD");
      expect(JSON.parse(done.stdout).sha).toBe(merged);
      expect(await parentsOfHead(b.dir)).toEqual([mine, theirs]);
      expect(await realGit(b.dir, "log", "-1", "--format=%s")).toBe("done\n");
      expect(merging(b)).toBe(false);
      for (const state of MERGE_STATE) expect(existsSync(join(b.dir, ".git", state)), state).toBe(false);
      expect(await realGit(b.dir, "status", "--porcelain")).toBe("");
      await realGit(b.dir, "fsck", "--strict");

      // It pushes, and the other clone gets the resolution.
      await pushIn(b);
      const back = await pullIn(a);
      expect(back.code, back.stderr).toBe(0);
      expect(readFileSync(join(a.dir, "a.txt"), "utf8")).toBe("resolved\n");
    },
    SLOW,
  );

  it(
    "pull --abort puts HEAD, the files and the index back exactly as they were before the pull; untracked files stay",
    async () => {
      const { a, b } = await twoClones("pull-abort");
      await publish(a, "added.txt", "theirs only\n", "A adds added.txt");
      await publish(a, "a.txt", "from a\n", "A edits a.txt");
      const mine = await commitIn(b, "a.txt", "from b\n", "B edits a.txt");
      writeFileSync(join(b.dir, "scratch.txt"), "untracked\n");
      const index = await realGit(b.dir, "ls-files", "--stage");
      const filesBefore = workingFiles(b.dir);

      const conflict = await pullIn(b, "--json");
      expect(conflict.code, conflict.stderr).toBe(4);
      expect(JSON.parse(conflict.stdout)).toEqual({ result: "conflict", head: mine, conflicts: ["a.txt"] });
      expect(existsSync(join(b.dir, "added.txt")), "the merge brought this file in").toBe(true);
      // A person had started on the conflict, touched a file the merge brought in, and changes their mind.
      writeFileSync(join(b.dir, "a.txt"), "half resolved\n");
      writeFileSync(join(b.dir, "added.txt"), "edited by me\n");

      const abort = await pullIn(b, "--abort");
      expect(abort.code, abort.stderr).toBe(0);
      // It says plainly what it did to the work in the merge.
      expect(abort.stdout).toBe(
        `Merge aborted; main is back at ${mine.slice(0, 7)}, with the files as they were before the pull (changes made while resolving the conflicts were thrown away)\n`,
      );
      expect(await ref(b.dir, "HEAD")).toBe(mine);
      expect(await realGit(b.dir, "ls-files", "--stage")).toBe(index);
      expect(workingFiles(b.dir)).toEqual(filesBefore);
      for (const state of MERGE_STATE) expect(existsSync(join(b.dir, ".git", state)), state).toBe(false);
      expect((await realGit(b.dir, "status", "--porcelain")).trimEnd()).toBe("?? scratch.txt");
      await realGit(b.dir, "diff", "--quiet");
      await realGit(b.dir, "diff", "--cached", "--quiet");
      expect(await statusOf(b)).toMatchObject({ conflicted: [], staged: [], unstaged: [], untracked: ["scratch.txt"] });

      // There is nothing left to abort.
      const nothing = await pullIn(b, "--abort");
      expect(nothing.code, nothing.stderr).toBe(2);
      expect(nothing.stdout).toBe("");
      expect(nothing.stderr).toMatch(/^nsit: .*no merge in progress/);
      expect(oneLine(nothing.stderr), nothing.stderr).toBe(true);

      // The same pull stops on the same conflict again: the state really was cleaned up. --json for the abort.
      const again = await pullIn(b);
      expect(again.code, again.stderr).toBe(4);
      const json = await pullIn(b, "--abort", "--json");
      expect(json.code, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual({ result: "aborted", head: mine, conflicts: [] });
      expect(workingFiles(b.dir)).toEqual(filesBefore);
    },
    SLOW,
  );

  it(
    "pull --abort refuses to discard edits to tracked files the merge did not touch (exit 2, they are named): the merge, those edits and the untracked files all stay",
    async () => {
      const { a, b } = await twoClones("pull-abort-refuse");
      await publish(a, "a.txt", "from a\n", "A edits a.txt");
      const mine = await commitIn(b, "a.txt", "from b\n", "B edits a.txt");
      writeFileSync(join(b.dir, "scratch.txt"), "untracked\n");
      const filesBefore = workingFiles(b.dir);
      const conflict = await pullIn(b);
      expect(conflict.code, conflict.stderr).toBe(4);
      // While resolving, a person also edited keep.txt (which the merge never touched) and staged a new file.
      writeFileSync(join(b.dir, "keep.txt"), "edited while resolving\n");
      writeFileSync(join(b.dir, "extra.txt"), "a new file\n");
      expect((await nsitIn(b, "add", "extra.txt")).code).toBe(0);
      const mergeHead = join(b.dir, ".git", "MERGE_HEAD");
      const before = {
        head: await ref(b.dir, "HEAD"),
        orig: await ref(b.dir, "ORIG_HEAD"),
        index: await realGit(b.dir, "ls-files", "--stage"),
        status: await realGit(b.dir, "status", "--porcelain"),
        files: workingFiles(b.dir),
        mergeHead: readFileSync(mergeHead, "utf8"),
      };

      const refused = await pullIn(b, "--abort");
      expect(refused.code, refused.stderr).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toMatch(/^nsit: cannot abort the merge: changes to extra\.txt, keep\.txt were made after the pull stopped/);
      expect(refused.stderr).toContain("commit or revert them first");
      expect(refused.stderr).not.toContain("scratch.txt");
      expect(oneLine(refused.stderr), refused.stderr).toBe(true);
      // Nothing moved: the merge is still waiting, with its conflict, and so are the edits.
      expect(existsSync(mergeHead)).toBe(true);
      expect({
        head: await ref(b.dir, "HEAD"),
        orig: await ref(b.dir, "ORIG_HEAD"),
        index: await realGit(b.dir, "ls-files", "--stage"),
        status: await realGit(b.dir, "status", "--porcelain"),
        files: workingFiles(b.dir),
        mergeHead: readFileSync(mergeHead, "utf8"),
      }).toEqual(before);
      expect(await realGit(b.dir, "status")).toContain("You have unmerged paths");
      expect(readFileSync(join(b.dir, "a.txt"), "utf8")).toContain("<<<<<<<");

      // Take the two edits back (real git here: nsit has no revert), and the abort goes through.
      await realGit(b.dir, "checkout", "--", "keep.txt");
      await realGit(b.dir, "rm", "-q", "-f", "--cached", "extra.txt");
      rmSync(join(b.dir, "extra.txt"));
      const done = await pullIn(b, "--abort");
      expect(done.code, done.stderr).toBe(0);
      expect(await ref(b.dir, "HEAD")).toBe(mine);
      expect(workingFiles(b.dir)).toEqual(filesBefore);
      expect(existsSync(mergeHead)).toBe(false);
      expect(readFileSync(join(b.dir, "scratch.txt"), "utf8")).toBe("untracked\n");
    },
    SLOW,
  );

  it(
    "refuses a fast-forward that would overwrite uncommitted work (exit 1, the file is named) and changes nothing; an unrelated edit is carried along",
    async () => {
      const { a, b } = await twoClones("pull-dirty-ff");
      const theirs = await publish(a, "a.txt", "from a\n", "A edits a.txt");
      writeFileSync(join(b.dir, "a.txt"), "my work, not committed\n");
      const before = await snapshot(b.dir);

      const refused = await pullIn(b);
      expect(refused.code, refused.stderr).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("a.txt");
      expect(oneLine(refused.stderr), refused.stderr).toBe(true);
      expect(readFileSync(join(b.dir, "a.txt"), "utf8")).toBe("my work, not committed\n");
      expect(await snapshot(b.dir), "no ref moved, the tracking ref included").toEqual(before);
      expect(await ref(b.dir, "ORIG_HEAD")).toBe("");

      // Put that file back and edit one the pull does not touch: the fast-forward keeps the edit.
      await realGit(b.dir, "checkout", "--", "a.txt");
      writeFileSync(join(b.dir, "keep.txt"), "unrelated edit\n");
      const carried = await pullIn(b);
      expect(carried.code, carried.stderr).toBe(0);
      expect(await ref(b.dir, "HEAD")).toBe(theirs);
      expect(readFileSync(join(b.dir, "keep.txt"), "utf8")).toBe("unrelated edit\n");
      expect(readFileSync(join(b.dir, "a.txt"), "utf8")).toBe("from a\n");
    },
    SLOW,
  );

  it(
    "a pull that has to merge needs the tracked files committed (exit 1, they are named): nothing changes, so an abort can never lose them",
    async () => {
      const { a, b } = await twoClones("pull-dirty-merge");
      await publish(a, "a.txt", "from a\n", "A edits a.txt");
      await commitIn(b, "mine.txt", "mine\n", "B adds mine.txt");
      writeFileSync(join(b.dir, "keep.txt"), "uncommitted, and nothing to do with a.txt\n");
      writeFileSync(join(b.dir, "scratch.txt"), "untracked\n");
      const before = await snapshot(b.dir);
      const filesBefore = workingFiles(b.dir);

      const refused = await pullIn(b);
      expect(refused.code, refused.stderr).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("keep.txt");
      expect(refused.stderr, "untracked files are not in the way").not.toContain("scratch.txt");
      expect(oneLine(refused.stderr), refused.stderr).toBe(true);
      expect(await snapshot(b.dir)).toEqual(before);
      expect(workingFiles(b.dir)).toEqual(filesBefore);
      expect(await ref(b.dir, "ORIG_HEAD")).toBe("");
      expect(merging(b)).toBe(false);

      // Committed (only that file: --staged), the same pull merges, and the untracked file is left alone.
      expect((await nsitIn(b, "add", "keep.txt")).code).toBe(0);
      const committed = await nsitIn(b, "commit", "--staged", "-m", "B edits keep.txt");
      expect(committed.code, committed.stderr).toBe(0);
      const merged = await pullIn(b);
      expect(merged.code, merged.stderr).toBe(0);
      expect(merged.stdout).toBe("Merged origin/main\n");
      expect(readFileSync(join(b.dir, "scratch.txt"), "utf8")).toBe("untracked\n");
      expect(readFileSync(join(b.dir, "a.txt"), "utf8")).toBe("from a\n");
    },
    SLOW,
  );

  it(
    "an untracked file where the pull would write one is refused (exit 1, it is named), for a fast-forward and for a merge",
    async () => {
      // Fast-forward.
      const ff = await twoClones("pull-untracked-ff");
      await publish(ff.a, "new.txt", "from a\n", "A adds new.txt");
      writeFileSync(join(ff.b.dir, "new.txt"), "mine, untracked\n");
      const ffBefore = await snapshot(ff.b.dir);
      const ffResult = await pullIn(ff.b);
      expect(ffResult.code, ffResult.stderr).toBe(1);
      expect(ffResult.stderr).toContain("new.txt");
      expect(oneLine(ffResult.stderr), ffResult.stderr).toBe(true);
      expect(readFileSync(join(ff.b.dir, "new.txt"), "utf8")).toBe("mine, untracked\n");
      expect(await snapshot(ff.b.dir)).toEqual(ffBefore);

      // Merge: diverge first, then the untracked file appears.
      const mg = await twoClones("pull-untracked-merge");
      await publish(mg.a, "new.txt", "from a\n", "A adds new.txt");
      await commitIn(mg.b, "mine.txt", "mine\n", "B adds mine.txt");
      writeFileSync(join(mg.b.dir, "new.txt"), "mine, untracked\n");
      const mgBefore = await snapshot(mg.b.dir);
      const mgResult = await pullIn(mg.b);
      expect(mgResult.code, mgResult.stderr).toBe(1);
      expect(mgResult.stderr).toContain("new.txt");
      expect(oneLine(mgResult.stderr), mgResult.stderr).toBe(true);
      expect(readFileSync(join(mg.b.dir, "new.txt"), "utf8")).toBe("mine, untracked\n");
      expect(await snapshot(mg.b.dir)).toEqual(mgBefore);
      expect(await ref(mg.b.dir, "ORIG_HEAD")).toBe("");
      expect(merging(mg.b)).toBe(false);

      // An untracked file that is not in the way is no problem.
      rmSync(join(mg.b.dir, "new.txt"));
      writeFileSync(join(mg.b.dir, "scratch.txt"), "untracked\n");
      const fine = await pullIn(mg.b);
      expect(fine.code, fine.stderr).toBe(0);
      expect(readFileSync(join(mg.b.dir, "scratch.txt"), "utf8")).toBe("untracked\n");
      expect(readFileSync(join(mg.b.dir, "new.txt"), "utf8")).toBe("from a\n");
    },
    SLOW,
  );

  it(
    "an ignored file where the pull would write one is never overwritten: refused by name (exit 1) for a fast-forward and for a merge, nothing moves",
    async () => {
      // The incoming commit adds new.txt, and build/out.txt below a directory that is ignored here.
      const incoming = async (a: Work) => {
        mkdirSync(join(a.dir, "build"));
        writeFileSync(join(a.dir, "build", "out.txt"), "from a\n");
        return publish(a, "new.txt", "from a\n", "A adds new.txt and build/out.txt");
      };
      const ignoreLocally = async (b: Work) => {
        // .git/info/exclude: an ignore rule that is not a file of the working tree.
        mkdirSync(join(b.dir, ".git", "info"), { recursive: true });
        writeFileSync(join(b.dir, ".git", "info", "exclude"), "new.txt\nbuild/\n");
        mkdirSync(join(b.dir, "build"), { recursive: true });
        writeFileSync(join(b.dir, "new.txt"), "mine, ignored\n");
        writeFileSync(join(b.dir, "build", "out.txt"), "mine, ignored too\n");
        writeFileSync(join(b.dir, "build", "other.txt"), "ignored, not in the way\n");
        expect(await realGit(b.dir, "status", "--porcelain"), "git agrees these are ignored").toBe("");
      };

      for (const kind of ["fast-forward", "merge"]) {
        const { a, b } = await twoClones(`pull-ignored-${kind === "merge" ? "merge" : "ff"}`);
        await incoming(a);
        if (kind === "merge") await commitIn(b, "mine.txt", "mine\n", "B adds mine.txt");
        await ignoreLocally(b);
        const before = await snapshot(b.dir);
        const filesBefore = workingFiles(b.dir);

        const refused = await pullIn(b);
        expect(refused.code, `${kind}: ${refused.stderr}`).toBe(1);
        expect(refused.stdout).toBe("");
        expect(refused.stderr).toContain("new.txt");
        expect(refused.stderr).toContain("build/out.txt");
        expect(refused.stderr).not.toContain("other.txt");
        expect(oneLine(refused.stderr), refused.stderr).toBe(true);
        expect(await snapshot(b.dir), `${kind}: no ref moved`).toEqual(before);
        expect(workingFiles(b.dir), `${kind}: no file was touched`).toEqual(filesBefore);
        expect(await ref(b.dir, "ORIG_HEAD")).toBe("");
        expect(merging(b)).toBe(false);

        // Out of the way, the pull goes through, and the ignored file that was never in the way is left alone.
        rmSync(join(b.dir, "new.txt"));
        rmSync(join(b.dir, "build", "out.txt"));
        const done = await pullIn(b);
        expect(done.code, `${kind}: ${done.stderr}`).toBe(0);
        expect(readFileSync(join(b.dir, "new.txt"), "utf8")).toBe("from a\n");
        expect(readFileSync(join(b.dir, "build", "out.txt"), "utf8")).toBe("from a\n");
        expect(readFileSync(join(b.dir, "build", "other.txt"), "utf8")).toBe("ignored, not in the way\n");
      }
    },
    SLOW,
  );

  it(
    "a new file that is staged (here a .env) stops a pull that has to merge, and nothing is committed: pull's merge commit is not run through the secret guard, so nothing uncommitted may reach it",
    async () => {
      const { a, b } = await twoClones("pull-staged-env");
      await publish(a, "a.txt", "from a\n", "A edits a.txt");
      const mine = await commitIn(b, "keep.txt", "from b\n", "B edits keep.txt");
      writeFileSync(join(b.dir, ".env"), "TOKEN=abc\n");
      expect((await nsitIn(b, "add", ".env")).code).toBe(0);
      const before = await snapshot(b.dir);
      const index = await realGit(b.dir, "ls-files", "--stage");
      expect(index).toContain(".env");

      const refused = await pullIn(b);
      expect(refused.code, refused.stderr).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain(".env");
      expect(oneLine(refused.stderr), refused.stderr).toBe(true);
      expect(await ref(b.dir, "HEAD")).toBe(mine);
      expect(await realGit(b.dir, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(".env");
      expect(await snapshot(b.dir)).toEqual(before);
      expect(await realGit(b.dir, "ls-files", "--stage")).toBe(index);
      expect(merging(b)).toBe(false);
      expect(await ref(b.dir, "ORIG_HEAD")).toBe("");
    },
    SLOW,
  );

  it(
    "says what is wrong when there is nothing to pull from (exit 2): no upstream, a detached HEAD, a remote that is not there",
    async () => {
      const env = homeWith(true);
      const usage = async (result: Promise<NsitResult>, pattern: RegExp) => {
        const done = await result;
        expect(done.code, done.stderr).toBe(2);
        expect(done.stdout).toBe("");
        expect(done.stderr).toMatch(pattern);
        expect(oneLine(done.stderr), done.stderr).toBe(true);
      };

      // A repository that was never pushed: no origin, so no upstream; the hint is nsit push.
      const local = tmpDir();
      expect((await nsit(["-C", local, "init"], { env })).code).toBe(0);
      writeFileSync(join(local, "a.txt"), "a\n");
      expect((await nsit(["-C", local, "commit", "-m", "one"], { env })).code).toBe(0);
      await usage(nsit(["-C", local, ...pull()], { configDir: adaDir, env }), /^nsit: .*no upstream.*nsit push/);

      // An origin made by init, and nothing pushed yet: still no upstream.
      const fresh = join(tmpDir(), "pull-no-upstream");
      mkdirSync(fresh);
      expect((await nsit(["-C", fresh, "init", "--remote", "--host", ins.base], { configDir: adaDir, env })).code).toBe(0);
      await usage(nsit(["-C", fresh, ...pull()], { configDir: adaDir, env }), /^nsit: .*no upstream.*nsit push/);

      // A detached HEAD has no branch to bring up to date.
      const { b } = await twoClones("pull-usage");
      await realGit(b.dir, "checkout", "--detach", "-q");
      await usage(pullIn(b), /^nsit: .*detached/);
      await realGit(b.dir, "checkout", "-q", "main");

      // An upstream that names a remote that is not there, and one that is not a branch.
      await realGit(b.dir, "config", "branch.main.remote", "nowhere");
      await usage(pullIn(b), /^nsit: .*nowhere/);
      await realGit(b.dir, "config", "branch.main.remote", "origin");
      await realGit(b.dir, "config", "branch.main.merge", "refs/tags/v1");
      await usage(pullIn(b), /^nsit: .*refs\/tags\/v1/);
    },
    SLOW,
  );

  it("signed out, with stdin an open pipe: exit 3 within 5 s with a sign-in hint, and nothing moves", async () => {
    const { a, b } = await twoClones("pull-signedout");
    await publish(a, "late.txt", "late\n", "Late");
    const before = await snapshot(b.dir);
    for (const extra of [[], ["--json"]]) {
      const started = performance.now();
      // A fresh config directory, no NSIT_TOKEN, stdin open and silent: a read would hang.
      const result = await nsit(["-C", b.dir, ...pull(...extra)], { env: b.env, stdin: "open", timeoutMs: 5_000 });
      expect(result.code, result.stderr).toBe(3);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`nsit: not signed in to ${hostKey}; run nsit auth login\n`);
      expect(performance.now() - started).toBeLessThan(5_000);
    }
    expect(await snapshot(b.dir)).toEqual(before);
    expect(readdirSync(b.dir)).not.toContain("late.txt");
  }, SLOW);

  it("an origin on another server never gets NSIT_TOKEN (exit 3), and nothing moves", async () => {
    const { b } = await twoClones("pull-elsewhere");
    await realGit(b.dir, "remote", "set-url", "origin", "https://other.example/ada/pull-elsewhere.git");
    const before = await snapshot(b.dir);
    const result = await nsit(["-C", b.dir, ...pull()], { env: { ...b.env, NSIT_TOKEN: newToken("agent") }, timeoutMs: 5_000 });
    expect(result.code, result.stderr).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("nsit: NSIT_TOKEN is sent only to the selected host, and other.example is not it\n");
    expect(await snapshot(b.dir)).toEqual(before);
  }, SLOW);

  it("an upstream branch the server no longer has is exit 1 with one line, and nothing moves", async () => {
    const { b } = await twoClones("pull-gone");
    await realGit(serverRepo("ada", "pull-gone"), "update-ref", "-d", "refs/heads/main");
    const before = await snapshot(b.dir);
    const result = await pullIn(b);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^nsit: .*main/);
    expect(oneLine(result.stderr), result.stderr).toBe(true);
    expect(await snapshot(b.dir)).toEqual(before);
  }, SLOW);

  it("a server that has stopped: exit 1, one line, no token anywhere, and nothing moves", async () => {
    const gone = await startInsitio();
    try {
      const user = createUser(gone.deps.db, { username: "ada", password: "longenough", email: "ada@example.com" });
      const token = createAccessToken(gone.deps.db, user.id, "e2e");
      secrets.add(token);
      const configDir = tmpDir();
      const env = homeWith(true);
      expect((await nsit(["auth", "login", "--with-token", "--host", gone.base], { configDir, input: token })).code).toBe(0);
      const cwd = tmpDir();
      const init = await nsit(["init", "pull-stopped", "--readme", "--host", gone.base], { cwd, configDir, env });
      expect(init.code, init.stderr).toBe(0);
      const dir = join(cwd, "pull-stopped");
      const before = await snapshot(dir);
      await gone.close();

      // Once with the token nsit saved, once with NSIT_TOKEN (which is asked about first, over the API).
      for (const [how, opts] of [
        ["saved token", { configDir, env }],
        ["NSIT_TOKEN", { configDir: tmpDir(), env: { ...env, NSIT_TOKEN: token } }],
      ] as const) {
        const result = await nsit(["-C", dir, "pull", "--host", gone.base], { ...opts, timeoutMs: 15_000 });
        expect(result.code, `${how}: ${result.stderr}`).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toMatch(/^nsit: \S/);
        expect(oneLine(result.stderr), `${how}: ${result.stderr}`).toBe(true);
        expect(result.stderr + result.stdout).not.toContain(token);
        expect(await snapshot(dir), `${how}: nothing moved`).toEqual(before);
      }
    } finally {
      await gone.close();
    }
  }, SLOW);

  it(
    "pull's own merge commit is not held up by the secret guard: secrets that came with either side are not the pull's to refuse",
    async () => {
      const { a, b } = await twoClones("pull-guard");
      // Both sides committed a secret-looking file with real git (nsit's own guard would have refused them).
      writeFileSync(join(a.dir, ".env"), "A_SECRET=1\n");
      await realGit(a.dir, "add", "-A");
      await realGit(a.dir, "commit", "-q", "-m", "A adds .env");
      await pushIn(a);
      writeFileSync(join(b.dir, "mine.pem"), "not really a key\n");
      await realGit(b.dir, "add", "-A");
      await realGit(b.dir, "commit", "-q", "-m", "B adds mine.pem");

      const result = await pullIn(b);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("Merged origin/main\n");
      expect((await parentsOfHead(b.dir)).length).toBe(2);
      expect(readFileSync(join(b.dir, ".env"), "utf8")).toBe("A_SECRET=1\n");
      expect(readFileSync(join(b.dir, "mine.pem"), "utf8")).toBe("not really a key\n");
      expect(await realGit(b.dir, "status", "--porcelain")).toBe("");
    },
    SLOW,
  );

  it(
    "with core.autocrlf=true what is pulled arrives with CRLF in the working tree and nothing counts as modified (fast-forward and merge)",
    async () => {
      const home = homeWith(true, true);
      const { a, b } = await twoClones("pull-crlf", { "lf.txt": "alpha\nbeta\n", "other.txt": "other\n" }, home);
      const fromA = await publish(a, "lf.txt", "alpha\nbeta\ngamma\n", "A extends lf.txt");

      const ff = await pullIn(b);
      expect(ff.code, ff.stderr).toBe(0);
      expect(await ref(b.dir, "HEAD")).toBe(fromA);
      expect(readFileSync(join(b.dir, "lf.txt")), "LF in the repository, CRLF in the working tree").toEqual(Buffer.from("alpha\r\nbeta\r\ngamma\r\n"));
      expect((await statusOf(b)).unstaged).toEqual([]);
      expect(await gitSeeing(home, b.dir, "status", "--porcelain")).toBe("");

      // And through a merge.
      await publish(a, "lf.txt", "alpha\nbeta\ngamma\ndelta\n", "A extends lf.txt again");
      await commitIn(b, "other.txt", "other, edited\n", "B edits other.txt");
      const merged = await pullIn(b);
      expect(merged.code, merged.stderr).toBe(0);
      expect(merged.stdout).toBe("Merged origin/main\n");
      expect(readFileSync(join(b.dir, "lf.txt"))).toEqual(Buffer.from("alpha\r\nbeta\r\ngamma\r\ndelta\r\n"));
      expect((await statusOf(b)).unstaged).toEqual([]);
      expect(await gitSeeing(home, b.dir, "status", "--porcelain")).toBe("");

      // And a conflict, then an abort: with line endings converted, nothing may look like an edit
      // made after the pull stopped (that would refuse the abort for no reason).
      await publish(a, "other.txt", "other, from a\n", "A edits other.txt");
      const mineAgain = await commitIn(b, "other.txt", "other, from b\n", "B edits other.txt again");
      const conflict = await pullIn(b);
      expect(conflict.code, conflict.stderr).toBe(4);
      const abort = await pullIn(b, "--abort");
      expect(abort.code, abort.stderr).toBe(0);
      expect(await ref(b.dir, "HEAD")).toBe(mineAgain);
      expect((await statusOf(b)).unstaged).toEqual([]);
      expect(await gitSeeing(home, b.dir, "status", "--porcelain")).toBe("");
    },
    SLOW,
  );

  it("(Review Focus 1) works in a directory with spaces and an accent: with -C, and as the working directory", async () => {
    await seedRepo("pull-unicode", { "a.txt": "base\n" });
    const name = "Vidéo Ink - OG Edition";
    const cwd = tmpDir();
    const env = homeWith(true);
    const cloned = await nsit(["clone", "ada/pull-unicode", name, "--host", ins.base], { cwd, configDir: adaDir, env });
    expect(cloned.code, cloned.stderr).toBe(0);
    const b: Work = { dir: join(cwd, name), env, configDir: adaDir };
    const a = await cloneOf("ada/pull-unicode", adaDir);

    const first = await publish(a, "ünï côdé.txt", "accented\n", "A adds an accented file");
    const viaC = await nsit(["-C", b.dir, ...pull("--json")], { configDir: adaDir, env, cwd: tmpDir() });
    expect(viaC.code, viaC.stderr).toBe(0);
    expect(JSON.parse(viaC.stdout)).toEqual({ result: "fast_forward", head: first, conflicts: [] });
    expect(readFileSync(join(b.dir, "ünï côdé.txt"), "utf8")).toBe("accented\n");

    const second = await publish(a, "more.txt", "more\n", "A adds more.txt");
    const here = await nsit(pull("--json"), { cwd: b.dir, configDir: adaDir, env });
    expect(here.code, here.stderr).toBe(0);
    expect(JSON.parse(here.stdout)).toEqual({ result: "fast_forward", head: second, conflicts: [] });
    expect(await realGit(b.dir, "status", "--porcelain")).toBe("");
  }, SLOW);
});

// ---- a larger repository (Review Focus 5) -------------------------------------------------------

// Set NSIT_SKIP_SCALE=1 to leave this out (it moves about 20 MB over the loopback and takes a
// minute or two); it runs by default, and in CI.
const skipScale = /^(1|true|yes)$/i.test(process.env.NSIT_SKIP_SCALE ?? "");
const SCALE_COMMITS = 2_000;
const SCALE_BLOB_BYTES = 20 * 1024 * 1024;
/** The push and the clone together must finish within this. */
const SCALE_BUDGET_MS = 120_000;
/**
 * The most a test of its own may take: generating the repository, the budget above (with room to
 * report how far over it was instead of being killed first), and the checks. The two `nsit`
 * processes get less than this each, so a hung one is killed with its output before vitest gives up.
 */
const SCALE_TEST_TIMEOUT = 300_000;
const SCALE_PROCESS_TIMEOUT = 150_000;

/** Runs real git with `input` on its stdin; rejects with git's own words when it fails. */
function realGitWith(cwd: string, input: Buffer, ...args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.autocrlf=false", ...args], { cwd, env: gitEnv, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.stdin.on("error", () => {}); // git exited early: its own message is the one to report
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed in ${cwd} (exit ${code}): ${stderr}`))));
    child.stdin.end(input);
  });
}

/**
 * A `git fast-import` stream: `commits` small commits on main (each rewrites one of a hundred
 * text files, so the history is long and the trees are real), then one commit that adds `blob`.
 */
function fastImportStream(commits: number, blob: Buffer): Buffer {
  const parts: Buffer[] = [];
  const epoch = 1_700_000_000;
  const add = (n: number, message: string, path: string, content: Buffer) => {
    parts.push(Buffer.from(`commit refs/heads/main\ncommitter Scale Test <scale@example.com> ${epoch + n} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`));
    parts.push(Buffer.from(`M 100644 inline ${path}\ndata ${content.length}\n`), content, Buffer.from("\n"));
  };
  for (let n = 0; n < commits; n++) {
    const file = n % 100;
    const text = `revision ${Math.floor(n / 100)} of file ${file}, written by commit ${n}\n` + `${n} `.repeat(60) + "\n";
    add(n, `Commit ${n}`, `files/f${String(file).padStart(2, "0")}.txt`, Buffer.from(text));
  }
  add(commits, "Add a 20 MB binary", "big.bin", blob);
  return Buffer.concat(parts);
}

describe.skipIf(skipScale)("nsit at scale (Review Focus 5)", () => {
  it(
    `pushes and clones ${SCALE_COMMITS.toLocaleString("en-US")} commits and a 20 MB blob in ${SCALE_BUDGET_MS / 1000} s, with no progress off a terminal`,
    async () => {
      const dirs: string[] = [];
      const tmp = () => {
        const dir = tmpDir();
        dirs.push(dir);
        return dir;
      };
      const timings: Record<string, number> = {};
      const timed = async <T>(phase: string, work: () => Promise<T>): Promise<T> => {
        const started = performance.now();
        try {
          return await work();
        } finally {
          timings[phase] = performance.now() - started;
        }
      };
      const seconds = () => Object.entries(timings).map(([phase, ms]) => `${phase} ${(ms / 1000).toFixed(1)} s`).join(", ");
      const noProgress = (what: string, result: NsitResult) => {
        // What a terminal would show while a pack moves: redrawn lines (\r) and git's progress words.
        expect(result.stdout + result.stderr, `${what} wrote progress off a terminal`).not.toMatch(/\r|Writing objects|Receiving objects|Resolving deltas|Compressing objects|Counting objects/);
      };

      try {
        // The repository: real git builds it in one stream, in a directory with spaces in its name.
        const blob = randomBytes(SCALE_BLOB_BYTES); // random: packing cannot make it smaller
        const blobSha256 = createHash("sha256").update(blob).digest("hex");
        const source = join(tmp(), "Scale Source");
        mkdirSync(source);
        await timed("generate", async () => {
          await realGit(source, "init", "-q", "-b", "main");
          await realGitWith(source, fastImportStream(SCALE_COMMITS, blob), "fast-import", "--quiet");
          await realGit(source, "reset", "-q", "--hard", "main");
        });
        const head = (await realGit(source, "rev-parse", "HEAD")).trim();
        expect((await realGit(source, "rev-list", "--count", "HEAD")).trim()).toBe(String(SCALE_COMMITS + 1));
        expect((await realGit(source, "cat-file", "-s", "HEAD:big.bin")).trim()).toBe(String(SCALE_BLOB_BYTES));

        // A server repository for it, and origin set the way a person would.
        const configDir = tmp();
        await signIn(configDir);
        const made = await nsit(["repo", "create", "big", "--host", ins.base], { configDir });
        expect(made.code, made.stderr).toBe(0);
        await realGit(source, "remote", "add", "origin", `${ins.base}/ada/big.git`);
        const env = homeWith(true);

        const pushed = await timed("push", () => nsit(["-C", source, "push", "--host", ins.base], { configDir, env, timeoutMs: SCALE_PROCESS_TIMEOUT }));
        expect(pushed.code, `${pushed.stderr} (${seconds()})`).toBe(0);
        expect(pushed.stdout).toBe("Pushed main to ada/big\n");
        expect(pushed.stderr, "nothing but data off a terminal").toBe("");
        noProgress("push", pushed);

        const cwd = tmp();
        const cloned = await timed("clone", () => nsit(["clone", "ada/big", "copy", "--host", ins.base], { cwd, configDir, env, timeoutMs: SCALE_PROCESS_TIMEOUT }));
        expect(cloned.code, `${cloned.stderr} (${seconds()})`).toBe(0);
        expect(cloned.stdout).toMatch(/^Cloned ada\/big into .*copy\n$/);
        expect(cloned.stderr, "nothing but data off a terminal").toBe("");
        noProgress("clone", cloned);

        // Both together are within the budget.
        const wall = timings.push! + timings.clone!;
        // Where the time went, in the log of the run (CI included), whether or not the test passes.
        console.info(`nsit at scale: ${seconds()} (push + clone ${(wall / 1000).toFixed(1)} s of ${SCALE_BUDGET_MS / 1000} s)`);
        expect(wall, `push and clone took ${(wall / 1000).toFixed(1)} s (${seconds()})`).toBeLessThanOrEqual(SCALE_BUDGET_MS);

        // What arrived is what was sent: the server (read by real git on its disk) and the clone.
        await timed("verify", async () => {
          const bare = serverRepo("ada", "big");
          const copy = join(cwd, "copy");
          expect((await realGit(bare, "rev-parse", "refs/heads/main")).trim(), "the server's branch").toBe(head);
          expect((await realGit(bare, "rev-list", "--count", "refs/heads/main")).trim()).toBe(String(SCALE_COMMITS + 1));
          expect((await realGit(bare, "cat-file", "-s", "main:big.bin")).trim()).toBe(String(SCALE_BLOB_BYTES));
          await realGit(bare, "fsck", "--strict");

          expect((await realGit(copy, "rev-parse", "HEAD")).trim(), "the clone's HEAD").toBe(head);
          expect((await realGit(copy, "rev-list", "--count", "HEAD")).trim()).toBe(String(SCALE_COMMITS + 1));
          expect((await realGit(copy, "cat-file", "-s", "HEAD:big.bin")).trim()).toBe(String(SCALE_BLOB_BYTES));
          const checkedOut = readFileSync(join(copy, "big.bin"));
          expect(checkedOut.length).toBe(SCALE_BLOB_BYTES);
          expect(createHash("sha256").update(checkedOut).digest("hex"), "the blob's SHA-256").toBe(blobSha256);
          expect(await realGit(copy, "status", "--porcelain")).toBe("");
          await realGit(copy, "fsck", "--strict");
          expect((await realGit(copy, "rev-parse", "--abbrev-ref", "main@{upstream}")).trim()).toBe("origin/main");
        });
        console.info(`nsit at scale: ${seconds()}`);
      } finally {
        // About 100 MB of repositories: do not leave them behind.
        for (const dir of [...dirs, serverRepo("ada", "big")]) {
          try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
          } catch {
            // a file still held open (Windows): the operating system's temp cleanup gets it
          }
        }
      }
    },
    SCALE_TEST_TIMEOUT,
  );
});
