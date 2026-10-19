import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Deps } from "../deps.js";
import { randomToken } from "../auth/tokens.js";
import { unreadCount } from "../services/notifications.js";
import { getSession } from "../services/users.js";
import type { Env } from "./env.js";

export const SESSION_COOKIE = "gfk_session";
export const CSRF_COOKIE = "gfk_csrf";

export function cookieOptions(deps: Deps) {
  return { httpOnly: true, sameSite: "Lax" as const, path: "/", secure: deps.config.baseUrl.startsWith("https:") };
}

/** Loads the signed-in user, and gives anonymous visitors a double-submit CSRF cookie. */
export function loadSession(deps: Deps): MiddlewareHandler<Env> {
  return async (c, next) => {
    const sid = getCookie(c, SESSION_COOKIE);
    const s = sid ? getSession(deps.db, sid) : null;
    c.set("user", s?.user ?? null);
    c.set("session", s?.session ?? null);
    c.set("unread", s?.user ? unreadCount(deps.db, s.user.id) : 0);
    let csrf = s?.session.csrf ?? getCookie(c, CSRF_COOKIE);
    if (!csrf) {
      csrf = randomToken(24);
      setCookie(c, CSRF_COOKIE, csrf, cookieOptions(deps));
    }
    c.set("csrf", csrf);
    await next();
  };
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Rejects state-changing requests that do not echo the CSRF token. The JSON API
 * under /api/ is exempt: it authenticates with bearer tokens, never cookies, so
 * a forged cross-site request carries no credentials.
 */
/** File and release-asset uploads stream the body, so nothing may read it before the route does. */
export function streamsItsBody(path: string, method: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  return /\/upload\/|\/releases\/[^/]+\/assets$/.test(path);
}

export function csrfGuard(onFail: (c: Context<Env>) => Response | Promise<Response>): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (c.req.path.startsWith("/api/")) return next();
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      if (streamsItsBody(c.req.path, c.req.method)) {
        const token = c.req.header("x-csrf-token") ?? new URL(c.req.url).searchParams.get("_csrf") ?? "";
        if (!token || !sameToken(token, c.get("csrf"))) return onFail(c);
        return next();
      }
      let token = c.req.header("x-csrf-token");
      const type = c.req.header("content-type") ?? "";
      if (!token && (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data"))) {
        // Same options as form() so Hono's cached parse keeps repeated fields.
        const body = await c.req.parseBody({ all: true });
        const v = Array.isArray(body._csrf) ? body._csrf[0] : body._csrf;
        if (typeof v === "string") token = v;
      }
      if (!token || !sameToken(token, c.get("csrf"))) return onFail(c);
    }
    await next();
  };
}

/**
 * A local path to return to after signing in; anything else falls back to "/".
 * Browsers strip tabs/newlines and treat "\" as "/", so any control character,
 * space or backslash is rejected rather than risk "//host".
 */
export function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || /[\x00-\x20\\]/.test(next)) return "/";
  return next;
}

export function loginRedirect(c: Context<Env>): Response {
  const url = new URL(c.req.url);
  return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
}

/** Reads urlencoded or multipart form fields as strings (repeated fields become arrays). */
export async function form(c: Context<Env>): Promise<Record<string, string | string[]>> {
  const body = await c.req.parseBody({ all: true });
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(body)) {
    if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
    else if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function field(f: Record<string, string | string[]>, name: string): string {
  const v = f[name];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export function fields(f: Record<string, string | string[]>, name: string): string[] {
  const v = f[name];
  return Array.isArray(v) ? v : v === undefined ? [] : [v];
}
