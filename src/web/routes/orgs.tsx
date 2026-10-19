import type { Context, Hono } from "hono";
import type { Deps } from "../../deps.js";
import { ValidationError } from "../../services/errors.js";
import { addOrgMember, addTeamMember, createOrg, createTeam, grantTeamRepo, listOrgMembers, listTeams, orgRole } from "../../services/orgs.js";
import { listReposForOwner } from "../../services/repos.js";
import { getUserByName, type User } from "../../services/users.js";
import type { Env } from "../env.js";
import { field, form, loginRedirect } from "../middleware.js";
import { render, renderError } from "../render.js";
import { CsrfField, Flash } from "../views/layout.js";

export function orgRoutes(deps: Deps, app: Hono<Env>) {
  const managedOrg = async (c: Context<Env>): Promise<{ user: User; org: User } | Response> => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const org = getUserByName(deps.db, c.req.param("name") ?? "");
    if (!org || org.kind !== "org") return await renderError(c, 404, "This organization");
    if (orgRole(deps.db, org.id, user.id) !== "owner") return await renderError(c, 403, "Only an owner can manage this organization.");
    return { user, org };
  };
  app.get("/orgs/new", (c) => {
    if (!c.get("user")) return loginRedirect(c);
    return render(c, "New organization", orgForm(c.get("csrf")));
  });

  app.post("/orgs/new", async (c) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const f = await form(c);
    try {
      const org = createOrg(deps.db, user, field(f, "name"), field(f, "display_name"));
      return c.redirect(`/orgs/${org.username}`);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return render(c, "New organization", orgForm(c.get("csrf"), err.message), 400);
    }
  });

  app.get("/orgs/:name", async (c) => {
    const gate = await managedOrg(c);
    if (gate instanceof Response) return gate;
    const { user, org } = gate;
    const repos = listReposForOwner(deps.db, org.id, user);
    return render(
      c,
      org.username,
      <div class="container-lg p-responsive py-4" style="max-width:720px">
        <h1 class="f2 text-normal">{org.displayName || org.username}</h1>
        <p class="color-fg-muted">@{org.username}</p>
        <div class="Subhead"><h2 class="Subhead-heading">People</h2></div>
        <form method="post" action={`/orgs/${org.username}/members`} class="d-flex mb-3" style="gap:8px">
          <CsrfField csrf={c.get("csrf")} />
          <input class="form-control flex-auto" name="username" aria-label="Username" required />
          <button class="btn" type="submit">Add member</button>
        </form>
        <div class="Box mb-4">
          {listOrgMembers(deps.db, org.id).map((member) => (
            <div class="Box-row">{member.username} · {member.role}</div>
          ))}
        </div>
        <div class="Subhead"><h2 class="Subhead-heading">Teams</h2></div>
        <form method="post" action={`/orgs/${org.username}/teams`} class="d-flex mb-3" style="gap:8px">
          <CsrfField csrf={c.get("csrf")} />
          <input class="form-control flex-auto" name="name" aria-label="Team name" required />
          <button class="btn" type="submit">Create team</button>
        </form>
        {listTeams(deps.db, org.id).map((team) => (
          <div class="Box p-3 mb-3">
            <h3 class="f4">{team.name}</h3>
            <form method="post" action={`/orgs/${org.username}/teams/${team.slug}/members`} class="d-flex mb-2" style="gap:8px">
              <CsrfField csrf={c.get("csrf")} />
              <input class="form-control flex-auto" name="username" aria-label="Member" placeholder="Member" required />
              <button class="btn btn-sm" type="submit">Add</button>
            </form>
            <form method="post" action={`/orgs/${org.username}/teams/${team.slug}/repos`} class="d-flex" style="gap:8px">
              <CsrfField csrf={c.get("csrf")} />
              <select class="form-select flex-auto" name="repo" aria-label="Repository">
                {repos.map((repo) => <option value={String(repo.id)}>{repo.name}</option>)}
              </select>
              <select class="form-select" name="role" aria-label="Role">
                <option value="read">read</option>
                <option value="write">write</option>
                <option value="admin">admin</option>
              </select>
              <button class="btn btn-sm" type="submit">Grant</button>
            </form>
          </div>
        ))}
      </div>,
    );
  });

  app.post("/orgs/:name/members", async (c) => {
    const gate = await managedOrg(c);
    if (gate instanceof Response) return gate;
    addOrgMember(deps.db, gate.org, gate.user.id, field(await form(c), "username"));
    return c.redirect(`/orgs/${gate.org.username}`);
  });

  app.post("/orgs/:name/teams", async (c) => {
    const gate = await managedOrg(c);
    if (gate instanceof Response) return gate;
    createTeam(deps.db, gate.org, gate.user.id, field(await form(c), "name"));
    return c.redirect(`/orgs/${gate.org.username}`);
  });

  app.post("/orgs/:name/teams/:slug/members", async (c) => {
    const gate = await managedOrg(c);
    if (gate instanceof Response) return gate;
    addTeamMember(deps.db, gate.org, gate.user.id, c.req.param("slug"), field(await form(c), "username"));
    return c.redirect(`/orgs/${gate.org.username}`);
  });

  app.post("/orgs/:name/teams/:slug/repos", async (c) => {
    const gate = await managedOrg(c);
    if (gate instanceof Response) return gate;
    const f = await form(c);
    const role = field(f, "role");
    if (role !== "read" && role !== "write" && role !== "admin") throw new ValidationError("Unknown role");
    grantTeamRepo(deps.db, gate.org, gate.user.id, c.req.param("slug"), Number(field(f, "repo")), role);
    return c.redirect(`/orgs/${gate.org.username}`);
  });
}

function orgForm(csrf: string, error?: string) {
  return (
    <div class="container-sm p-responsive py-4" style="max-width:440px">
      <h1 class="f2 text-normal">Create an organization</h1>
      <Flash error={error} />
      <form method="post" action="/orgs/new">
        <CsrfField csrf={csrf} />
        <input class="form-control mb-2" name="name" aria-label="Organization name" placeholder="Name" required />
        <input class="form-control mb-3" name="display_name" aria-label="Display name" placeholder="Display name" />
        <button class="btn btn-primary" type="submit">Create organization</button>
      </form>
    </div>
  );
}
