import { createServer, type Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type { Deps } from "./deps.js";
import { buildApp } from "./app.js";

/** One HTTP server: git smart-HTTP URLs go to the git bridge, everything else to the web app. */
export function createGitFkdServer(deps: Deps): Server {
  const web = getRequestListener(buildApp(deps).fetch);
  return createServer((req, res) => {
    web(req, res);
  });
}
