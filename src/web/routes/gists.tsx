import type { Hono } from "hono";
import type { Deps } from "../../deps.js";
import { ValidationError } from "../../services/errors.js";
import { addGistFile, createGist, deleteGist, getGist, listVisibleGists } from "../../services/gists.js";
import type { Env } from "../env.js";
import { field, form, loginRedirect } from "../middleware.js";
import { notFound, render } from "../render.js";
import { CsrfField } from "../views/layout.js";

export function gistRoutes(deps: Deps, app: Hono<Env>) {
  app.get("/gists", (c) => {
    const user = c.get("user");
    const gists = listVisibleGists(deps.db, user?.id ?? null);
    return render(c, "Gists", (
      <div class="container-md p-responsive py-4">
        <div class="d-flex flex-items-center mb-3">
          <h1 class="f2 text-normal flex-auto">Gists</h1>
          {user && <a class="btn btn-primary" href="/gists/new">New gist</a>}
        </div>
        {gists.length === 0 ? <p class="color-fg-muted">No gists yet.</p> : (
          <div class="Box">{gists.map((gist) => (
            <a class="Box-row d-block" href={`/gists/${gist.id}`}>
              {gist.description || gist.files[0]?.name || gist.id}
              <span class="color-fg-muted ml-2">{gist.owner}{gist.secret ? " · secret" : ""}</span>
            </a>
          ))}</div>
        )}
      </div>
    ));
  });

  app.get("/gists/new", (c) => {
    if (!c.get("user")) return loginRedirect(c);
    return render(c, "New gist", gistForm(c.get("csrf")));
  });

  app.post("/gists", async (c) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const f = await form(c);
    try {
      const id = createGist(deps.db, user.id, {
        description: field(f, "description"),
        secret: field(f, "secret") === "1",
        files: [{ name: field(f, "filename"), body: field(f, "body") }],
      });
      return c.redirect(`/gists/${id}`);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return render(c, "New gist", gistForm(c.get("csrf"), err.message), 400);
    }
  });

  app.get("/gists/:id", (c) => {
    const gist = getGist(deps.db, c.req.param("id") ?? "", c.get("user")?.id ?? null);
    if (!gist) return notFound(c, "This gist");
    const owner = c.get("user")?.id === gist.ownerId;
    return render(c, gist.description || "Gist", (
      <div class="container-md p-responsive py-4">
        <h1 class="f2 text-normal">{gist.description || gist.files[0]?.name}</h1>
        <p class="color-fg-muted"><a href={`/${gist.owner}`}>{gist.owner}</a>{gist.secret ? " · secret" : ""}</p>
        {gist.files.map((file) => (
          <div class="Box mb-3">
            <div class="Box-header text-mono">{file.name}</div>
            <pre class="Box-body mb-0">{file.body}</pre>
          </div>
        ))}
        {owner && (
          <>
            <form method="post" action={`/gists/${gist.id}/files`} class="Box p-3 mb-3">
              <CsrfField csrf={c.get("csrf")} />
              <input class="form-control mb-2" name="filename" aria-label="File name" placeholder="another.txt" />
              <textarea class="form-control mb-2" name="body" aria-label="File contents" rows={6}></textarea>
              <button class="btn" type="submit">Add file</button>
            </form>
            <form method="post" action={`/gists/${gist.id}/delete`}>
              <CsrfField csrf={c.get("csrf")} />
              <button class="btn btn-danger" type="submit">Delete gist</button>
            </form>
          </>
        )}
      </div>
    ));
  });

  app.post("/gists/:id/files", async (c) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const gist = getGist(deps.db, c.req.param("id") ?? "", user.id);
    if (!gist || gist.ownerId !== user.id) return notFound(c, "This gist");
    const f = await form(c);
    addGistFile(deps.db, gist.id, user.id, field(f, "filename"), field(f, "body"));
    return c.redirect(`/gists/${gist.id}`);
  });

  app.post("/gists/:id/delete", async (c) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    await form(c);
    deleteGist(deps.db, c.req.param("id") ?? "", user.id);
    return c.redirect("/gists");
  });
}

function gistForm(csrf: string, error?: string) {
  return (
    <div class="container-sm p-responsive py-4" style="max-width:640px">
      <h1 class="f2 text-normal">New gist</h1>
      {error && <div class="flash flash-error">{error}</div>}
      <form method="post" action="/gists">
        <CsrfField csrf={csrf} />
        <input class="form-control mb-2" name="description" aria-label="Description" placeholder="Description" />
        <input class="form-control mb-2" name="filename" aria-label="File name" placeholder="notes.md" required />
        <textarea class="form-control mb-2" name="body" aria-label="File contents" rows={10} required></textarea>
        <label class="d-block mb-3"><input type="checkbox" name="secret" value="1" /> Secret gist</label>
        <button class="btn btn-primary" type="submit">Create gist</button>
      </form>
    </div>
  );
}
