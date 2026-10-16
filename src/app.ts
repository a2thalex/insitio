import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
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
import { codeRoutes } from "./web/routes/code.js";
import { issueRoutes } from "./web/routes/issues.js";
import { pullRoutes } from "./web/routes/pulls.js";
import { repoSettingsRoutes } from "./web/routes/repoSettings.js";
import { userRoutes } from "./web/routes/users.js";

const MAX_FORM_BYTES = 2 * 1024 * 1024;

/**
 * Builds the web app. Fixed top-level paths are registered before the
 * /:owner/... routes so a username can never shadow them.
 */
export function buildApp(deps: Deps): Hono<Env> {
  const app = new Hono<Env>();
  staticRoutes(app);
  // Forms are small; cap bodies before anything parses them. Git pushes bypass Hono entirely.
  app.use("*", bodyLimit({ maxSize: MAX_FORM_BYTES, onError: (c) => renderError(c, 413, "That request was too large.") }));
  app.use("*", loadSession(deps));
  app.use("*", csrfGuard((c) => renderError(c, 403, "Your form expired or was sent from another site. Reload the page and try again.")));
  app.use("*", async (c, next) => {
    await next();
    c.header("x-frame-options", "DENY");
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "same-origin");
  });

  authRoutes(deps, app);
  settingsRoutes(deps, app);
  adminRoutes(deps, app);
  homeRoutes(deps, app);
  newRepoRoutes(deps, app);
  codeRoutes(deps, app);
  issueRoutes(deps, app);
  pullRoutes(deps, app);
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
