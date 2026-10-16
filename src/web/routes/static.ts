import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import type { Env } from "../env.js";
import { identicon } from "../format.js";

const require = createRequire(import.meta.url);
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "../../../public");

function load(path: string) {
  return readFileSync(path);
}

/** Static assets are read once at startup and served with long-lived caching headers. */
export function staticRoutes(app: Hono<Env>) {
  const assets: Record<string, { body: Buffer; type: string }> = {
    "primer.css": { body: load(require.resolve("@primer/css/dist/primer.css")), type: "text/css; charset=utf-8" },
    "app.css": { body: load(join(PUBLIC, "app.css")), type: "text/css; charset=utf-8" },
    "app.js": { body: load(join(PUBLIC, "app.js")), type: "text/javascript; charset=utf-8" },
    "favicon.svg": { body: load(join(PUBLIC, "favicon.svg")), type: "image/svg+xml" },
  };
  app.get("/static/avatars/:name", (c) => {
    const name = c.req.param("name").replace(/\.svg$/, "");
    return c.body(identicon(name), 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" });
  });
  app.get("/static/:file", (c) => {
    const a = assets[c.req.param("file")];
    if (!a) return c.notFound();
    return c.body(new Uint8Array(a.body), 200, { "content-type": a.type, "cache-control": "public, max-age=3600" });
  });
  app.get("/favicon.ico", (c) => c.redirect("/static/favicon.svg"));
}
