import type { Context, Hono } from "hono";
import type { Deps } from "../../deps.js";
import { ValidationError } from "../../services/errors.js";
import { createRepo } from "../../services/repos.js";
import type { Env } from "../env.js";
import { field, form, loginRedirect } from "../middleware.js";
import { render } from "../render.js";
import { Avatar, CsrfField, Flash, Octicon } from "../views/layout.js";

type Values = { name: string; description: string; visibility: string; readme: boolean };

function NewRepoPage({ c, values, error }: { c: Context<Env>; values: Values; error?: string }) {
  const user = c.get("user")!;
  return (
    <div class="container-md p-responsive py-5" style="max-width:680px">
      <div class="Subhead">
        <h1 class="Subhead-heading">Create a new repository</h1>
        <div class="Subhead-description">A repository contains all project files, including the revision history.</div>
      </div>
      <Flash error={error} />
      <form method="post" action="/new">
        <CsrfField csrf={c.get("csrf")} />
        <div class="d-flex flex-items-end mb-3">
          <div class="form-group my-0 mr-2">
            <div class="form-group-header"><label>Owner</label></div>
            <div class="form-group-body">
              <span class="btn btn-sm disabled d-inline-flex flex-items-center" aria-disabled="true">
                <Avatar name={user.username} size={20} class="mr-1" />
                {user.username}
              </span>
            </div>
          </div>
          <span class="f2 mx-1 color-fg-muted">/</span>
          <div class="form-group my-0 flex-auto">
            <div class="form-group-header"><label for="name">Repository name</label></div>
            <div class="form-group-body">
              <input class="form-control input-block" id="name" name="name" value={values.name} required autofocus maxlength={100} />
            </div>
          </div>
        </div>
        <div class="form-group">
          <div class="form-group-header"><label for="description">Description <span class="color-fg-muted text-normal">(optional)</span></label></div>
          <div class="form-group-body"><input class="form-control input-block" id="description" name="description" value={values.description} maxlength={350} /></div>
        </div>
        <hr />
        <fieldset class="mb-3">
          <legend class="sr-only">Visibility</legend>
          <div class="form-checkbox">
            <label>
              <input type="radio" name="visibility" value="public" checked={values.visibility !== "private"} />
              <Octicon name="repo" class="mx-1" />Public
            </label>
            <p class="note">Anyone signed in to this GitFkd, and anyone with the link, can see this repository.</p>
          </div>
          <div class="form-checkbox">
            <label>
              <input type="radio" name="visibility" value="private" checked={values.visibility === "private"} />
              <Octicon name="lock" class="mx-1" />Private
            </label>
            <p class="note">Only you and collaborators you add can see this repository.</p>
          </div>
        </fieldset>
        <hr />
        <div class="form-checkbox">
          <label>
            <input type="checkbox" name="readme" value="1" checked={values.readme} />
            Add a README file
          </label>
          <p class="note">Start with a commit so you can clone right away.</p>
        </div>
        <hr />
        <button class="btn btn-primary" type="submit">Create repository</button>
      </form>
    </div>
  );
}

export function newRepoRoutes(deps: Deps, app: Hono<Env>) {
  app.get("/new", (c) => {
    if (!c.get("user")) return loginRedirect(c);
    return render(c, "New repository", <NewRepoPage c={c} values={{ name: "", description: "", visibility: "public", readme: false }} />);
  });

  app.post("/new", async (c) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const f = await form(c);
    const values: Values = {
      name: field(f, "name"),
      description: field(f, "description"),
      visibility: field(f, "visibility"),
      readme: field(f, "readme") === "1",
    };
    try {
      const repo = await createRepo(deps, user, {
        name: values.name,
        description: values.description,
        isPrivate: values.visibility === "private",
        initReadme: values.readme,
      });
      return c.redirect(`/${repo.owner}/${repo.name}`);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return render(c, "New repository", <NewRepoPage c={c} values={values} error={err.message} />, 400);
    }
  });
}
