import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamsItsBody } from "./web/middleware.js";
import { apiV1 } from "./api/v1.js";
import type { Deps } from "./deps.js";
import { ForbiddenError, NotFoundError, ValidationError } from "./services/errors.js";
import type { Env } from "./web/env.js";
import { csrfGuard, loadSession } from "./web/middleware.js";
import { notFound, renderError } from "./web/render.js";
import { staticRoutes } from "./web/routes/static.js";
import { authRoutes } from "./web/routes/auth.js";
import { settingsRoutes } from "./web/routes/settings.js";
import { adminRoutes } from "./web/routes/admin.js";
import { homeRoutes } from "./web/routes/home.js";
import { newRepoRoutes } from "./web/routes/newRepo.js";
import { orgRoutes } from "./web/routes/orgs.js";
import { codeRoutes } from "./web/routes/code.js";
import { editRoutes } from "./web/routes/edit.js";
import { blameRoutes } from "./web/routes/blame.js";
import { refRoutes } from "./web/routes/refs.js";
import { archiveRoutes } from "./web/routes/archive.js";
import { releaseRoutes } from "./web/routes/releases.js";
import { socialRoutes } from "./web/routes/social.js";
import { issueBoardRoutes } from "./web/routes/issueBoard.js";
import { issueRoutes } from "./web/routes/issues.js";
import { pullBoardRoutes } from "./web/routes/pullBoard.js";
import { pullRoutes } from "./web/routes/pulls.js";
import { platformRoutes } from "./web/routes/platform.js";
import { repoSettingsRoutes } from "./web/routes/repoSettings.js";
import { userRoutes } from "./web/routes/users.js";
import { deviceRoutes } from "./web/routes/device.js";
import { downloadRoutes } from "./web/routes/downloads.js";

const MAX_FORM_BYTES = 2 * 1024 * 1024;

/**
 * Builds the web app. Fixed top-level paths are registered before the
 * /:owner/... routes so a username can never shadow them.
 */
export function buildApp(deps: Deps): Hono<Env> {
  const app = new Hono<Env>();
  staticRoutes(app);
  // The JSON API authenticates with bearer tokens and has its own middleware, so it
  // sits ahead of the cookie session, CSRF guard and HTML error pages below.
  app.route("/api/v1", apiV1(deps));
  // Forms are small; cap bodies before anything parses them. Git pushes bypass Hono entirely.
  app.use("*", async (c, next) => {
    if (streamsItsBody(c.req.path, c.req.method)) return next();
    return bodyLimit({ maxSize: MAX_FORM_BYTES, onError: (ctx) => renderError(ctx, 413, "That request was too large.") })(c, next);
  });
  app.use("*", loadSession(deps));
  app.use("*", csrfGuard((c) => renderError(c, 403, "Your form expired or was sent from another site. Reload the page and try again.")));
  app.use("*", async (c, next) => {
    await next();
    c.header("x-frame-options", "DENY");
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "same-origin");
  });

  authRoutes(deps, app);
  // /login/device is two segments deep, so it must come before the /:owner/:repo routes below.
  deviceRoutes(deps, app);
  settingsRoutes(deps, app);
  adminRoutes(deps, app);
  homeRoutes(deps, app);
  // /download, /install.ps1 and /install.sh are single-segment paths like /:owner, so they come before userRoutes.
  downloadRoutes(deps, app);
  newRepoRoutes(deps, app);
  orgRoutes(deps, app);
  codeRoutes(deps, app);
  editRoutes(deps, app);
  blameRoutes(deps, app);
  refRoutes(deps, app);
  archiveRoutes(deps, app);
  releaseRoutes(deps, app);
  socialRoutes(deps, app);
  issueBoardRoutes(deps, app);
  issueRoutes(deps, app);
  pullBoardRoutes(deps, app);
  pullRoutes(deps, app);
  platformRoutes(deps, app);
  repoSettingsRoutes(deps, app);
  userRoutes(deps, app);

  app.notFound((c) => notFound(c));
  app.onError((err, c) => {
    if (err instanceof ValidationError) return renderError(c, 400, err.message);
    if (err instanceof NotFoundError) return notFound(c);
    if (err instanceof ForbiddenError) return renderError(c, 403, err.message || "You don't have permission to do that.");
    console.error(err);
    return renderError(c, 500, "Something went wrong on our end.");
  });
  return app;
}
