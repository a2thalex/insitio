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
};

const LOOPBACK = ["127.0.0.1", "::1"];

function parseTrustProxy(v: string | undefined): string[] {
  if (!v || v === "0" || v === "false") return [];
  if (v === "1" || v === "true" || v === "loopback") return LOOPBACK;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  const trustedProxies = parseTrustProxy(env.TRUST_PROXY);
  return {
    dataDir: resolve(env.DATA_DIR ?? "data"),
    port,
    // Behind a proxy, listen only on loopback so the proxy is the only way in.
    host: env.HOST || (trustedProxies.length ? "127.0.0.1" : undefined),
    baseUrl: (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    allowUserInvites: env.ALLOW_USER_INVITES === "1",
    trustedProxies,
  };
}
