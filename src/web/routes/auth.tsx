import type { Context, Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { Deps } from "../../deps.js";
import { requestBucket } from "../../clientAddress.js";
import { ValidationError } from "../../services/errors.js";
import { acceptSecondFactor, logSecurity, totpSecret } from "../../services/account.js";
import { authenticate, createSession, deleteSession, inviteStatus, redeemInvite } from "../../services/users.js";
import type { Env } from "../env.js";
import { SESSION_COOKIE, cookieOptions, field, form, safeNext } from "../middleware.js";
import { render, renderError } from "../render.js";
import { CsrfField, Flash, InsitioMark } from "../views/layout.js";

// Failed sign-ins per username+client (an IPv4 address or an IPv6 /64), to slow down password guessing.
const failures = new Map<string, { count: number; until: number }>();
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

function throttled(key: string): boolean {
  const f = failures.get(key);
  return !!f && f.count >= MAX_FAILURES && f.until > Date.now();
}

function recordFailure(key: string) {
  const f = failures.get(key);
  if (!f || f.until < Date.now()) failures.set(key, { count: 1, until: Date.now() + WINDOW_MS });
  else f.count++;
}

export function AuthBox({ title, children }: { title: string; children: any }) {
  return (
    <div class="constellation">
      <div class="container-sm px-3 py-6" style="max-width:360px">
        <div class="text-center mb-4">
          <InsitioMark size={56} />
          <h1 class="f1 mt-2">{title}</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

function LoginPage({ csrf, next, error, username, needCode }: { csrf: string; next: string; error?: string; username?: string; needCode?: boolean }) {
  return (
    <AuthBox title="Sign in to Insitio">
      <Flash error={error} />
      <div class="Box p-4">
        <form method="post" action={`/login?next=${encodeURIComponent(next)}`}>
          <CsrfField csrf={csrf} />
          <label for="login_field" class="d-block mb-2">Username</label>
          <input class="form-control input-block mb-3" id="login_field" name="username" autocomplete="username" value={username ?? ""} required autofocus />
          <label for="password" class="d-block mb-2">Password</label>
          <input class="form-control input-block mb-3" id="password" name="password" type="password" autocomplete="current-password" required />
          {needCode && (
            <>
              <label for="code" class="d-block mb-2">Authentication code</label>
              <input class="form-control input-block mb-3" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus />
            </>
          )}
          <button class="btn btn-primary btn-block" type="submit">Sign in</button>
        </form>
      </div>
      <p class="text-center color-fg-muted f6 mt-3">
        Insitio is invite-only. Ask an admin for an invite link.
      </p>
    </AuthBox>
  );
}

function JoinPage({ csrf, token, error, values }: { csrf: string; token: string; error?: string; values?: Record<string, string> }) {
  return (
    <AuthBox title="Create your Insitio account">
      <Flash error={error} />
      <div class="Box p-4">
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
  const s = createSession(deps.db, userId, c.req.header("user-agent") ?? "");
  logSecurity(deps.db, userId, "login");
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
    const key = `${username.toLowerCase()}|${requestBucket(c, deps.config.trustedProxies)}`;
    if (throttled(key)) {
      return render(c, "Sign in", <LoginPage csrf={c.get("csrf")} next={next} username={username} error="Too many failed attempts. Try again in a few minutes." />, 429);
    }
    const user = authenticate(deps.db, username, field(f, "password"));
    if (!user) {
      recordFailure(key);
      return render(c, "Sign in", <LoginPage csrf={c.get("csrf")} next={next} username={username} error="Incorrect username or password." />, 401);
    }
    const secret = totpSecret(deps.db, user.id);
    if (secret) {
      const code = field(f, "code");
      if (!code) return render(c, "Sign in", <LoginPage csrf={c.get("csrf")} next={next} username={username} needCode />);
      if (!acceptSecondFactor(deps.db, user.id, secret, code)) {
        recordFailure(key);
        return render(c, "Sign in", <LoginPage csrf={c.get("csrf")} next={next} username={username} needCode error="That code is not valid." />, 401);
      }
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
