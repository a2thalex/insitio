import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "../../public");

export type Asset = { body: Buffer; type: string; version: string };

function asset(path: string, type: string): Asset {
  const body = readFileSync(path);
  return { body, type, version: createHash("sha256").update(body).digest("hex").slice(0, 10) };
}

/** Static assets, read once at startup. URLs carry a content hash so caches never serve stale files. */
export const ASSETS: Record<string, Asset> = {
  "primer.css": asset(require.resolve("@primer/css/dist/primer.css"), "text/css; charset=utf-8"),
  "app.css": asset(join(PUBLIC, "app.css"), "text/css; charset=utf-8"),
  "app.js": asset(join(PUBLIC, "app.js"), "text/javascript; charset=utf-8"),
  "favicon.svg": asset(join(PUBLIC, "favicon.svg"), "image/svg+xml"),
};

export function assetUrl(name: keyof typeof ASSETS & string): string {
  return `/static/${name}?v=${ASSETS[name].version}`;
}
