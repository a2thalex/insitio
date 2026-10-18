import type { Context, Hono } from "hono";
import type { Deps } from "../../deps.js";
import { createInvite, listInvites, listUsers, revokeInvite, setAdmin } from "../../services/users.js";
import { listReposForMember } from "../../services/repos.js";
import type { Env } from "../env.js";
import { loginRedirect } from "../middleware.js";
import { render } from "../render.js";
import { Avatar, CsrfField, Octicon, TimeAgo } from "../views/layout.js";
import { InviteTable } from "../views/invites.js";

export function adminRoutes(deps: Deps, app: Hono<Env>) {
  app.use("/site-admin/*", async (c, next) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    if (!user.isAdmin) return c.notFound();
    await next();
  });
  app.use("/site-admin", async (c, next) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    if (!user.isAdmin) return c.notFound();
    await next();
  });

  const overview = (c: Context<Env>, created?: string) => {
    const me = c.get("user")!;
    const users = listUsers(deps.db);
    return render(
      c,
      "Site admin",
      <div class="container-lg p-responsive py-4">
        <div class="Subhead">
          <h1 class="Subhead-heading">Site admin</h1>
          <div class="Subhead-description">Invite people and manage accounts on this Insitio instance.</div>
        </div>

        <h2 class="f4 mb-2">Invites</h2>
        {created && (
          <div class="flash flash-success mb-3">
            <p class="mb-2">Send this link to the person you're inviting. It works once and expires in 7 days.</p>
            <div class="input-group">
              <input class="form-control text-mono" id="new-invite" value={`${deps.config.baseUrl}/join/${created}`} readonly aria-label="Invite link" />
              <span class="input-group-button">
                <button class="btn" type="button" data-copy-target="new-invite" aria-label="Copy link"><Octicon name="copy" /></button>
              </span>
            </div>
          </div>
        )}
        <form method="post" action="/site-admin/invites" class="mb-3">
          <CsrfField csrf={c.get("csrf")} />
          <button class="btn btn-primary" type="submit"><Octicon name="plus" class="mr-1" />Create invite link</button>
        </form>
        <InviteTable invites={listInvites(deps.db)} baseUrl={deps.config.baseUrl} csrf={c.get("csrf")} revokePath={(t) => `/site-admin/invites/${t}/revoke`} />

        <h2 class="f4 mt-5 mb-2">Users ({users.length})</h2>
        <div class="Box">
          {users.map((u) => (
            <div class="Box-row d-flex flex-items-center">
              <Avatar name={u.username} size={32} class="mr-3" />
              <div class="flex-auto">
                <a class="text-bold Link--primary" href={`/${u.username}`}>{u.username}</a>
                {u.isAdmin && <span class="Label ml-2">Site admin</span>}
                <div class="f6 color-fg-muted">
                  {u.email || "no email"} · joined <TimeAgo ts={u.createdAt} /> · {listReposForMember(deps.db, u).length} repositories
                </div>
              </div>
              {u.id !== me.id && (
                <form method="post" action={`/site-admin/users/${u.id}/admin`}>
                  <CsrfField csrf={c.get("csrf")} />
                  <input type="hidden" name="admin" value={u.isAdmin ? "0" : "1"} />
                  <button class="btn btn-sm" type="submit">{u.isAdmin ? "Remove admin" : "Make admin"}</button>
                </form>
              )}
            </div>
          ))}
        </div>
      </div>,
    );
  };

  app.get("/site-admin", (c) => overview(c));
  app.post("/site-admin/invites", (c) => overview(c, createInvite(deps.db, c.get("user")!.id)));
  app.post("/site-admin/invites/:token/revoke", (c) => {
    revokeInvite(deps.db, c.req.param("token"));
    return c.redirect("/site-admin");
  });
  app.post("/site-admin/users/:id/admin", async (c) => {
    const id = Number(c.req.param("id"));
    if (id !== c.get("user")!.id) {
      const body = await c.req.parseBody({ all: true });
      setAdmin(deps.db, id, body.admin === "1");
    }
    return c.redirect("/site-admin");
  });
}
