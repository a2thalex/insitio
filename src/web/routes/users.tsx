import type { Hono } from "hono";
import type { Deps } from "../../deps.js";
import { listReposForOwner, listStarred } from "../../services/repos.js";
import { getUserByName } from "../../services/users.js";
import type { Env } from "../env.js";
import { notFound, render } from "../render.js";
import { Avatar, DateText, Octicon } from "../views/layout.js";
import { RepoListItem } from "../views/repoList.js";

type Tab = "overview" | "repositories" | "stars";

export function userRoutes(deps: Deps, app: Hono<Env>) {
  // Registered last: a single segment that matched nothing else is a username.
  app.get("/:owner", (c) => {
    const profile = getUserByName(deps.db, c.req.param("owner"));
    if (!profile) return notFound(c, "This user");
    const viewer = c.get("user");
    const tabParam = c.req.query("tab");
    const tab: Tab = tabParam === "repositories" || tabParam === "stars" ? tabParam : "overview";
    const repos = listReposForOwner(deps.db, profile.id, viewer);
    const starred = listStarred(deps.db, profile.id, viewer);
    const base = `/${profile.username}`;
    const item = (t: Tab, href: string, icon: string, label: string, count?: number) => (
      <a class="UnderlineNav-item" href={href} aria-current={tab === t ? "page" : undefined}>
        <Octicon name={icon} class="UnderlineNav-octicon" />
        <span>{label}</span>
        {count !== undefined && <span class="Counter">{count}</span>}
      </a>
    );
    const popular = [...repos].sort((a, b) => b.stars - a.stars || b.createdAt - a.createdAt).slice(0, 6);
    return render(
      c,
      `${profile.username}${profile.displayName ? ` (${profile.displayName})` : ""}`,
      <>
        <nav class="UnderlineNav px-3 px-md-4 mt-3" aria-label="User profile">
          <div class="UnderlineNav-body" style="margin-left:auto;margin-right:auto;max-width:1280px;width:100%">
            {item("overview", base, "book", "Overview")}
            {item("repositories", `${base}?tab=repositories`, "repo", "Repositories", repos.length)}
            {item("stars", `${base}?tab=stars`, "star", "Stars", starred.length)}
          </div>
        </nav>
        <div class="container-xl p-responsive py-4 d-md-flex">
          <aside class="col-md-3 pr-md-4 mb-4" aria-label="Profile">
            <Avatar name={profile.username} size={260} class="width-full height-auto mb-3" />
            <h1 class="vcard-names">
              {profile.displayName && <span class="d-block f2 lh-condensed">{profile.displayName}</span>}
              <span class="d-block f3 text-normal color-fg-muted">{profile.username}</span>
            </h1>
            {profile.bio && <p class="mt-3">{profile.bio}</p>}
            <p class="f6 color-fg-muted mt-3">
              <Octicon name="clock" class="mr-1" />Joined <DateText ts={profile.createdAt} />
              {profile.isAdmin && <span class="Label ml-2">Site admin</span>}
            </p>
          </aside>
          <section class="flex-auto min-width-0" aria-label={tab}>
            {tab === "overview" && (
              <>
                <h2 class="f4 text-normal mb-2">Popular repositories</h2>
                {popular.length === 0 ? (
                  <p class="color-fg-muted">{profile.username} doesn't have any public repositories yet.</p>
                ) : (
                  <div class="d-flex flex-wrap" style="gap:16px">
                    {popular.map((r) => (
                      <div class="Box p-3 d-flex flex-column" style="flex:1 1 300px">
                        <div class="d-flex flex-items-center">
                          <Octicon name={r.isPrivate ? "lock" : "repo"} class="mr-2 color-fg-muted" />
                          <a class="text-bold flex-auto" href={`/${r.owner}/${r.name}`}>{r.name}</a>
                          <span class="Label Label--secondary">{r.isPrivate ? "Private" : "Public"}</span>
                        </div>
                        <p class="f6 color-fg-muted mt-2 mb-2 flex-auto">{r.description}</p>
                        <span class="f6 color-fg-muted"><Octicon name="star" class="mr-1" />{r.stars}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            {tab === "repositories" && (
              <div class="Box">
                {repos.length === 0 ? <div class="Box-row color-fg-muted">No repositories.</div> : repos.map((r) => <RepoListItem repo={r} />)}
              </div>
            )}
            {tab === "stars" && (
              <div class="Box">
                {starred.length === 0 ? <div class="Box-row color-fg-muted">No starred repositories yet.</div> : starred.map((r) => <RepoListItem repo={r} showOwner />)}
              </div>
            )}
          </section>
        </div>
      </>,
    );
  });
}
