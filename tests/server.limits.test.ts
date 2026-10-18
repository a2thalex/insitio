import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_GIT_DRAIN_IDLE_MS,
  DEFAULT_GIT_DRAIN_MAX_BYTES,
  DEFAULT_HEADERS_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  loadConfig,
  type Config,
} from "../src/config.js";
import { createInsitioServer } from "../src/server.js";
import { createRepo } from "../src/services/repos.js";
import { createAccessToken, createUser } from "../src/services/users.js";
import { testDeps } from "./helpers.js";

// The limits a large git push depends on: how long the server waits for a request, and how much
// of a request it reads and drops after git has stopped reading it.

describe("request timeouts", () => {
  it("default to a bounded 2 hours for a whole request and 1 minute for its headers", () => {
    const config = loadConfig({});
    expect(config.requestTimeoutMs).toBe(2 * 60 * 60 * 1000);
    expect(config.headersTimeoutMs).toBe(60_000);
    expect(config.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(config.headersTimeoutMs).toBe(DEFAULT_HEADERS_TIMEOUT_MS);
    // Blank is unset.
    expect(loadConfig({ REQUEST_TIMEOUT_MS: " ", HEADERS_TIMEOUT_MS: "" }).requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it("come from REQUEST_TIMEOUT_MS and HEADERS_TIMEOUT_MS", () => {
    const config = loadConfig({ REQUEST_TIMEOUT_MS: "600000", HEADERS_TIMEOUT_MS: "20000" });
    expect(config).toMatchObject({ requestTimeoutMs: 600_000, headersTimeoutMs: 20_000 });
    // Only one given: the other keeps its default, as long as the pair still makes sense.
    expect(loadConfig({ HEADERS_TIMEOUT_MS: "5000" })).toMatchObject({ requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS, headersTimeoutMs: 5000 });
    expect(loadConfig({ REQUEST_TIMEOUT_MS: "60000" }).headersTimeoutMs).toBe(60_000);
  });

  it("refuse 0 (no limit), negatives, fractions, text, a headers timeout above the request timeout, and values a timer cannot hold", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "1e3", "0x10", "2147483648"]) {
      expect(() => loadConfig({ REQUEST_TIMEOUT_MS: bad }), `REQUEST_TIMEOUT_MS=${bad}`).toThrow(/REQUEST_TIMEOUT_MS must be a whole number/);
      expect(() => loadConfig({ HEADERS_TIMEOUT_MS: bad }), `HEADERS_TIMEOUT_MS=${bad}`).toThrow(/HEADERS_TIMEOUT_MS must be a whole number/);
    }
    expect(() => loadConfig({ REQUEST_TIMEOUT_MS: "30000" })).toThrow(/HEADERS_TIMEOUT_MS \(60000\) must not be more than REQUEST_TIMEOUT_MS \(30000\)/);
    expect(() => loadConfig({ REQUEST_TIMEOUT_MS: "10000", HEADERS_TIMEOUT_MS: "10001" })).toThrow(/must not be more than/);
    // Equal is fine.
    expect(loadConfig({ REQUEST_TIMEOUT_MS: "10000", HEADERS_TIMEOUT_MS: "10000" }).headersTimeoutMs).toBe(10_000);
  });

  it("are the ones the HTTP server is created with (Node's own default for the whole request is 5 minutes)", () => {
    const defaults = createInsitioServer(testDeps());
    expect(defaults.requestTimeout).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(defaults.headersTimeout).toBe(DEFAULT_HEADERS_TIMEOUT_MS);
    expect(defaults.requestTimeout, "not Node's 5 minutes").toBeGreaterThan(300_000);

    const custom = createInsitioServer(testDeps({ requestTimeoutMs: 123_456, headersTimeoutMs: 6_789 }));
    expect(custom.requestTimeout).toBe(123_456);
    expect(custom.headersTimeout).toBe(6_789);

    // What the process would run with when configured through the environment.
    const config = loadConfig({ REQUEST_TIMEOUT_MS: "900000", HEADERS_TIMEOUT_MS: "15000" });
    const fromEnv = createInsitioServer(testDeps({ requestTimeoutMs: config.requestTimeoutMs, headersTimeoutMs: config.headersTimeoutMs }));
    expect([fromEnv.requestTimeout, fromEnv.headersTimeout]).toEqual([900_000, 15_000]);
    // Neither is 0, which in Node means "no limit".
    for (const server of [defaults, custom, fromEnv]) {
      expect(server.requestTimeout).toBeGreaterThan(0);
      expect(server.headersTimeout).toBeGreaterThan(0);
    }
  });
});

describe("the drain limits", () => {
  it("default to 256 MiB and 1 minute, and come from GIT_DRAIN_MAX_BYTES and GIT_DRAIN_IDLE_MS", () => {
    expect(loadConfig({})).toMatchObject({ gitDrainMaxBytes: 256 * 1024 * 1024, gitDrainIdleMs: 60_000 });
    expect(DEFAULT_GIT_DRAIN_MAX_BYTES).toBe(256 * 1024 * 1024);
    expect(DEFAULT_GIT_DRAIN_IDLE_MS).toBe(60_000);
    expect(loadConfig({ GIT_DRAIN_MAX_BYTES: "4096", GIT_DRAIN_IDLE_MS: "250" })).toMatchObject({ gitDrainMaxBytes: 4096, gitDrainIdleMs: 250 });
    for (const bad of ["0", "-5", "2.5", "lots"]) {
      expect(() => loadConfig({ GIT_DRAIN_MAX_BYTES: bad })).toThrow(/GIT_DRAIN_MAX_BYTES must be a whole number/);
      expect(() => loadConfig({ GIT_DRAIN_IDLE_MS: bad })).toThrow(/GIT_DRAIN_IDLE_MS must be a whole number/);
    }
  });
});

// ---- git stops reading a push that the client is still sending ------------------------------------
//
// The body below is not a push: it is not even pkt-lines, so `git receive-pack` stops at its first
// line and exits while the client has megabytes left to send. What the server does with the rest of
// that upload is what is tested, on a real server and a real socket.

type Running = { server: Server; port: number; token: string; sockets: net.Socket[] };
const running: Running[] = [];

afterEach(async () => {
  for (const { server } of running.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

async function startServer(overrides: Partial<Config> = {}): Promise<Running> {
  const deps = testDeps(overrides);
  const ada = createUser(deps.db, { username: "ada", password: "longenough", email: "ada@example.com" });
  const token = createAccessToken(deps.db, ada.id, "limits");
  await createRepo(deps, ada, { name: "drain", description: "", isPrivate: true, initReadme: false });
  const server = createInsitioServer(deps);
  const sockets: net.Socket[] = [];
  server.prependListener("request", (req) => sockets.push(req.socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const started = { server, port: (server.address() as AddressInfo).port, token, sockets };
  running.push(started);
  return started;
}

const MiB = 1024 * 1024;

/**
 * POST `declared` bytes of nonsense to the push endpoint of ada/drain, send `toSend` of them (as fast as
 * the connection takes them) and then stop, keeping the connection open.
 */
function upload(server: Running, declared: number, toSend: number) {
  const socket = net.connect(server.port, "127.0.0.1");
  socket.on("error", () => {}); // the server may reset it: that is one of the outcomes under test
  let reply = "";
  socket.setEncoding("latin1");
  socket.on("data", (text: string) => (reply += text));
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  const auth = Buffer.from(`ada:${server.token}`).toString("base64");
  socket.write(
    `POST /ada/drain.git/git-receive-pack HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nAuthorization: Basic ${auth}\r\n` +
      `Content-Type: application/x-git-receive-pack-request\r\nContent-Length: ${declared}\r\n\r\n`,
  );
  const piece = Buffer.alloc(MiB, 0x7a);
  const sent = (async () => {
    for (let n = 0; n < toSend && !socket.destroyed; n += MiB) {
      if (!socket.write(piece.subarray(0, Math.min(MiB, toSend - n)))) {
        // Wait for room, or for the end of the connection; `closed` is a promise so no listener piles up.
        await Promise.race([new Promise<void>((resolve) => socket.once("drain", resolve)), closed]);
      }
    }
  })();
  return { socket, closed, sent, reply: () => reply };
}

async function until(what: string, condition: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what} after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("a push that git stops reading", () => {
  it("is read to the end and dropped, so that the client gets the answer, when it is within the limits", async () => {
    const server = await startServer();
    const total = 24 * MiB;
    const up = upload(server, total, total);
    await up.sent;
    await until("the answer", () => /^HTTP\/1\.1 \d{3} /.test(up.reply()));
    // An answer, not a reset; and all of the upload was read by the server on the way.
    expect(up.reply()).toMatch(/^HTTP\/1\.1 200 /);
    await until("the whole upload to be read", () => server.sockets[0]!.bytesRead >= total);
    expect(server.sockets[0]!.destroyed).toBe(false);
    up.socket.destroy();
    await up.closed;
  });

  it("is dropped only up to GIT_DRAIN_MAX_BYTES: past that the connection is closed", async () => {
    const server = await startServer({ gitDrainMaxBytes: 4096 });
    const total = 64 * MiB;
    const up = upload(server, total, total);
    await until("the server to close the connection", () => server.sockets[0]?.destroyed === true);
    await up.closed;
    // Far from all of it was read: the server stopped at the cap (plus what was already in flight), and
    // the client could not have put 64 MiB into the operating system's buffers.
    expect(server.sockets[0]!.bytesRead).toBeLessThan(total / 2);
  });

  it("is dropped only while data keeps coming: after GIT_DRAIN_IDLE_MS of silence the connection is closed", async () => {
    const server = await startServer({ gitDrainIdleMs: 300 });
    // 64 MiB promised, 256 KiB sent: git stops reading at once, and then the client goes quiet.
    const up = upload(server, 64 * MiB, 256 * 1024);
    await up.sent;
    const quiet = Date.now();
    await until("the server to close an idle connection", () => server.sockets[0]?.destroyed === true, 5000);
    await up.closed;
    expect(Date.now() - quiet, "not before the idle time").toBeGreaterThanOrEqual(150);
  });
});
