import { resolve } from "node:path";

export type Config = {
  dataDir: string;
  port: number;
  /** Interface to listen on; undefined means all interfaces. */
  host: string | undefined;
  baseUrl: string;
  allowUserInvites: boolean;
  /** Proxy addresses whose X-Forwarded-For header is believed. Empty trusts none. */
  trustedProxies: string[];
  /** GitHub "owner/repo" whose Releases host the nsit binaries that /download and the install scripts point at. */
  releaseRepo: string;
  /**
   * How long a client may take to send one whole request, in ms. A git push of up to 2 GB goes through here, so
   * this is long, but it is a bound and never 0: a client that trickles a body must not hold a connection for ever.
   */
  requestTimeoutMs: number;
  /** How long a client may take to send the request line and headers, in ms. At most `requestTimeoutMs`. */
  headersTimeoutMs: number;
  /**
   * When git stops reading a push before the client has finished sending it, the rest is read and dropped so that
   * the client can receive git's answer. That drain gives up (the connection is closed) after this many bytes...
   */
  gitDrainMaxBytes: number;
  /** ...or after this many ms with no data from the client. */
  gitDrainIdleMs: number;
  /** Tests may deliver webhooks to loopback. Production stays closed. */
  webhookAllowLoopback: boolean;
};

const DEFAULT_RELEASE_REPO = "a2thalex/insitio";
// The value is written into generated shell scripts, so only plain owner/repo names are accepted.
const RELEASE_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** 2 hours: at about 2 Mbit/s a 2 GB push takes roughly 8,000 s. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_HEADERS_TIMEOUT_MS = 60_000;
export const DEFAULT_GIT_DRAIN_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_GIT_DRAIN_IDLE_MS = 60_000;

/** The longest a timer can be (setTimeout turns anything larger into 1 ms). */
const MAX_MS = 2 ** 31 - 1;

const LOOPBACK = ["127.0.0.1", "::1"];

function parseTrustProxy(v: string | undefined): string[] {
  if (!v || v === "0" || v === "false") return [];
  if (v === "1" || v === "true" || v === "loopback") return LOOPBACK;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseReleaseRepo(v: string | undefined): string {
  const repo = v?.trim();
  if (!repo) return DEFAULT_RELEASE_REPO;
  if (!RELEASE_REPO_RE.test(repo)) throw new Error(`NSIT_RELEASE_REPO must look like "owner/repo", got "${repo}"`);
  return repo;
}

/** A positive whole number from the environment; unset or blank means `fallback`. 0, negatives, fractions and text are refused. */
function parsePositiveInt(name: string, v: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const text = v?.trim();
  if (!text) return fallback;
  const n = Number(text);
  if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(n) || n < 1 || n > max) {
    throw new Error(`${name} must be a whole number from 1 to ${max}, got "${text}"`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  const trustedProxies = parseTrustProxy(env.TRUST_PROXY);
  const requestTimeoutMs = parsePositiveInt("REQUEST_TIMEOUT_MS", env.REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, MAX_MS);
  const headersTimeoutMs = parsePositiveInt("HEADERS_TIMEOUT_MS", env.HEADERS_TIMEOUT_MS, DEFAULT_HEADERS_TIMEOUT_MS, MAX_MS);
  if (headersTimeoutMs > requestTimeoutMs) {
    throw new Error(`HEADERS_TIMEOUT_MS (${headersTimeoutMs}) must not be more than REQUEST_TIMEOUT_MS (${requestTimeoutMs})`);
  }
  return {
    dataDir: resolve(env.DATA_DIR ?? "data"),
    port,
    // Behind a proxy, listen only on loopback so the proxy is the only way in.
    host: env.HOST || (trustedProxies.length ? "127.0.0.1" : undefined),
    baseUrl: (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    allowUserInvites: env.ALLOW_USER_INVITES === "1",
    trustedProxies,
    releaseRepo: parseReleaseRepo(env.NSIT_RELEASE_REPO),
    requestTimeoutMs,
    headersTimeoutMs,
    gitDrainMaxBytes: parsePositiveInt("GIT_DRAIN_MAX_BYTES", env.GIT_DRAIN_MAX_BYTES, DEFAULT_GIT_DRAIN_MAX_BYTES),
    gitDrainIdleMs: parsePositiveInt("GIT_DRAIN_IDLE_MS", env.GIT_DRAIN_IDLE_MS, DEFAULT_GIT_DRAIN_IDLE_MS, MAX_MS),
    webhookAllowLoopback: env.WEBHOOK_ALLOW_LOOPBACK === "1",
  };
}
