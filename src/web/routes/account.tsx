import type { Context, Hono } from "hono";
import type { Child } from "hono/jsx";
import type { Deps } from "../../deps.js";
import { ValidationError } from "../../services/errors.js";
import {
  addEmail, addGpgKey, addSavedReply, addSshKey, beginTotp, blockUser, confirmTotp, deleteGpgKey,
  deleteSavedReply, deleteSshKey, disableTotp, listBlocks, listEmails, listGpgKeys, listSavedReplies, listSecurity,
  listSessions, listSshKeys, makePrimaryEmail, removeEmail, revokeOtherSessions, revokeSession,
  setAppearance, unblockUser, userHasTotp,
} from "../../services/account.js";
import type { Env } from "../env.js";
import { field, form } from "../middleware.js";
import { CsrfField, Flash, TimeAgo } from "../views/layout.js";
import type { SettingsSection } from "./settings.js";

type Page = (c: Context<Env>, section: SettingsSection, title: string, body: Child, status?: 200 | 400) => Response | Promise<Response>;

export function registerAccountRoutes(deps: Deps, app: Hono<Env>, page: Page) {
  app.get("/settings/emails", (c) => page(c, "emails", "Emails", emailPage(c, deps)));
  app.post("/settings/emails", async (c) => {
    const user = c.get("user")!;
    try {
      addEmail(deps.db, user.id, field(await form(c), "email"));
      return c.redirect("/settings/emails");
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return page(c, "emails", "Emails", emailPage(c, deps, err.message), 400);
    }
  });
  app.post("/settings/emails/:id/primary", async (c) => {
    await form(c);
    makePrimaryEmail(deps.db, c.get("user")!.id, Number(c.req.param("id")));
    return c.redirect("/settings/emails");
  });
  app.post("/settings/emails/:id/delete", async (c) => {
    await form(c);
    removeEmail(deps.db, c.get("user")!.id, Number(c.req.param("id")));
    return c.redirect("/settings/emails");
  });

  app.get("/settings/sessions", (c) => page(c, "sessions", "Sessions", sessionPage(c, deps)));
  app.post("/settings/sessions/revoke", async (c) => {
    const user = c.get("user")!;
    const f = await form(c);
    if (field(f, "all") === "1") revokeOtherSessions(deps.db, user.id, c.get("session")!.id);
    else revokeSession(deps.db, user.id, field(f, "id"));
    return c.redirect("/settings/sessions");
  });

  app.get("/settings/security", (c) => page(c, "security", "Security", securityPage(c, deps)));
  app.post("/settings/security/totp/start", async (c) => {
    await form(c);
    const user = c.get("user")!;
    const started = beginTotp(deps.db, user.id, user.username);
    return page(c, "security", "Security", securityPage(c, deps, { secret: started.secret, url: started.url }));
  });
  app.post("/settings/security/totp/confirm", async (c) => {
    const codes = confirmTotp(deps.db, c.get("user")!.id, field(await form(c), "code"));
    return page(c, "security", "Security", securityPage(c, deps, { codes }));
  });
  app.post("/settings/security/totp/disable", async (c) => {
    disableTotp(deps.db, c.get("user")!.id, field(await form(c), "code"));
    return c.redirect("/settings/security");
  });

  app.get("/settings/appearance", (c) => page(c, "appearance", "Appearance", appearancePage(c)));
  app.post("/settings/appearance", async (c) => {
    const f = await form(c);
    setAppearance(deps.db, c.get("user")!.id, field(f, "theme"), field(f, "notify"));
    return c.redirect("/settings/appearance");
  });

  app.get("/settings/blocks", (c) => page(c, "blocks", "Blocked users", blockPage(c, deps)));
  app.post("/settings/blocks", async (c) => {
    try {
      blockUser(deps.db, c.get("user")!.id, field(await form(c), "username"));
      return c.redirect("/settings/blocks");
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return page(c, "blocks", "Blocked users", blockPage(c, deps, err.message), 400);
    }
  });
  app.post("/settings/blocks/:id/delete", async (c) => {
    await form(c);
    unblockUser(deps.db, c.get("user")!.id, Number(c.req.param("id")));
    return c.redirect("/settings/blocks");
  });

  app.get("/settings/replies", (c) => page(c, "replies", "Saved replies", replyPage(c, deps)));
  app.post("/settings/replies", async (c) => {
    const f = await form(c);
    addSavedReply(deps.db, c.get("user")!.id, field(f, "title"), field(f, "body"));
    return c.redirect("/settings/replies");
  });
  app.post("/settings/replies/:id/delete", async (c) => {
    await form(c);
    deleteSavedReply(deps.db, c.get("user")!.id, Number(c.req.param("id")));
    return c.redirect("/settings/replies");
  });

  app.get("/settings/keys", (c) => page(c, "keys", "SSH and GPG keys", keysPage(c, deps)));
  app.post("/settings/keys/ssh", async (c) => {
    const f = await form(c);
    try {
      addSshKey(deps.db, c.get("user")!.id, field(f, "title"), field(f, "key"));
      return c.redirect("/settings/keys");
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return page(c, "keys", "SSH and GPG keys", keysPage(c, deps, err.message), 400);
    }
  });
  app.post("/settings/keys/ssh/:id/delete", async (c) => {
    await form(c);
    deleteSshKey(deps.db, c.get("user")!.id, Number(c.req.param("id")));
    return c.redirect("/settings/keys");
  });
  app.post("/settings/keys/gpg", async (c) => {
    try {
      addGpgKey(deps.db, c.get("user")!.id, field(await form(c), "key"));
      return c.redirect("/settings/keys");
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return page(c, "keys", "SSH and GPG keys", keysPage(c, deps, err.message), 400);
    }
  });
  app.post("/settings/keys/gpg/:id/delete", async (c) => {
    await form(c);
    deleteGpgKey(deps.db, c.get("user")!.id, Number(c.req.param("id")));
    return c.redirect("/settings/keys");
  });
}

function emailPage(c: Context<Env>, deps: Deps, error?: string) {
  const rows = listEmails(deps.db, c.get("user")!.id);
  return (
    <>
      <div class="Subhead"><h2 class="Subhead-heading">Emails</h2></div>
      <Flash error={error} />
      <p class="f6 color-fg-muted">The primary address is used when Insitio commits for you. Addresses are not verified by mail.</p>
      <div class="Box mb-3">
        {rows.map((row) => (
          <div class="Box-row d-flex flex-items-center">
            <span class="flex-auto">{row.email}{row.primary ? " · primary" : ""}</span>
            {!row.primary && (
              <form method="post" action={`/settings/emails/${row.id}/primary`} class="mr-2">
                <CsrfField csrf={c.get("csrf")} />
                <button class="btn btn-sm" type="submit">Make primary</button>
              </form>
            )}
            <form method="post" action={`/settings/emails/${row.id}/delete`}>
              <CsrfField csrf={c.get("csrf")} />
              <button class="btn btn-sm" type="submit">Remove</button>
            </form>
          </div>
        ))}
      </div>
      <form method="post" action="/settings/emails" class="d-flex" style="gap:8px">
        <CsrfField csrf={c.get("csrf")} />
        <input class="form-control flex-auto" name="email" type="email" aria-label="Email" required />
        <button class="btn" type="submit">Add</button>
      </form>
    </>
  );
}

function sessionPage(c: Context<Env>, deps: Deps) {
  const rows = listSessions(deps.db, c.get("user")!.id, c.get("session")!.id);
  return (
    <>
      <div class="Subhead"><h2 class="Subhead-heading">Sessions</h2></div>
      <form method="post" action="/settings/sessions/revoke" class="mb-3">
        <CsrfField csrf={c.get("csrf")} />
        <input type="hidden" name="all" value="1" />
        <button class="btn" type="submit">Revoke other sessions</button>
      </form>
      <div class="Box">
        {rows.map((row) => (
          <div class="Box-row d-flex flex-items-center">
            <div class="flex-auto">
              <strong>{row.current ? "This session" : "Session"}</strong>
              <div class="f6 color-fg-muted">{row.userAgent || "Unknown client"} · <TimeAgo ts={row.createdAt} /></div>
            </div>
            {!row.current && (
              <form method="post" action="/settings/sessions/revoke">
                <CsrfField csrf={c.get("csrf")} />
                <input type="hidden" name="id" value={row.id} />
                <button class="btn btn-sm" type="submit">Revoke</button>
              </form>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function securityPage(c: Context<Env>, deps: Deps, extra: { secret?: string; url?: string; codes?: string[] } = {}) {
  const user = c.get("user")!;
  const on = userHasTotp(deps.db, user.id);
  const events = listSecurity(deps.db, user.id);
  return (
    <>
      <div class="Subhead"><h2 class="Subhead-heading">Two-factor authentication</h2></div>
      <Flash />
      {extra.codes && (
        <div class="flash flash-warn mb-3">
          <p>Save these recovery codes. Each one works once.</p>
          <pre>{extra.codes.join("\n")}</pre>
        </div>
      )}
      {extra.secret && (
        <form method="post" action="/settings/security/totp/confirm" class="mb-4">
          <CsrfField csrf={c.get("csrf")} />
          <p class="f6">Add this secret to an authenticator, then enter a code. <code>{extra.secret}</code></p>
          <p class="f6 text-mono">{extra.url}</p>
          <input class="form-control mb-2" name="code" inputmode="numeric" aria-label="Authentication code" required />
          <button class="btn btn-primary" type="submit">Confirm</button>
        </form>
      )}
      {!on && !extra.secret && (
        <form method="post" action="/settings/security/totp/start" class="mb-4">
          <CsrfField csrf={c.get("csrf")} />
          <button class="btn" type="submit">Enable two-factor authentication</button>
        </form>
      )}
      {on && (
        <form method="post" action="/settings/security/totp/disable" class="mb-4 d-flex" style="gap:8px">
          <CsrfField csrf={c.get("csrf")} />
          <input class="form-control" name="code" aria-label="Authentication code" required />
          <button class="btn" type="submit">Disable</button>
        </form>
      )}
      <div class="Subhead"><h2 class="Subhead-heading">Security log</h2></div>
      <div class="Box">
        {events.length === 0 && <div class="Box-row color-fg-muted">No events yet.</div>}
        {events.map((event) => (
          <div class="Box-row f6"><strong>{event.kind}</strong>{event.detail ? ` · ${event.detail}` : ""} · <TimeAgo ts={event.createdAt} /></div>
        ))}
      </div>
    </>
  );
}

function appearancePage(c: Context<Env>) {
  const user = c.get("user")!;
  const theme = (value: string, label: string) => (
    <label class="d-block mb-1"><input type="radio" name="theme" value={value} checked={user.theme === value} class="mr-1" />{label}</label>
  );
  const notify = (value: string, label: string) => (
    <label class="d-block mb-1"><input type="radio" name="notify" value={value} checked={user.notify === value} class="mr-1" />{label}</label>
  );
  return (
    <>
      <div class="Subhead"><h2 class="Subhead-heading">Appearance</h2></div>
      <form method="post" action="/settings/appearance">
        <CsrfField csrf={c.get("csrf")} />
        <fieldset class="mb-3">
          <legend class="text-bold mb-2">Theme</legend>
          {theme("dark", "Dark")}
          {theme("light", "Light")}
          {theme("system", "Match the system")}
        </fieldset>
        <fieldset class="mb-3">
          <legend class="text-bold mb-2">Notifications</legend>
          <p class="f6 color-fg-muted">Saved for the inbox. Insitio does not send email.</p>
          {notify("participating", "Participating")}
          {notify("all", "All activity")}
          {notify("ignore", "Ignore")}
        </fieldset>
        <button class="btn btn-primary" type="submit">Save</button>
      </form>
    </>
  );
}

function blockPage(c: Context<Env>, deps: Deps, error?: string) {
  const rows = listBlocks(deps.db, c.get("user")!.id);
  return (
    <>
      <div class="Subhead"><h2 class="Subhead-heading">Blocked users</h2></div>
      <Flash error={error} />
      <form method="post" action="/settings/blocks" class="d-flex mb-3" style="gap:8px">
        <CsrfField csrf={c.get("csrf")} />
        <input class="form-control flex-auto" name="username" aria-label="Username" required />
        <button class="btn" type="submit">Block</button>
      </form>
      <div class="Box">
        {rows.map((row) => (
          <div class="Box-row d-flex flex-items-center">
            <span class="flex-auto">{row.username}</span>
            <form method="post" action={`/settings/blocks/${row.id}/delete`}>
              <CsrfField csrf={c.get("csrf")} />
              <button class="btn btn-sm" type="submit">Unblock</button>
            </form>
          </div>
        ))}
      </div>
    </>
  );
}

function replyPage(c: Context<Env>, deps: Deps) {
  const rows = listSavedReplies(deps.db, c.get("user")!.id);
  return (
    <>
      <div class="Subhead"><h2 class="Subhead-heading">Saved replies</h2></div>
      <form method="post" action="/settings/replies" class="mb-3">
        <CsrfField csrf={c.get("csrf")} />
        <input class="form-control mb-2" name="title" aria-label="Title" required maxlength={80} />
        <textarea class="form-control mb-2" name="body" aria-label="Body" rows={4} required></textarea>
        <button class="btn" type="submit">Save reply</button>
      </form>
      <div class="Box">
        {rows.map((row) => (
          <div class="Box-row d-flex flex-items-center">
            <span class="flex-auto">{row.title}</span>
            <form method="post" action={`/settings/replies/${row.id}/delete`}>
              <CsrfField csrf={c.get("csrf")} />
              <button class="btn btn-sm" type="submit">Delete</button>
            </form>
          </div>
        ))}
      </div>
    </>
  );
}

function keysPage(c: Context<Env>, deps: Deps, error?: string) {
  const userId = c.get("user")!.id;
  return (
    <>
      <div class="Subhead"><h2 class="Subhead-heading">SSH keys</h2></div>
      <p class="f6 color-fg-muted">Stored for your account. Git over SSH is not available yet, so these keys do not authenticate pushes.</p>
      <Flash error={error} />
      <form method="post" action="/settings/keys/ssh" class="mb-3">
        <CsrfField csrf={c.get("csrf")} />
        <input class="form-control mb-2" name="title" aria-label="Title" required />
        <textarea class="form-control mb-2" name="key" aria-label="Public key" rows={3} required></textarea>
        <button class="btn" type="submit">Add SSH key</button>
      </form>
      <div class="Box mb-4">
        {listSshKeys(deps.db, userId).map((key) => (
          <div class="Box-row d-flex flex-items-center">
            <span class="flex-auto">{key.title} · <code>{key.fingerprint}</code></span>
            <form method="post" action={`/settings/keys/ssh/${key.id}/delete`}>
              <CsrfField csrf={c.get("csrf")} />
              <button class="btn btn-sm" type="submit">Delete</button>
            </form>
          </div>
        ))}
      </div>
      <div class="Subhead"><h2 class="Subhead-heading">GPG keys</h2></div>
      <form method="post" action="/settings/keys/gpg" class="mb-3">
        <CsrfField csrf={c.get("csrf")} />
        <textarea class="form-control mb-2" name="key" aria-label="Armored public key" rows={5} required></textarea>
        <button class="btn" type="submit">Add GPG key</button>
      </form>
      <div class="Box">
        {listGpgKeys(deps.db, userId).map((key) => (
          <div class="Box-row d-flex flex-items-center">
            <code class="flex-auto">{key.keyId}</code>
            <form method="post" action={`/settings/keys/gpg/${key.id}/delete`}>
              <CsrfField csrf={c.get("csrf")} />
              <button class="btn btn-sm" type="submit">Delete</button>
            </form>
          </div>
        ))}
      </div>
    </>
  );
}
