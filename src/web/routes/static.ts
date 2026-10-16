import type { Hono } from "hono";
import type { Env } from "../env.js";
import { ASSETS } from "../assets.js";
import { identicon } from "../format.js";

export function staticRoutes(app: Hono<Env>) {
  app.get("/static/avatars/:name", (c) => {
    const name = c.req.param("name").replace(/\.svg$/, "");
    return c.body(identicon(name), 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" });
  });
  app.get("/static/:file", (c) => {
    const a = ASSETS[c.req.param("file")];
    if (!a) return c.notFound();
    // Versioned URLs are immutable; unversioned ones must revalidate.
    const cache = c.req.query("v") === a.version ? "public, max-age=31536000, immutable" : "no-cache";
    return c.body(new Uint8Array(a.body), 200, { "content-type": a.type, "cache-control": cache, etag: `"${a.version}"` });
  });
  app.get("/favicon.ico", (c) => c.redirect("/static/favicon.svg"));
}
