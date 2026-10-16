import type { Context, Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Deps } from "../../deps.js";
import { ValidationError } from "../../services/errors.js";
import { authenticate, createSession, deleteSession, inviteStatus, redeemInvite } from "../../services/users.js";
import type { Env } from "../env.js";
import { SESSION_COOKIE, cookieOptions, field, form, safeNext } from "../middleware.js";
import { render, renderError } from "../render.js";
import { CsrfField, Flash, Octicon } from "../views/layout.js";

// Failed sign-ins per username+address, to slow down password guessing.
const failures = new Map<string, { count: number; until: number }>();
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

function clientAddress(c: Context<Env>): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // in-process requests (tests) have no socket
  }
}

function throttled(key: string): boolean {
  const f = failures.get(key);
  return !!f && f.count >= MAX_FAILURES && f.until > Date.now();
}

function recordFailure(key: string) {
  const f = failures.get(key);
  if (!f || f.until < Date.now()) failures.set(key, { count: 1, until: Date.now() + WINDOW_MS });
  else f.count++;
}

function AuthBox({ title, children }: { title: string; children: any }) {
  return (
    <div class="container-sm px-3 py-6" style="max-width:340px">
      <div class="text-center mb-4">
        <Octicon name="git-merge" size={48} />
        <h1 class="f3 text-normal mt-3">{title}</h1>
      </div>
      {children}
    </div>
  );
}

function LoginPage({ csrf, next, error, username }: { csrf: string; next: string; error?: string; username?: string }) {
  return (
    <AuthBox title="Sign in to GitFkd">
      <Flash error={error} />
      <div class="Box color-bg-subtle p-3">
        <form method="post" action={`/login?next=${encodeURIComponent(next)}`}>
          <CsrfField csrf={csrf} />
          <label for="login_field" class="d-block mb-2">Username</label>
          <input class="form-control input-block mb-3" id="login_field" name="username" autocomplete="username" value={username ?? ""} required autofocus />
          <label for="password" class="d-block mb-2">Password</label>
          <input class="form-control input-block mb-3" id="password" name="password" type="password" autocomplete="current-password" required />
          <button class="btn btn-primary btn-block" type="submit">Sign in</button>
        </form>
      </div>
      <p class="text-center color-fg-muted f6 mt-3 p-3 border rounded-2">
        GitFkd is invite-only. Ask an admin for an invite link.
      </p>
    </AuthBox>
  );
}

function JoinPage({ csrf, token, error, values }: { csrf: string; token: string; error?: string; values?: Record<string, string> }) {
  return (
    <AuthBox title="Create your GitFkd account">
      <Flash error={error} />
      <div class="Box color-bg-subtle p-3">
        <form method="post" action={`/join/${token}`}>
          <CsrfField csrf={csrf} />
          <label for="username" class="d-block mb-2">Username</label>
          <input class="form-control input-block mb-3" id="username" name="username" autocomplete="username" value={values?.username ?? ""} required autofocus />
          <label for="email" class="d-block mb-2">Email <span class="color-fg-muted">(used for commits made in the web UI)</span></label>
          <input class="form-control input-block mb-3" id="email" name="email" type="email" autocomplete="email" value={values?.email ?? ""} />
          <label for="password" class="d-block mb-2">Password</label>
          <input class="form-control input-block mb-1" id="password" name="password" type="password" autocomplete="new-password" required minlength={8} />
          <p class="note mb-3">At least 8 characters.</p>
          <label for="confirm" class="d-block mb-2">Confirm password</label>
          <input class="form-control input-block mb-3" id="confirm" name="confirm" type="password" autocomplete="new-password" required />
          <button class="btn btn-primary btn-block" type="submit">Create account</button>
        </form>
      </div>
    </AuthBox>
  );
}

function startSession(c: Context<Env>, deps: Deps, userId: number) {
  const s = createSession(deps.db, userId);
  setCookie(c, SESSION_COOKIE, s.id, { ...cookieOptions(deps), maxAge: 30 * 86400 });
}

const INVITE_MESSAGES = {
  missing: "This invite link is not valid.",
  used: "This invite link has already been used.",
  expired: "This invite link has expired. Ask for a new one.",
} as const;

export function authRoutes(deps: Deps, app: Hono<Env>) {
  app.get("/login", (c) => {
    if (c.get("user")) return c.redirect(safeNext(c.req.query("next")));
    return render(c, "Sign in", <LoginPage csrf={c.get("csrf")} next={safeNext(c.req.query("next"))} />);
  });

  app.post("/login", async (c) => {
    const f = await form(c);
    const username = field(f, "username").trim();
    const next = safeNext(c.req.query("next"));
    const key = `${username.toLowerCase()}|${clientAddress(c)}`;
    if (throttled(key)) {
      return render(c, "Sign in", <LoginPage csrf={c.get("csrf")} next={next} username={username} error="Too many failed attempts. Try again in a few minutes." />, 429);
    }
    const user = authenticate(deps.db, username, field(f, "password"));
    if (!user) {
      recordFailure(key);
      return render(c, "Sign in", <LoginPage csrf={c.get("csrf")} next={next} username={username} error="Incorrect username or password." />, 401);
    }
    failures.delete(key);
    startSession(c, deps, user.id);
    return c.redirect(next);
  });

  app.post("/logout", (c) => {
    const s = c.get("session");
    if (s) deleteSession(deps.db, s.id);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/");
  });

  app.get("/join/:token", (c) => {
    const token = c.req.param("token");
    const status = inviteStatus(deps.db, token);
    if (status !== "valid") return renderError(c, 404, INVITE_MESSAGES[status]);
    return render(c, "Join", <JoinPage csrf={c.get("csrf")} token={token} />);
  });

  app.post("/join/:token", async (c) => {
    const token = c.req.param("token");
    const status = inviteStatus(deps.db, token);
    if (status !== "valid") return renderError(c, 404, INVITE_MESSAGES[status]);
    const f = await form(c);
    const values = { username: field(f, "username"), email: field(f, "email") };
    try {
      if (field(f, "password") !== field(f, "confirm")) throw new ValidationError("Passwords don't match");
      const user = redeemInvite(deps.db, token, { ...values, password: field(f, "password") });
      startSession(c, deps, user.id);
      return c.redirect("/");
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return render(c, "Join", <JoinPage csrf={c.get("csrf")} token={token} error={err.message} values={values} />, 400);
    }
  });
}
