import type { Context, Hono } from "hono";
import type { Child } from "hono/jsx";
import type { Deps } from "../../deps.js";
import { ValidationError } from "../../services/errors.js";
import {
  changePassword, createAccessToken, createInvite, deleteAccessToken, listAccessTokens, listInvites, revokeInvite,
  updateProfile, type User,
} from "../../services/users.js";
import type { Env } from "../env.js";
import { field, form, loginRedirect } from "../middleware.js";
import { render } from "../render.js";
import { Avatar, CsrfField, Flash, Octicon, TimeAgo } from "../views/layout.js";
import { InviteTable } from "../views/invites.js";

type Section = "profile" | "password" | "tokens" | "invites";

function SettingsLayout({ user, section, showInvites, children }: { user: User; section: Section; showInvites: boolean; children: Child }) {
  const item = (s: Section, label: string, icon: string) => (
    <a class="menu-item" href={`/settings/${s}`} aria-current={section === s ? "page" : undefined}>
      <Octicon name={icon} class="mr-2" />
      {label}
    </a>
  );
  return (
    <div class="container-lg p-responsive py-4">
      <div class="d-flex flex-items-center mb-4">
        <Avatar name={user.username} size={48} class="mr-3" />
        <div>
          <h1 class="f3 text-normal">{user.displayName || user.username}</h1>
          <p class="color-fg-muted mb-0">Your personal account</p>
        </div>
      </div>
      <div class="d-md-flex">
        <nav class="menu col-md-3 mr-md-4 mb-4" aria-label="Settings">
          {item("profile", "Public profile", "person")}
          {item("password", "Password", "shield-lock")}
          {item("tokens", "Personal access tokens", "key")}
          {showInvites && item("invites", "Invites", "mail")}
        </nav>
        <div class="flex-auto">{children}</div>
      </div>
    </div>
  );
}

export function settingsRoutes(deps: Deps, app: Hono<Env>) {
  const showInvites = (u: User) => deps.config.allowUserInvites || u.isAdmin;

  const page = (c: Context<Env>, section: Section, title: string, body: Child, status: 200 | 400 = 200) => {
    const user = c.get("user")!;
    return render(
      c,
      title,
      <SettingsLayout user={user} section={section} showInvites={showInvites(user)}>
        {body}
      </SettingsLayout>,
      status,
    );
  };

  app.use("/settings/*", async (c, next) => {
    if (!c.get("user")) return loginRedirect(c);
    await next();
  });
  app.get("/settings", (c) => (c.get("user") ? c.redirect("/settings/profile") : loginRedirect(c)));

  const profileForm = (c: Context<Env>, opts: { error?: string; notice?: string } = {}) => {
    const user = c.get("user")!;
    return (
      <>
        <div class="Subhead"><h2 class="Subhead-heading">Public profile</h2></div>
        <Flash error={opts.error} notice={opts.notice} />
        <form method="post" action="/settings/profile" style="max-width:440px">
          <CsrfField csrf={c.get("csrf")} />
          <div class="form-group">
            <div class="form-group-header"><label for="display_name">Name</label></div>
            <div class="form-group-body"><input class="form-control input-block" id="display_name" name="display_name" value={user.displayName} /></div>
          </div>
          <div class="form-group">
            <div class="form-group-header"><label for="email">Email</label></div>
            <div class="form-group-body"><input class="form-control input-block" id="email" name="email" type="email" value={user.email} /></div>
            <p class="note">Used as the author email for commits you make in Insitio, like merges.</p>
          </div>
          <div class="form-group">
            <div class="form-group-header"><label for="bio">Bio</label></div>
            <div class="form-group-body"><textarea class="form-control input-block" id="bio" name="bio" style="min-height:80px">{user.bio}</textarea></div>
          </div>
          <button class="btn btn-primary" type="submit">Update profile</button>
        </form>
      </>
    );
  };

  app.get("/settings/profile", (c) => page(c, "profile", "Profile", profileForm(c, { notice: c.req.query("saved") ? "Profile updated." : undefined })));
  app.post("/settings/profile", async (c) => {
    const f = await form(c);
    try {
      updateProfile(deps.db, c.get("user")!.id, { displayName: field(f, "display_name"), email: field(f, "email"), bio: field(f, "bio") });
      return c.redirect("/settings/profile?saved=1");
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return page(c, "profile", "Profile", profileForm(c, { error: err.message }), 400);
    }
  });

  const passwordForm = (c: Context<Env>, opts: { error?: string; notice?: string } = {}) => (
    <>
      <div class="Subhead"><h2 class="Subhead-heading">Change password</h2></div>
      <Flash error={opts.error} notice={opts.notice} />
      <form method="post" action="/settings/password" style="max-width:440px">
        <CsrfField csrf={c.get("csrf")} />
        <div class="form-group">
          <div class="form-group-header"><label for="current">Old password</label></div>
          <div class="form-group-body"><input class="form-control input-block" id="current" name="current" type="password" autocomplete="current-password" required /></div>
        </div>
        <div class="form-group">
          <div class="form-group-header"><label for="next">New password</label></div>
          <div class="form-group-body"><input class="form-control input-block" id="next" name="next" type="password" autocomplete="new-password" minlength={8} required /></div>
        </div>
        <div class="form-group">
          <div class="form-group-header"><label for="confirm">Confirm new password</label></div>
          <div class="form-group-body"><input class="form-control input-block" id="confirm" name="confirm" type="password" autocomplete="new-password" required /></div>
        </div>
        <button class="btn btn-primary" type="submit">Update password</button>
      </form>
    </>
  );

  app.get("/settings/password", (c) => page(c, "password", "Password", passwordForm(c, { notice: c.req.query("saved") ? "Password updated." : undefined })));
  app.post("/settings/password", async (c) => {
    const f = await form(c);
    try {
      if (field(f, "next") !== field(f, "confirm")) throw new ValidationError("New passwords don't match");
      changePassword(deps.db, c.get("user")!.id, field(f, "current"), field(f, "next"));
      return c.redirect("/settings/password?saved=1");
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return page(c, "password", "Password", passwordForm(c, { error: err.message }), 400);
    }
  });

  const tokensPage = (c: Context<Env>, opts: { error?: string; created?: string } = {}) => {
    const user = c.get("user")!;
    const tokens = listAccessTokens(deps.db, user.id);
    return (
      <>
        <div class="Subhead"><h2 class="Subhead-heading">Personal access tokens</h2></div>
        <p class="color-fg-muted">
          Use a token as your password when cloning or pushing over HTTPS:{" "}
          <code>git clone {deps.config.baseUrl}/{user.username}/&lt;repo&gt;.git</code>
        </p>
        <Flash error={opts.error} />
        {opts.created && (
          <div class="flash flash-success mb-3">
            <p class="mb-2">Make sure to copy your token now. You won't be able to see it again.</p>
            <div class="input-group">
              <input class="form-control text-mono" id="new-token" value={opts.created} readonly aria-label="New token" />
              <span class="input-group-button">
                <button class="btn" type="button" data-copy-target="new-token" aria-label="Copy token"><Octicon name="copy" /></button>
              </span>
            </div>
          </div>
        )}
        <form method="post" action="/settings/tokens" class="d-flex mb-4" style="max-width:520px">
          <CsrfField csrf={c.get("csrf")} />
          <input class="form-control flex-auto mr-2" name="name" placeholder="What's this token for? e.g. laptop" aria-label="Token name" required />
          <button class="btn btn-primary" type="submit">Generate token</button>
        </form>
        <div class="Box">
          {tokens.length === 0 ? (
            <div class="Box-row color-fg-muted">You don't have any tokens yet.</div>
          ) : (
            tokens.map((t) => (
              <div class="Box-row d-flex flex-items-center">
                <Octicon name="key" class="mr-2 color-fg-muted" />
                <div class="flex-auto">
                  <strong>{t.name}</strong>
                  <div class="f6 color-fg-muted">
                    Created <TimeAgo ts={t.createdAt} /> · {t.lastUsedAt ? <>Last used <TimeAgo ts={t.lastUsedAt} /></> : "Never used"}
                  </div>
                </div>
                <form method="post" action={`/settings/tokens/${t.id}/delete`}>
                  <CsrfField csrf={c.get("csrf")} />
                  <button class="btn btn-sm btn-danger" type="submit">Delete</button>
                </form>
              </div>
            ))
          )}
        </div>
      </>
    );
  };

  app.get("/settings/tokens", (c) => page(c, "tokens", "Tokens", tokensPage(c)));
  app.post("/settings/tokens", async (c) => {
    const f = await form(c);
    try {
      const token = createAccessToken(deps.db, c.get("user")!.id, field(f, "name"));
      return page(c, "tokens", "Tokens", tokensPage(c, { created: token }));
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return page(c, "tokens", "Tokens", tokensPage(c, { error: err.message }), 400);
    }
  });
  app.post("/settings/tokens/:id/delete", (c) => {
    deleteAccessToken(deps.db, c.get("user")!.id, Number(c.req.param("id")));
    return c.redirect("/settings/tokens");
  });

  const invitesPage = (c: Context<Env>, created?: string) => {
    const user = c.get("user")!;
    return (
      <>
        <div class="Subhead"><h2 class="Subhead-heading">Invites</h2></div>
        <p class="color-fg-muted">Insitio is invite-only. Each link creates one account and expires after 7 days.</p>
        {created && (
          <div class="flash flash-success mb-3">
            <div class="input-group">
              <input class="form-control text-mono" id="new-invite" value={`${deps.config.baseUrl}/join/${created}`} readonly aria-label="Invite link" />
              <span class="input-group-button">
                <button class="btn" type="button" data-copy-target="new-invite" aria-label="Copy link"><Octicon name="copy" /></button>
              </span>
            </div>
          </div>
        )}
        <form method="post" action="/settings/invites" class="mb-4">
          <CsrfField csrf={c.get("csrf")} />
          <button class="btn btn-primary" type="submit"><Octicon name="plus" class="mr-1" />Create invite link</button>
        </form>
        <InviteTable invites={listInvites(deps.db, user.id)} baseUrl={deps.config.baseUrl} csrf={c.get("csrf")} revokePath={(t) => `/settings/invites/${t}/revoke`} />
      </>
    );
  };

  const invitesAllowed = (c: Context<Env>) => showInvites(c.get("user")!);
  app.get("/settings/invites", (c) => (invitesAllowed(c) ? page(c, "invites", "Invites", invitesPage(c)) : c.notFound()));
  app.post("/settings/invites", (c) => {
    if (!invitesAllowed(c)) return c.notFound();
    const token = createInvite(deps.db, c.get("user")!.id);
    return page(c, "invites", "Invites", invitesPage(c, token));
  });
  app.post("/settings/invites/:token/revoke", (c) => {
    if (!invitesAllowed(c)) return c.notFound();
    revokeInvite(deps.db, c.req.param("token"), c.get("user")!.id);
    return c.redirect("/settings/invites");
  });
}
