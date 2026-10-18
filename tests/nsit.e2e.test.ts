import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { decideDevice, findPendingByUserCode } from "../src/services/devices.js";
import { getRepo } from "../src/services/repos.js";
import { createAccessToken, createUser, listAccessTokens, type User } from "../src/services/users.js";
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
    const timings: Record<string, number> = {};
    for (const args of [["list"], ["list", "--json"], ["list", "--owner", "ada"], ["create", "tools"], ["view", "ada/tools"], ["view", "tools"]]) {
      const started = performance.now();
      // No NSIT_TOKEN (the test environment removes it), no config, stdin open and silent: a read would hang.
      const result = await nsit(repo(...args), { stdin: "open", timeoutMs: 5_000 });
      const elapsed = performance.now() - started;
      timings[args.join(" ")] = Math.round(elapsed);
      expect(result.code, `repo ${args.join(" ")}: ${result.stderr}`).toBe(3);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("nsit auth login");
      expect(result.stderr).toBe(`nsit: not signed in to ${hostKey}; run nsit auth login\n`);
      expect(elapsed, `repo ${args.join(" ")} took ${elapsed} ms`).toBeLessThan(5_000);
    }
    console.info(`signed-out nsit repo, ms until exit 3: ${JSON.stringify(timings)}`);
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
 * and keeps the developer's own git configuration out. `autocrlf` is off so file contents are
 * exactly what the test wrote.
 */
function homeWith(identity: boolean): Record<string, string | undefined> {
  const home = tmpDir();
  const user = identity ? "[user]\n\tname = Local Tester\n\temail = tester@example.com\n" : "";
  writeFileSync(join(home, ".gitconfig"), `${user}[core]\n\tautocrlf = false\n`);
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
      // Until `nsit push` exists the commits stay local.
      pushed: false,
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
    expect(readFileSync(join(cwd, "taken", ".git", "config"), "utf8")).not.toContain("origin");
  });

  it("signed out it is exit 3 at once and creates no directory", async () => {
    const cwd = tmpDir();
    const result = await nsit(["init", "nobody-home", "--host", ins.base], { cwd, env: homeWith(false), stdin: "open", timeoutMs: 5_000 });
    expect(result.code, result.stderr).toBe(3);
    expect(result.stderr).toBe(`nsit: not signed in to ${hostKey}; run nsit auth login\n`);
    expect(existsSync(join(cwd, "nobody-home"))).toBe(false);
  });
});
