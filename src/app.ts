import { Hono } from "hono";
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

/**
 * Builds the web app. Fixed top-level paths are registered before the
 * /:owner/... routes so a username can never shadow them.
 */
export function buildApp(deps: Deps): Hono<Env> {
  const app = new Hono<Env>();
  staticRoutes(app);
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
