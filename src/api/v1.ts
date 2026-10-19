import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { addressBucket, requestAddress } from "../clientAddress.js";
import { now } from "../db/db.js";
import type { Deps } from "../deps.js";
import { createRateLimiter } from "../rateLimit.js";
import { DeviceCapacityError, pollDevice, startDevice } from "../services/devices.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../services/errors.js";
import { accessLevel, can, type Access } from "../services/permissions.js";
import { createRepo, getRepo, listAllVisible, listReposForOwner, validateRepoName, type RepoRow } from "../services/repos.js";
import {
  attachAsset,
  createRelease,
  getReleaseById,
  latestRelease,
  listAssets,
  listReleases,
  partialAssetPath,
  releaseDir,
  RELEASE_ASSET_MAX_BYTES,
  type Release,
} from "../services/releases.js";
import { saveRawBody } from "../web/multipart.js";
import { mkdir } from "node:fs/promises";
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

  app.use("*", async (c, next) => {
    if (c.req.method === "POST" && /\/releases\/\d+\/assets$/.test(c.req.path)) return next();
    return bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (ctx) => apiError(ctx, 413, "too_large", "The request body is too large.") })(c, next);
  });

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
    // The request rate is counted per IPv4 address or IPv6 /64, so rotating the low bits of an address
    // buys nothing. The sign-ins one source may have waiting at once are counted per IPv4 address or
    // IPv6 /48 (startDevice), so spreading over the /64s of a site buys nothing either.
    const bucket = addressBucket(address);
    const pendingBucket = addressBucket(address, 48);
    const wait = codeLimiter.retryAfter(bucket);
    if (wait > 0) {
      c.header("retry-after", String(wait));
      return apiError(c, 429, "rate_limited", "Too many sign-in requests. Try again in a minute.");
    }
    codeLimiter.record(bucket);

    const body = await jsonObject(c);
    if (!body) return apiError(c, 400, "bad_request", "The request body must be a JSON object.");
    if (typeof body.client_name !== "string") throw new ValidationError("client_name is required and must be a string");

    let d;
    try {
      d = startDevice(deps.db, body.client_name, now(), pendingBucket);
    } catch (err) {
      // Only so many sign-ins may wait for approval at once from one source, and, however many sources ask, in all.
      if (!(err instanceof DeviceCapacityError)) throw err;
      c.header("retry-after", String(err.retryAfter));
      return apiError(
        c,
        429,
        "rate_limited",
        err.scope === "bucket"
          ? "Too many sign-ins from your network are waiting for approval. Finish one of them, or try again in a few minutes."
          : "Too many sign-ins are waiting for approval. Try again in a few minutes.",
      );
    }
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

  function repoFor(c: Context<ApiEnv>, need: Access): RepoRow | Response {
    const repo = getRepo(deps.db, c.req.param("owner") ?? "", c.req.param("name") ?? "");
    const level = repo ? accessLevel(deps.db, c.get("apiUser"), repo) : "none";
    if (!repo || level === "none") return apiError(c, 404, "not_found", "Repository not found");
    if (!can(level, need)) return apiError(c, 403, "forbidden", "You don't have permission to do that.");
    return repo;
  }

  function releaseJson(repo: RepoRow, release: Release) {
    const assets = listAssets(deps.db, release.id).map((asset) => ({
      id: asset.id,
      name: asset.name,
      size: asset.size,
      download_count: asset.downloadCount,
      content_type: asset.contentType,
      browser_download_url: `${deps.config.baseUrl}/${repo.owner}/${repo.name}/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(asset.name)}`,
    }));
    return {
      id: release.id,
      tag_name: release.tag,
      name: release.title,
      body: release.body,
      draft: release.draft,
      prerelease: release.prerelease,
      make_latest: release.makeLatest,
      html_url: `${deps.config.baseUrl}/${repo.owner}/${repo.name}/releases/tag/${encodeURIComponent(release.tag)}`,
      published_at: release.publishedAt ? new Date(release.publishedAt * 1000).toISOString() : null,
      assets,
    };
  }

  app.get("/repos/:owner/:name/releases", auth, (c) => {
    const repo = repoFor(c, "read");
    if (repo instanceof Response) return repo;
    const level = accessLevel(deps.db, c.get("apiUser"), repo);
    const list = listReleases(deps.db, repo.id, { includeDrafts: can(level, "write"), page: 1 });
    return c.json(list.items.map((release) => releaseJson(repo, release)));
  });

  app.get("/repos/:owner/:name/releases/latest", auth, (c) => {
    const repo = repoFor(c, "read");
    if (repo instanceof Response) return repo;
    const release = latestRelease(deps.db, repo.id);
    if (!release) return apiError(c, 404, "not_found", "No latest release");
    return c.json(releaseJson(repo, release));
  });

  app.post("/repos/:owner/:name/releases", auth, async (c) => {
    const repo = repoFor(c, "write");
    if (repo instanceof Response) return repo;
    const body = await jsonObject(c);
    if (!body) return apiError(c, 400, "bad_request", "The request body must be a JSON object.");
    const tag = body.tag_name;
    if (typeof tag !== "string") throw new ValidationError("tag_name is required and must be a string");
    const release = await createRelease(deps, repo, c.get("apiUser"), {
      tag,
      target: typeof body.target_commitish === "string" ? body.target_commitish : repo.defaultBranch,
      title: typeof body.name === "string" && body.name ? body.name : tag,
      body: typeof body.body === "string" ? body.body : "",
      draft: body.draft === true,
      prerelease: body.prerelease === true,
      setLatest: body.make_latest !== false && body.make_latest !== "false",
    });
    return c.json(releaseJson(repo, release), 201);
  });

  app.post("/repos/:owner/:name/releases/:id/assets", auth, async (c) => {
    const repo = repoFor(c, "write");
    if (repo instanceof Response) return repo;
    const release = getReleaseById(deps.db, Number(c.req.param("id")));
    if (!release || release.repoId !== repo.id) return apiError(c, 404, "not_found", "Release not found");
    const name = c.req.query("name") ?? "";
    await mkdir(releaseDir(deps.config.dataDir, repo.id, release.id), { recursive: true });
    const temp = partialAssetPath(deps.config.dataDir, repo.id, release.id);
    const size = await saveRawBody(c.req.raw.body, temp, RELEASE_ASSET_MAX_BYTES);
    const type = c.req.header("content-type") ?? "application/octet-stream";
    const asset = await attachAsset(deps, repo, release, temp, name, size, type.split(";")[0].trim() || "application/octet-stream");
    return c.json(
      {
        id: asset.id,
        name: asset.name,
        size: asset.size,
        download_count: asset.downloadCount,
        browser_download_url: `${deps.config.baseUrl}/${repo.owner}/${repo.name}/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(asset.name)}`,
      },
      201,
    );
  });

  // Logout: revokes the token that made this request, and nothing else.
  app.delete("/user/tokens/current", auth, (c) => {
    deleteAccessToken(deps.db, c.get("apiUser").id, c.get("apiTokenId"));
    return c.body(null, 204);
  });

  app.all("*", (c) => apiError(c, 404, "not_found", "No such endpoint"));

  return app;
}
