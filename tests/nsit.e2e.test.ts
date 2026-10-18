import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decideDevice, findPendingByUserCode } from "../src/services/devices.js";
import { createAccessToken, createUser, listAccessTokens, type User } from "../src/services/users.js";
import { nsitBin, runNsit, startInsitio, startNsit, tmpDir, type Insitio, type NsitOptions, type NsitResult } from "./helpers.js";

// These tests run the real `nsit` binary against a real Insitio server in this process. Every
// run gets its own config directory, no OS credential store (NSIT_NO_KEYCHAIN=1) and none of
// the developer's NSIT_* variables, so nothing here touches their keychain or config.

// The first build compiles the vendored libgit2 and can take many minutes.
const BUILD_TIMEOUT = 15 * 60_000;
// The device flow waits one poll interval (5 s) before the first poll.
const DEVICE_TIMEOUT = 60_000;
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
    expect(result.stdout).toBe('"ada"\n');
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
      const proc = await startNsit(auth("login"), { configDir, stdin: "open" });
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
      const proc = await startNsit(auth("login"), { configDir });
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
