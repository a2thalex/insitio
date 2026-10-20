import type { Context, Hono } from "hono";
import type { Deps } from "../../deps.js";
import { ValidationError } from "../../services/errors.js";
import { createEnvironment, listEnvironments, recordDeployment } from "../../services/parity.js";
import { listRequiredChecks, setRequiredChecks } from "../../services/pullExtras.js";
import {
  addWebhook, createDeployKey, deleteBranchRule, deleteDeployKey, deleteWebhook, listBranchRules, listDeliveries, listDeployKeys, listWebhooks,
  renameRepo, saveBranchRule, setArchived, setFeatures, setMergeMethods, transferRepo,
} from "../../services/repoAdmin.js";
import {
  addCollaborator, deleteRepo, listCollaborators, removeCollaborator, setDefaultBranch, updateRepo, type Collaborator,
} from "../../services/repos.js";
import { getUserByName } from "../../services/users.js";
import type { Env } from "../env.js";
import { field, fields, form } from "../middleware.js";
import { repoUrl } from "../paths.js";
import type { RepoCtx } from "../repoContext.js";
import { Avatar, CsrfField, Flash, Octicon } from "../views/layout.js";
import { repoPage, withRepo } from "./code.js";

const ROLES: Collaborator["role"][] = ["read", "write", "admin"];

export function repoSettingsRoutes(deps: Deps, app: Hono<Env>) {
  const R = "/:owner/:repo";

  const page = async (c: Context<Env>, ctx: RepoCtx, opts: { error?: string; notice?: string; deployKey?: string } = {}) => {
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

        <div class="Subhead"><h2 class="Subhead-heading">Environments</h2></div>
        <form method="post" action={`${base}/environments`} class="mb-3 d-flex flex-wrap" style="gap:8px">
          <CsrfField csrf={csrf} />
          <input class="form-control" name="name" aria-label="Environment name" placeholder="production" required />
          <input class="form-control" name="url" aria-label="Environment URL" placeholder="https://example.com" />
          <button class="btn" type="submit">Add environment</button>
        </form>
        <div class="Box mb-3">
          {listEnvironments(deps.db, ctx.repo.id).map((env) => <div class="Box-row">{env.name}{env.url ? <span class="color-fg-muted ml-2">{env.url}</span> : null}</div>)}
        </div>
        <form method="post" action={repoUrl(owner, name, "deployments")} class="mb-6 d-flex flex-wrap" style="gap:8px">
          <CsrfField csrf={csrf} />
          <input class="form-control" name="environment" aria-label="Environment" placeholder="production" required />
          <input class="form-control" name="sha" aria-label="Commit" placeholder="Commit" required />
          <input class="form-control" name="description" aria-label="Description" placeholder="What shipped" />
          <button class="btn" type="submit">Record deployment</button>
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

        <div class="Subhead"><h2 class="Subhead-heading">Required checks</h2></div>
        <p class="f6 color-fg-muted">One context per line, up to 10. A pull request cannot merge until each one is success on its head commit.</p>
        <p class="mb-6"><a href={`${base}/checks`}>Edit required checks</a></p>

        <div class="Subhead"><h2 class="Subhead-heading">Features and merge buttons</h2></div>
        <form method="post" action={`${base}/features`} class="mb-6">
          <CsrfField csrf={csrf} />
          <label class="d-block mb-1"><input type="checkbox" name="issues" value="1" checked={ctx.repo.issuesEnabled} class="mr-1" />Issues</label>
          <label class="d-block mb-2"><input type="checkbox" name="pulls" value="1" checked={ctx.repo.pullsEnabled} class="mr-1" />Pull requests</label>
          <label class="d-block mb-1"><input type="checkbox" name="merge" value="1" checked={ctx.repo.allowMerge} class="mr-1" />Merge commit</label>
          <label class="d-block mb-1"><input type="checkbox" name="squash" value="1" checked={ctx.repo.allowSquash} class="mr-1" />Squash</label>
          <label class="d-block mb-2"><input type="checkbox" name="rebase" value="1" checked={ctx.repo.allowRebase} class="mr-1" />Rebase</label>
          <button class="btn" type="submit">Save features</button>
        </form>

        <div class="Subhead"><h2 class="Subhead-heading">Branch protection</h2></div>
        <form method="post" action={`${base}/protection`} class="mb-3 d-flex flex-wrap" style="gap:8px">
          <CsrfField csrf={csrf} />
          <input class="form-control" name="branch" placeholder="Branch" aria-label="Branch" required />
          <label class="d-flex flex-items-center"><input type="checkbox" name="require_pr" value="1" class="mr-1" />Require a pull request</label>
          <label class="d-flex flex-items-center"><input type="checkbox" name="block_force" value="1" checked class="mr-1" />Block force-push</label>
          <label class="d-flex flex-items-center"><input type="checkbox" name="block_delete" value="1" checked class="mr-1" />Block deletion</label>
          <input class="form-control" name="approvals" type="number" min="0" max="6" value="0" aria-label="Approving reviews" style="width:80px" />
          <button class="btn" type="submit">Save rule</button>
        </form>
        <div class="Box mb-6">
          {listBranchRules(deps.db, ctx.repo.id).map((rule) => (
            <div class="Box-row d-flex flex-items-center">
              <span class="flex-auto">{rule.branch}{rule.requirePr ? " · pull request required" : ""} · {rule.approvals} approvals{rule.blockForce ? " · no force-push" : ""}{rule.blockDelete ? " · no delete" : ""}</span>
              <form method="post" action={`${base}/protection/delete`}>
                <CsrfField csrf={csrf} />
                <input type="hidden" name="branch" value={rule.branch} />
                <button class="btn btn-sm" type="submit">Remove</button>
              </form>
            </div>
          ))}
        </div>

        <div class="Subhead"><h2 class="Subhead-heading">Webhooks</h2></div>
        <form method="post" action={`${base}/hooks`} class="mb-3">
          <CsrfField csrf={csrf} />
          <input class="form-control mb-2" name="url" placeholder="https://example.com/hook" aria-label="Payload URL" required />
          <input class="form-control mb-2" name="secret" placeholder="Secret (optional)" aria-label="Secret" />
          <label class="mr-3"><input type="checkbox" name="events" value="push" class="mr-1" />push</label>
          <label class="mr-3"><input type="checkbox" name="events" value="issues" class="mr-1" />issues</label>
          <label class="mr-3"><input type="checkbox" name="events" value="pull_request" class="mr-1" />pull_request</label>
          <button class="btn mt-2" type="submit">Add webhook</button>
        </form>
        <div class="Box mb-6">
          {listWebhooks(deps.db, ctx.repo.id).map((hook) => (
            <div class="Box-row">
              <div class="d-flex flex-items-center">
                <span class="flex-auto text-mono f6">{hook.url}</span>
                <form method="post" action={`${base}/hooks/${hook.id}/delete`}>
                  <CsrfField csrf={csrf} />
                  <button class="btn btn-sm" type="submit">Delete</button>
                </form>
              </div>
              <div class="f6 color-fg-muted">{hook.events.join(", ")}{listDeliveries(deps.db, hook.id)[0] ? ` · last HTTP ${listDeliveries(deps.db, hook.id)[0].responseStatus ?? "no response"}` : ""}</div>
            </div>
          ))}
        </div>

        <div class="Subhead"><h2 class="Subhead-heading">Deploy keys</h2></div>
        {opts.deployKey && <div class="flash flash-success">Copy this key now. It will not be shown again. <code>{opts.deployKey}</code></div>}
        <form method="post" action={`${base}/keys`} class="d-flex flex-wrap mb-3" style="gap:8px">
          <CsrfField csrf={csrf} />
          <input class="form-control flex-auto" name="title" placeholder="Title" aria-label="Title" required />
          <label class="d-flex flex-items-center"><input type="checkbox" name="write" value="1" class="mr-1" />Write</label>
          <button class="btn" type="submit">Add deploy key</button>
        </form>
        <div class="Box mb-6">
          {listDeployKeys(deps.db, ctx.repo.id).map((key) => (
            <div class="Box-row d-flex flex-items-center">
              <span class="flex-auto">{key.title} · {key.canWrite ? "write" : "read"}</span>
              <form method="post" action={`${base}/keys/${key.id}/delete`}>
                <CsrfField csrf={csrf} />
                <button class="btn btn-sm" type="submit">Delete</button>
              </form>
            </div>
          ))}
        </div>

        <div class="Subhead"><h2 class="Subhead-heading color-fg-danger">Danger zone</h2></div>
        <div class="Box Box--danger p-3 mb-3">
          <h3 class="f5">{ctx.repo.archived ? "Unarchive this repository" : "Archive this repository"}</h3>
          <form method="post" action={`${base}/archive`}>
            <CsrfField csrf={csrf} />
            <button class="btn" type="submit">{ctx.repo.archived ? "Unarchive" : "Archive"}</button>
          </form>
        </div>
        <div class="Box Box--danger p-3 mb-3">
          <h3 class="f5">Rename this repository</h3>
          <form method="post" action={`${base}/rename`} class="d-flex flex-wrap" style="gap:8px">
            <CsrfField csrf={csrf} />
            <input class="form-control flex-auto" name="name" aria-label="New name" required />
            <button class="btn" type="submit">Rename</button>
          </form>
        </div>
        <div class="Box Box--danger p-3 mb-3">
          <h3 class="f5">Transfer ownership</h3>
          <p class="f6 color-fg-muted">Type <strong>newowner/{name}</strong>.</p>
          <form method="post" action={`${base}/transfer`} class="d-flex flex-wrap" style="gap:8px">
            <CsrfField csrf={csrf} />
            <input class="form-control flex-auto" name="target" aria-label="New owner and name" placeholder="newowner/name" required />
            <button class="btn" type="submit">Transfer</button>
          </form>
        </div>
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

  app.get(`${R}/settings/checks`, withRepo(deps, "write", (c, ctx) => {
    const contexts = listRequiredChecks(deps.db, ctx.repo.id).join("\n");
    return repoPage(
      c,
      ctx,
      "settings",
      `Required checks · ${ctx.repo.owner}/${ctx.repo.name}`,
      <form method="post" action={repoUrl(ctx.repo.owner, ctx.repo.name, "settings", "checks")} class="Box p-3" style="max-width:760px">
        <CsrfField csrf={c.get("csrf")} />
        <h1 class="f3 text-normal">Required checks</h1>
        <p class="f6 color-fg-muted">One context per line, up to 10.</p>
        <textarea class="form-control mb-2" name="contexts" rows={6} aria-label="Required checks">{contexts}</textarea>
        <button class="btn btn-primary" type="submit">Save checks</button>
      </form>,
    );
  }));

  app.post(`${R}/settings/checks`, withRepo(deps, "write", async (c, ctx) => {
    setRequiredChecks(deps.db, ctx.repo.id, field(await form(c), "contexts").split(/\r?\n/));
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "settings", "checks"));
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

  app.post(`${R}/settings/features`, withRepo(deps, "admin", async (c, ctx) => {
    const f = await form(c);
    setFeatures(deps.db, ctx.repo.id, { issues: field(f, "issues") === "1", pulls: field(f, "pulls") === "1" });
    setMergeMethods(deps.db, ctx.repo.id, { merge: field(f, "merge") === "1", squash: field(f, "squash") === "1", rebase: field(f, "rebase") === "1" });
    return c.redirect(`${repoUrl(ctx.repo.owner, ctx.repo.name, "settings")}?saved=1`);
  }));

  app.post(`${R}/settings/protection`, withRepo(deps, "admin", async (c, ctx) => {
    const f = await form(c);
    saveBranchRule(deps.db, ctx.repo.id, {
      branch: field(f, "branch"),
      requirePr: field(f, "require_pr") === "1",
      approvals: Number(field(f, "approvals") || "0"),
      blockForce: field(f, "block_force") === "1",
      blockDelete: field(f, "block_delete") === "1",
    });
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "settings"));
  }));

  app.post(`${R}/settings/environments`, withRepo(deps, "admin", async (c, ctx) => {
    const f = await form(c);
    createEnvironment(deps.db, ctx.repo.id, field(f, "name"), field(f, "url"));
    return c.redirect(`${repoUrl(ctx.repo.owner, ctx.repo.name, "settings")}?saved=1`);
  }));

  app.post(`${R}/deployments`, withRepo(deps, "write", async (c, ctx) => {
    const f = await form(c);
    const sha = field(f, "sha").trim();
    const found = await ctx.git.resolve(sha).catch(() => null);
    if (!found) throw new ValidationError("That commit does not exist in this repository.");
    recordDeployment(deps.db, ctx.repo.id, field(f, "environment"), found, field(f, "description"));
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "deployments"));
  }));

  app.get(`${R}/deployments`, withRepo(deps, "read", async (c, ctx) => {
    const { listDeployments } = await import("../../services/parity.js");
    const rows = listDeployments(deps.db, ctx.repo.id);
    return repoPage(c, ctx, "code", "Deployments", (
      <div>
        <h1 class="f2 text-normal">Deployments</h1>
        {rows.length === 0 ? <p class="color-fg-muted">No deployments yet.</p> : rows.map((row) => (
          <div class="Box-row">{row.environment} <span class="text-mono">{row.sha.slice(0, 7)}</span> {row.description}</div>
        ))}
      </div>
    ));
  }));

  app.post(`${R}/settings/protection/delete`, withRepo(deps, "admin", async (c, ctx) => {
    deleteBranchRule(deps.db, ctx.repo.id, field(await form(c), "branch"));
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "settings"));
  }));

  app.post(`${R}/settings/hooks`, withRepo(deps, "admin", async (c, ctx) => {
    const f = await form(c);
    addWebhook(deps.db, ctx.repo.id, { url: field(f, "url"), secret: field(f, "secret"), events: fields(f, "events") }, deps.config.webhookAllowLoopback);
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "settings"));
  }));

  app.post(`${R}/settings/hooks/:id/delete`, withRepo(deps, "admin", async (c, ctx) => {
    deleteWebhook(deps.db, ctx.repo.id, Number(c.req.param("id")));
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "settings"));
  }));

  app.post(`${R}/settings/keys`, withRepo(deps, "admin", async (c, ctx) => {
    const f = await form(c);
    const token = createDeployKey(deps.db, ctx.repo.id, field(f, "title"), field(f, "write") === "1");
    return page(c, ctx, { deployKey: token });
  }));

  app.post(`${R}/settings/keys/:id/delete`, withRepo(deps, "admin", async (c, ctx) => {
    deleteDeployKey(deps.db, ctx.repo.id, Number(c.req.param("id")));
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "settings"));
  }));

  app.post(`${R}/settings/archive`, withRepo(deps, "admin", async (c, ctx) => {
    await form(c);
    setArchived(deps.db, ctx.repo.id, !ctx.repo.archived);
    return c.redirect(repoUrl(ctx.repo.owner, ctx.repo.name, "settings"));
  }));

  app.post(`${R}/settings/rename`, withRepo(deps, "admin", async (c, ctx) => {
    const renamed = await renameRepo(deps, ctx.repo, field(await form(c), "name"));
    return c.redirect(repoUrl(renamed.owner, renamed.name, "settings"));
  }));

  app.post(`${R}/settings/transfer`, withRepo(deps, "admin", async (c, ctx) => {
    const target = field(await form(c), "target").trim();
    const slash = target.indexOf("/");
    if (slash < 1 || slash === target.length - 1) throw new ValidationError("Type the new owner and repository name as owner/name.");
    const moved = await transferRepo(deps, ctx.repo, target.slice(0, slash), target.slice(slash + 1));
    return c.redirect(repoUrl(moved.owner, moved.name, "settings"));
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
