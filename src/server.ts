import { createServer, type Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type { Deps } from "./deps.js";
import { buildApp } from "./app.js";
import { handleGitHttp, matchGitRoute } from "./githttp/handler.js";

/**
 * One HTTP server: git smart-HTTP URLs go to the git bridge, everything else to the web app.
 *
 * The two timeouts are set on purpose. Node's own default for `requestTimeout` is 5 minutes, and it counts
 * the whole request, so a push that takes longer to upload (2 GB over a slow line) would be answered
 * "408 Request Timeout" half way through. They come from the config (`REQUEST_TIMEOUT_MS`, 2 hours by
 * default, and `HEADERS_TIMEOUT_MS`, 1 minute), and neither is ever 0, which in Node means "no limit".
 */
export function createInsitioServer(deps: Deps): Server {
  const web = getRequestListener(buildApp(deps).fetch);
  const { requestTimeoutMs, headersTimeoutMs } = deps.config;
  return createServer({ requestTimeout: requestTimeoutMs, headersTimeout: headersTimeoutMs }, (req, res) => {
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
