import { resolve } from "node:path";

export type Config = {
  dataDir: string;
  port: number;
  baseUrl: string;
  allowUserInvites: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  return {
    dataDir: resolve(env.DATA_DIR ?? "data"),
    port,
    baseUrl: (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    allowUserInvites: env.ALLOW_USER_INVITES === "1",
  };
}
