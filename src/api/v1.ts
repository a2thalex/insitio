import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { requestAddress } from "../clientAddress.js";
import { now } from "../db/db.js";
import type { Deps } from "../deps.js";
import { createRateLimiter } from "../rateLimit.js";
import { pollDevice, startDevice } from "../services/devices.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../services/errors.js";
import { accessLevel } from "../services/permissions.js";
import { createRepo, getRepo, listAllVisible, listReposForOwner, validateRepoName, type RepoRow } from "../services/repos.js";
import { deleteAccessToken, getUserByName, userForBearerToken, type User } from "../services/users.js";

// The API is mounted ahead of the web app's middleware, so it applies its own body cap.
const MAX_BODY_BYTES = 1024 * 1024;

type ApiEnv = {
  Variables: {
    /** The owner of the bearer token on this request. */
    apiUser: User;
    apiTokenId: number;
  };
};

export type RepoJson = {
  owner: string;
  name: string;
  full_name: string;
  description: string;
  private: boolean;
  default_branch: string;
  clone_url: string;
  html_url: string;
  created_at: string;
};

/** Every API failure has this shape: {"error": {"code", "message"}}. */
export function apiError(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

function repoJson(deps: Deps, r: RepoRow): RepoJson {
  const html = `${deps.config.baseUrl}/${r.owner}/${r.name}`;
  return {
    owner: r.owner,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    description: r.description,
    private: r.isPrivate,
    default_branch: r.defaultBranch,
    clone_url: `${html}.git`,
    html_url: html,
    created_at: new Date(r.createdAt * 1000).toISOString(),
  };
}

/** The JSON object in the request body, or null when the body is not one. */
async function jsonObject(c: Context): Promise<Record<string, unknown> | null> {
  const body: unknown = await c.req.json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

const BEARER = /^Bearer\s+(\S+)$/i;

/** Requires `Authorization: Bearer <personal access token>`; cookies are never consulted. */
function requireUser(deps: Deps): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const token = BEARER.exec(c.req.header("authorization") ?? "")?.[1];
    const found = token ? userForBearerToken(deps.db, token) : null;
    if (!found) {
      c.header("www-authenticate", "Bearer");
      return apiError(c, 401, "unauthorized", "A valid access token is required (Authorization: Bearer <token>).");
    }
    c.set("apiUser", found.user);
    c.set("apiTokenId", found.tokenId);
    await next();
  };
}

export function apiV1(deps: Deps): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const auth = requireUser(deps);

  app.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => apiError(c, 413, "too_large", "The request body is too large.") }));

  app.onError((err, c) => {
    if (err instanceof ValidationError) return apiError(c, 422, "invalid", err.message);
    if (err instanceof NotFoundError) return apiError(c, 404, "not_found", err.message || "Not found");
    if (err instanceof ForbiddenError) return apiError(c, 403, "forbidden", err.message || "You don't have permission to do that.");
    console.error(err);
    return apiError(c, 500, "internal", "Something went wrong on our end.");
  });

  app.get("/user", auth, (c) => {
    const u = c.get("apiUser");
    return c.json({ login: u.username, name: u.displayName, email: u.email, is_admin: u.isAdmin });
  });

  app.get("/repos", auth, (c) => {
    const viewer = c.get("apiUser");
    const ownerName = c.req.query("owner");
    if (!ownerName) return c.json(listAllVisible(deps.db, viewer).map((r) => repoJson(deps, r)));
    const owner = getUserByName(deps.db, ownerName);
    if (!owner) return apiError(c, 404, "not_found", `User ${ownerName} not found`);
    return c.json(listReposForOwner(deps.db, owner.id, viewer).map((r) => repoJson(deps, r)));
  });

  app.post("/repos", auth, async (c) => {
    const user = c.get("apiUser");
    const body = await jsonObject(c);
    if (!body) return apiError(c, 400, "bad_request", "The request body must be a JSON object.");
    const { name, description = "", private: isPrivate = true } = body;
    if (typeof name !== "string") throw new ValidationError("name is required and must be a string");
    if (typeof description !== "string") throw new ValidationError("description must be a string");
    if (typeof isPrivate !== "boolean") throw new ValidationError("private must be true or false");

    const valid = validateRepoName(name);
    if (getRepo(deps.db, user.username, valid)) {
      return apiError(c, 422, "name_taken", `Repository ${user.username}/${valid} already exists`);
    }
    const repo = await createRepo(deps, user, { name: valid, description, isPrivate, initReadme: false });
    return c.json(repoJson(deps, repo), 201);
  });

  app.get("/repos/:owner/:name", auth, (c) => {
    const repo = getRepo(deps.db, c.req.param("owner"), c.req.param("name"));
    // Hidden repos look exactly like missing ones, as in the web UI.
    if (!repo || accessLevel(deps.db, c.get("apiUser"), repo) === "none") {
      return apiError(c, 404, "not_found", "Repository not found");
    }
    return c.json(repoJson(deps, repo));
  });

  // Device authorization (`nsit auth login`). These two are called before the CLI has a
  // token, so they are not behind `auth`; the code endpoint is rate limited instead.
  const codeLimiter = createRateLimiter(10, 60_000);

  app.post("/device/code", async (c) => {
    const address = requestAddress(c, deps.config.trustedProxies);
    const wait = codeLimiter.retryAfter(address);
    if (wait > 0) {
      c.header("retry-after", String(wait));
      return apiError(c, 429, "rate_limited", "Too many sign-in requests. Try again in a minute.");
    }
    codeLimiter.record(address);

    const body = await jsonObject(c);
    if (!body) return apiError(c, 400, "bad_request", "The request body must be a JSON object.");
    if (typeof body.client_name !== "string") throw new ValidationError("client_name is required and must be a string");

    const d = startDevice(deps.db, body.client_name);
    c.header("cache-control", "no-store");
    return c.json({
      device_code: d.deviceCode,
      user_code: d.userCode,
      verification_uri: `${deps.config.baseUrl}/login/device`,
      expires_in: d.expiresIn,
      interval: d.interval,
    });
  });

  app.post("/device/token", async (c) => {
    const body = await jsonObject(c);
    if (!body) return apiError(c, 400, "bad_request", "The request body must be a JSON object.");
    if (typeof body.device_code !== "string" || !body.device_code) {
      throw new ValidationError("device_code is required and must be a string");
    }

    const r = pollDevice(deps.db, body.device_code, now());
    c.header("cache-control", "no-store");
    switch (r.status) {
      case "approved":
        return c.json({ access_token: r.token, token_type: "bearer", login: r.login });
      case "pending":
        return apiError(c, 400, "authorization_pending", "The user has not approved this sign-in yet.");
      case "slow_down":
        return apiError(c, 400, "slow_down", "You are polling too fast. Wait at least the interval between requests.");
      case "denied":
        return apiError(c, 400, "access_denied", "The user denied this sign-in.");
      case "expired":
        return apiError(c, 400, "expired_token", "This sign-in code has expired. Start again.");
    }
  });

  // Logout: revokes the token that made this request, and nothing else.
  app.delete("/user/tokens/current", auth, (c) => {
    deleteAccessToken(deps.db, c.get("apiUser").id, c.get("apiTokenId"));
    return c.body(null, 204);
  });

  app.all("*", (c) => apiError(c, 404, "not_found", "No such endpoint"));

  return app;
}
