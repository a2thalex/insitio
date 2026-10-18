import type { Context, Hono } from "hono";
import type { Deps } from "../../deps.js";
import { createRateLimiter } from "../../rateLimit.js";
import { decideDevice, findPendingByUserCode, normalizeUserCode } from "../../services/devices.js";
import { ValidationError } from "../../services/errors.js";
import type { Env } from "../env.js";
import { field, form, loginRedirect } from "../middleware.js";
import { render } from "../render.js";
import { CsrfField, Flash } from "../views/layout.js";
import { AuthBox } from "./auth.js";

const WRONG_CODE = "That code isn't valid or has expired. Check your terminal and try again.";

function EnterPage({ csrf, userCode, error }: { csrf: string; userCode?: string; error?: string }) {
  return (
    <AuthBox title="Connect a device">
      <Flash error={error} />
      <div class="Box p-4">
        <form method="post" action="/login/device">
          <CsrfField csrf={csrf} />
          <label for="user_code" class="d-block mb-2">Enter the code shown in your terminal</label>
          <input
            class="form-control input-block text-mono mb-3"
            id="user_code"
            name="user_code"
            value={userCode ?? ""}
            placeholder="ABCD-EFGH"
            maxlength={20}
            autocomplete="off"
            autocapitalize="characters"
            spellcheck={false}
            required
            autofocus
          />
          <button class="btn btn-primary btn-block" type="submit">Continue</button>
        </form>
      </div>
    </AuthBox>
  );
}

function ConfirmPage({ csrf, userCode, clientName, username }: { csrf: string; userCode: string; clientName: string; username: string }) {
  return (
    <AuthBox title="Sign in on a new device?">
      <div class="Box p-4">
        <p class="mb-3">
          <strong>nsit on {clientName}</strong> is asking to sign in to Insitio as <strong>{username}</strong>.
        </p>
        <p class="color-fg-muted f6 mb-3">
          Approving gives it full access to your repositories until you delete its token under Settings, Personal access
          tokens. Only approve if you just ran <code>nsit auth login</code> yourself.
        </p>
        <form method="post" action="/login/device/decide" class="d-flex" style="gap:8px">
          <CsrfField csrf={csrf} />
          <input type="hidden" name="user_code" value={userCode} />
          <button class="btn btn-primary flex-auto" type="submit" name="decision" value="approve">Approve</button>
          <button class="btn flex-auto" type="submit" name="decision" value="deny">Deny</button>
        </form>
      </div>
    </AuthBox>
  );
}

function DonePage({ approved, clientName }: { approved: boolean; clientName: string }) {
  return (
    <AuthBox title={approved ? "Device connected" : "Request denied"}>
      <div class="Box p-4">
        <p class="mb-3">
          {approved
            ? `nsit on ${clientName} is now signed in. You can close this tab and return to your terminal.`
            : `nsit on ${clientName} was not signed in. You can close this tab.`}
        </p>
        <a class="btn btn-block" href="/">Back to Insitio</a>
      </div>
    </AuthBox>
  );
}

/** The pages where a signed-in user approves a device that started `nsit auth login`. */
export function deviceRoutes(deps: Deps, app: Hono<Env>) {
  // Wrong or stale codes per signed-in user, so a code cannot be guessed at.
  const misses = createRateLimiter(10, 15 * 60 * 1000);

  const enter = (c: Context<Env>, opts: { userCode?: string; error?: string }, status: 200 | 400 | 429 = 200) =>
    render(c, "Connect a device", <EnterPage csrf={c.get("csrf")} userCode={opts.userCode} error={opts.error} />, status);

  app.get("/login/device", (c) => {
    if (!c.get("user")) return loginRedirect(c);
    return enter(c, { userCode: c.req.query("user_code") });
  });

  app.post("/login/device", async (c) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const typed = field(await form(c), "user_code");
    const key = `user:${user.id}`;
    if (misses.retryAfter(key) > 0) {
      return enter(c, { userCode: typed, error: "Too many wrong codes. Try again in a few minutes." }, 429);
    }
    const request = findPendingByUserCode(deps.db, typed);
    if (!request) {
      misses.record(key);
      return enter(c, { userCode: typed, error: WRONG_CODE }, 400);
    }
    return render(
      c,
      "Sign in on a new device?",
      <ConfirmPage csrf={c.get("csrf")} userCode={normalizeUserCode(typed)} clientName={request.clientName} username={user.username} />,
    );
  });

  app.post("/login/device/decide", async (c) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const f = await form(c);
    const decision = field(f, "decision");
    if (decision !== "approve" && decision !== "deny") throw new ValidationError("Choose Approve or Deny.");
    const key = `user:${user.id}`;
    if (misses.retryAfter(key) > 0) {
      return enter(c, { error: "Too many wrong codes. Try again in a few minutes." }, 429);
    }
    const request = findPendingByUserCode(deps.db, field(f, "user_code"));
    if (!request || !decideDevice(deps.db, request.id, user.id, decision === "approve")) {
      misses.record(key);
      return enter(c, { error: WRONG_CODE }, 400);
    }
    const approved = decision === "approve";
    return render(c, approved ? "Device connected" : "Request denied", <DonePage approved={approved} clientName={request.clientName} />);
  });
}
