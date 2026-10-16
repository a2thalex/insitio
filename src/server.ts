import { createServer, type Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type { Deps } from "./deps.js";
import { buildApp } from "./app.js";
import { handleGitHttp, matchGitRoute } from "./githttp/handler.js";

/** One HTTP server: git smart-HTTP URLs go to the git bridge, everything else to the web app. */
export function createGitFkdServer(deps: Deps): Server {
  const web = getRequestListener(buildApp(deps).fetch);
  return createServer((req, res) => {
    try {
      const route = matchGitRoute(req.url ?? "/");
      if (route) handleGitHttp(req, res, deps, route);
      else web(req, res);
    } catch (err) {
      // A bad request must never take the process down.
      console.error("Request failed", err);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Internal server error\n");
    }
  });
}
