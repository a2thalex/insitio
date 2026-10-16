import type { Context, Hono } from "hono";
import type { Deps } from "../../deps.js";
import { ValidationError } from "../../services/errors.js";
import {
  addCollaborator, deleteRepo, listCollaborators, removeCollaborator, setDefaultBranch, updateRepo, type Collaborator,
} from "../../services/repos.js";
import { getUserByName } from "../../services/users.js";
import type { Env } from "../env.js";
import { field, form } from "../middleware.js";
import { repoUrl } from "../paths.js";
import type { RepoCtx } from "../repoContext.js";
import { Avatar, CsrfField, Flash, Octicon } from "../views/layout.js";
import { repoPage, withRepo } from "./code.js";

const ROLES: Collaborator["role"][] = ["read", "write", "admin"];

export function repoSettingsRoutes(deps: Deps, app: Hono<Env>) {
  const R = "/:owner/:repo";

  const page = async (c: Context<Env>, ctx: RepoCtx, opts: { error?: string; notice?: string } = {}) => {
    const { owner, name, description, isPrivate, defaultBranch } = ctx.repo;
    const base = repoUrl(owner, name, "settings");
    const branches = (await ctx.git.branches()).map((b) => b.name);
    const collaborators = listCollaborators(deps.db, ctx.repo.id);
    const csrf = c.get("csrf");
    return repoPage(
      c,
      ctx,
      "settings",
      `Settings · ${owner}/${name}`,
      <div style="max-width:760px">
        <Flash error={opts.error} notice={opts.notice} />
        <div class="Subhead"><h2 class="Subhead-heading">General</h2></div>
        <form method="post" action={base} class="mb-6">
          <CsrfField csrf={csrf} />
          <div class="form-group">
            <div class="form-group-header"><label for="description">Description</label></div>
            <div class="form-group-body"><input class="form-control input-block" id="description" name="description" value={description} maxlength={350} /></div>
          </div>
          <div class="form-group">
            <div class="form-group-header"><label for="default_branch">Default branch</label></div>
            <div class="form-group-body">
              {branches.length === 0 ? (
                <p class="color-fg-muted f6">Push a branch first.</p>
              ) : (
                <select class="form-select" id="default_branch" name="default_branch">
                  {branches.map((b) => <option value={b} selected={b === defaultBranch}>{b}</option>)}
                </select>
              )}
            </div>
          </div>
          <fieldset class="form-group">
            <legend class="text-bold mb-2">Visibility</legend>
            <label class="d-block mb-1"><input type="radio" name="visibility" value="public" checked={!isPrivate} class="mr-1" />Public</label>
            <label class="d-block"><input type="radio" name="visibility" value="private" checked={isPrivate} class="mr-1" />Private</label>
          </fieldset>
          <button class="btn btn-primary" type="submit">Save changes</button>
        </form>

        <div class="Subhead"><h2 class="Subhead-heading">Collaborators</h2></div>
        <div class="Box mb-3">
          {collaborators.length === 0 && <div class="Box-row color-fg-muted">Only you can push to this repository.</div>}
          {collaborators.map((cb) => (
            <div class="Box-row d-flex flex-items-center">
              <Avatar name={cb.username} size={24} class="mr-2" />
              <a class="flex-auto text-bold Link--primary" href={`/${cb.username}`}>{cb.username}</a>
              <span class="Label mr-3">{cb.role}</span>
              <form method="post" action={`${base}/collaborators`}>
                <CsrfField csrf={csrf} />
                <input type="hidden" name="username" value={cb.username} />
                <button class="btn btn-sm btn-danger" type="submit" name="action" value="remove">Remove</button>
              </form>
            </div>
          ))}
        </div>
        <form method="post" action={`${base}/collaborators`} class="d-flex flex-wrap mb-6" style="gap:8px">
          <CsrfField csrf={csrf} />
          <input class="form-control flex-auto" name="username" placeholder="Username" aria-label="Collaborator username" required />
          <select class="form-select" name="role" aria-label="Role">
            {ROLES.map((r) => <option value={r} selected={r === "write"}>{r}</option>)}
          </select>
          <button class="btn" type="submit" name="action" value="add"><Octicon name="person-add" class="mr-1" />Add collaborator</button>
        </form>

        <div class="Subhead"><h2 class="Subhead-heading color-fg-danger">Danger zone</h2></div>
        <div class="Box Box--danger p-3">
          <h3 class="f5">Delete this repository</h3>
          <p class="f6 color-fg-muted">This permanently deletes the repository, its issues and its pull requests. Type <strong>{owner}/{name}</strong> to confirm.</p>
          <form method="post" action={`${base}/delete`} class="d-flex flex-wrap" style="gap:8px">
            <CsrfField csrf={csrf} />
            <input class="form-control flex-auto" name="confirm" aria-label="Type the repository name to confirm" autocomplete="off" required />
            <button class="btn btn-danger" type="submit">Delete this repository</button>
          </form>
        </div>
      </div>,
      opts.error ? 400 : 200,
    );
  };

  app.get(`${R}/settings`, withRepo(deps, "admin", (c, ctx) => page(c, ctx, { notice: c.req.query("saved") ? "Settings saved." : undefined })));

  app.post(`${R}/settings`, withRepo(deps, "admin", async (c, ctx) => {
    const f = await form(c);
    updateRepo(deps.db, ctx.repo.id, { description: field(f, "description"), isPrivate: field(f, "visibility") === "private" });
    const branch = field(f, "default_branch");
    if (branch && branch !== ctx.repo.defaultBranch) {
      const branches = (await ctx.git.branches()).map((b) => b.name);
      if (!branches.includes(branch)) return page(c, ctx, { error: `Branch ${branch} doesn't exist` });
      await ctx.git.setHead(branch);
      setDefaultBranch(deps.db, ctx.repo.id, branch);
    }
    return c.redirect(`${repoUrl(ctx.repo.owner, ctx.repo.name, "settings")}?saved=1`);
  }));

  app.post(`${R}/settings/collaborators`, withRepo(deps, "admin", async (c, ctx) => {
    const f = await form(c);
    const username = field(f, "username").trim();
    const user = getUserByName(deps.db, username);
    if (!user) return page(c, ctx, { error: `No user named ${username}` });
    if (field(f, "action") === "remove") {
      removeCollaborator(deps.db, ctx.repo.id, user.id);
    } else {
      if (user.id === ctx.repo.ownerId) return page(c, ctx, { error: "The owner already has full access" });
      const role = field(f, "role") as Collaborator["role"];
      if (!ROLES.includes(role)) throw new ValidationError("Unknown role");
      addCollaborator(deps.db, ctx.repo.id, user.id, role);
    }
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "settings"));
  }));

  app.post(`${R}/settings/delete`, withRepo(deps, "admin", async (c, ctx) => {
    const f = await form(c);
    const expected = `${ctx.repo.owner}/${ctx.repo.name}`;
    if (field(f, "confirm").trim().toLowerCase() !== expected.toLowerCase()) {
      return page(c, ctx, { error: `Type ${expected} to confirm deletion` });
    }
    await deleteRepo(deps, ctx.repo);
    return c.redirect(`/${ctx.repo.owner}`);
  }));
}
