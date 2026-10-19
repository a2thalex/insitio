import type { Child } from "hono/jsx";
import type { Commit, TreeEntry } from "../../git/repo.js";
import type { WatchLevel } from "../../services/watches.js";
import type { RepoCtx } from "../repoContext.js";
import { blobUrl, commitUrl, commitsUrl, encPath, repoUrl, treeUrl } from "../paths.js";
import { Avatar, CsrfField, Octicon, TimeAgo } from "./layout.js";

export type RepoTab = "code" | "issues" | "pulls" | "settings";

export function RepoLayout({ ctx, tab, csrf, signedIn, children }: { ctx: RepoCtx; tab: RepoTab; csrf: string; signedIn: boolean; children: Child }) {
  const { repo, counts } = ctx;
  const base = repoUrl(repo.owner, repo.name);
  const item = (t: RepoTab, href: string, icon: string, label: string, count?: number) => (
    <a class="UnderlineNav-item" href={href} aria-current={tab === t ? "page" : undefined}>
      <Octicon name={icon} class="UnderlineNav-octicon" />
      <span>{label}</span>
      {count !== undefined && count > 0 && <span class="Counter">{count}</span>}
    </a>
  );
  return (
    <>
      <div class="repo-header pt-3 border-bottom">
        <div class="container-xl px-3 px-md-4 d-flex flex-wrap flex-items-center mb-3">
          <div class="flex-auto mb-2 mb-md-0">
            <div class="d-flex flex-items-center repo-title">
              <Octicon name={repo.isPrivate ? "lock" : "repo"} class="color-fg-muted mr-2" />
              <nav aria-label="Breadcrumbs">
                <a href={`/${repo.owner}`}>{repo.owner}</a>
                <span class="mx-1 color-fg-muted">/</span>
                <strong>
                  <a href={base}>{repo.name}</a>
                </strong>
              </nav>
              <span class="Label Label--secondary ml-2">{repo.isPrivate ? "Private" : "Public"}</span>
            </div>
            {ctx.forkedFrom && (
              <p class="f6 color-fg-muted mt-1 mb-0">
                forked from <a href={`/${ctx.forkedFrom.owner}/${ctx.forkedFrom.name}`}>{ctx.forkedFrom.owner}/{ctx.forkedFrom.name}</a>
              </p>
            )}
          </div>
          <div class="d-flex flex-items-center" style="gap:8px">
            <WatchButton base={base} csrf={csrf} signedIn={signedIn} level={ctx.watchLevel} count={ctx.watchers} />
            <ForkButton base={base} csrf={csrf} signedIn={signedIn} count={ctx.forks} />
            <form method="post" action={`${base}/${ctx.starred ? "unstar" : "star"}`} class="d-flex">
              <CsrfField csrf={csrf} />
              <button class="btn btn-sm" type="submit" disabled={!signedIn} title={signedIn ? undefined : "Sign in to star"} aria-label={ctx.starred ? "Unstar this repository" : "Star this repository"}>
                <Octicon name={ctx.starred ? "star-fill" : "star"} class={ctx.starred ? "color-fg-attention mr-1" : "mr-1"} />
                {ctx.starred ? "Starred" : "Star"}
                <span class="Counter ml-1">{repo.stars}</span>
              </button>
            </form>
          </div>
        </div>
        <nav class="UnderlineNav px-3 px-md-4" aria-label="Repository">
          <div class="UnderlineNav-body">
            {item("code", base, "code", "Code")}
            {item("issues", `${base}/issues`, "issue-opened", "Issues", counts.issues)}
            {item("pulls", `${base}/pulls`, "git-pull-request", "Pull requests", counts.pulls)}
            {ctx.access === "admin" && item("settings", `${base}/settings`, "gear", "Settings")}
          </div>
        </nav>
      </div>
      <div class="container-xl p-responsive py-4">{children}</div>
    </>
  );
}

/** Branch and tag switcher; hrefFor maps a ref name to the same view on that ref. */
export function RefPicker({ current, branches, tags, hrefFor }: { current: string; branches: string[]; tags: string[]; hrefFor: (ref: string) => string }) {
  const shortCurrent = /^[0-9a-f]{40}$/.test(current) ? current.slice(0, 7) : current;
  const entry = (name: string, icon: string) => (
    <a class="SelectMenu-item" href={hrefFor(name)} data-ref-name={name} aria-checked={name === current ? "true" : "false"} role="menuitemradio">
      <Octicon name="check" class="SelectMenu-icon SelectMenu-icon--check" />
      <Octicon name={icon} class="mr-2 color-fg-muted" />
      <span class="css-truncate css-truncate-target" style="max-width:220px">{name}</span>
    </a>
  );
  return (
    <details class="details-reset details-overlay d-inline-block">
      <summary class="btn btn-sm btn-plain-case css-truncate" aria-label={`Switch branches or tags, current ${shortCurrent}`}>
        <Octicon name="git-branch" class="mr-1" />
        <span class="css-truncate-target text-bold" style="max-width:160px">{shortCurrent}</span>
        <span class="dropdown-caret ml-1"></span>
      </summary>
      <div class="SelectMenu">
        <div class="SelectMenu-modal ref-menu">
          <header class="SelectMenu-header">
            <span class="SelectMenu-title">Switch branches/tags</span>
          </header>
          <div class="SelectMenu-filter">
            <input class="SelectMenu-input form-control" type="text" placeholder="Find a branch or tag…" aria-label="Filter branches and tags" data-ref-filter />
          </div>
          <div class="SelectMenu-list" role="menu">
            {branches.map((b) => entry(b, "git-branch"))}
            {tags.length > 0 && <div class="SelectMenu-divider">Tags</div>}
            {tags.map((t) => entry(t, "tag"))}
          </div>
        </div>
      </div>
    </details>
  );
}

export function CloneButton({ url, zipHref, tarHref }: { url: string; zipHref?: string; tarHref?: string }) {
  return (
    <details class="details-reset details-overlay d-inline-block position-relative">
      <summary class="btn btn-sm btn-primary">
        <Octicon name="code" class="mr-1" />
        Code
        <span class="dropdown-caret ml-1"></span>
      </summary>
      <div class="dropdown-menu dropdown-menu-sw p-3 clone-box" style="top:34px">
        <h3 class="f5 mb-2"><Octicon name="terminal" class="mr-1" />Clone with HTTPS</h3>
        <div class="input-group">
          <input class="form-control input-sm text-mono" id="clone-url" value={url} readonly aria-label="Clone URL" />
          <span class="input-group-button">
            <button class="btn btn-sm" type="button" data-copy-target="clone-url" aria-label="Copy clone URL"><Octicon name="copy" /></button>
          </span>
        </div>
        <p class="note mt-2">Use a personal access token as the password.</p>
        {(zipHref || tarHref) && (
          <div class="d-flex flex-column mt-3" style="gap:6px">
            {zipHref && <a href={zipHref}><Octicon name="file-zip" class="mr-1" />Download ZIP</a>}
            {tarHref && <a href={tarHref}><Octicon name="file-zip" class="mr-1" />Download TAR</a>}
          </div>
        )}
      </div>
    </details>
  );
}

const WATCH_LABEL: Record<WatchLevel, string> = {
  participating: "Participating",
  all: "All activity",
  ignore: "Ignore",
};

function WatchButton({ base, csrf, signedIn, level, count }: { base: string; csrf: string; signedIn: boolean; level: WatchLevel; count: number }) {
  return (
    <details class="details-reset details-overlay d-inline-block position-relative">
      <summary class="btn btn-sm" aria-label={`Watch, ${WATCH_LABEL[level]}`}>
        <Octicon name="eye" class="mr-1" />
        {WATCH_LABEL[level] === "Participating" ? "Watch" : WATCH_LABEL[level]}
        <span class="Counter ml-1">{count}</span>
        <span class="dropdown-caret ml-1"></span>
      </summary>
      <div class="dropdown-menu dropdown-menu-sw p-3" style="top:34px; width:280px">
        {signedIn ? (
          <form method="post" action={`${base}/watch`}>
            <CsrfField csrf={csrf} />
            <p class="f6 color-fg-muted mb-2">Notifications for this repository. Participating is the default and is not stored.</p>
            {(["participating", "all", "ignore"] as const).map((value) => (
              <button class={`btn btn-sm btn-block mb-2 ${level === value ? "btn-primary" : ""}`} type="submit" name="level" value={value}>
                {WATCH_LABEL[value]}
              </button>
            ))}
            <a class="f6" href={`${base}/watchers`}>Watchers</a>
          </form>
        ) : (
          <p class="f6 mb-0"><a href={`/login?next=${encodeURIComponent(base)}`}>Sign in</a> to watch this repository.</p>
        )}
      </div>
    </details>
  );
}

function ForkButton({ base, csrf, signedIn, count }: { base: string; csrf: string; signedIn: boolean; count: number }) {
  if (!signedIn) {
    return (
      <a class="btn btn-sm" href={`/login?next=${encodeURIComponent(base)}`}>
        <Octicon name="repo-forked" class="mr-1" />Fork <span class="Counter ml-1">{count}</span>
      </a>
    );
  }
  return (
    <form method="post" action={`${base}/fork`}>
      <CsrfField csrf={csrf} />
      <button class="btn btn-sm" type="submit">
        <Octicon name="repo-forked" class="mr-1" />Fork <span class="Counter ml-1">{count}</span>
      </button>
    </form>
  );
}

export function CommitAuthor({ ctx, commit, size = 20 }: { ctx: RepoCtx; commit: Commit; size?: number }) {
  const username = ctx.userForEmail(commit.authorEmail);
  return (
    <span class="d-inline-flex flex-items-center">
      <Avatar name={username ?? commit.authorName} size={size} class="mr-2" />
      {username ? (
        <a class="text-bold Link--primary" href={`/${username}`}>{username}</a>
      ) : (
        <span class="text-bold" title={commit.authorEmail}>{commit.authorName}</span>
      )}
    </span>
  );
}

/** The "latest commit" bar above a listing or file (rea-findings §3). */
export function LatestCommitBar({ ctx, commit, historyHref, count }: { ctx: RepoCtx; commit: Commit; historyHref: string; count?: number }) {
  const { owner, name } = ctx.repo;
  return (
    <div class="Box-header latest-commit d-flex flex-items-center flex-wrap py-2">
      <CommitAuthor ctx={ctx} commit={commit} />
      <a class="Link--secondary ml-2 flex-auto css-truncate css-truncate-target" style="max-width:none" href={commitUrl(owner, name, commit.sha)} title={commit.subject}>
        {commit.subject}
      </a>
      <span class="f6 color-fg-muted ml-3 no-wrap">
        <a class="Link--secondary text-mono" href={commitUrl(owner, name, commit.sha)}>{commit.shortSha}</a>
        {" · "}
        <TimeAgo ts={commit.date} />
      </span>
      <a class="Link--primary ml-3 f6 text-bold no-wrap" href={historyHref}>
        <Octicon name="history" class="mr-1" />
        {count !== undefined ? `${count.toLocaleString("en-US")} Commit${count === 1 ? "" : "s"}` : "History"}
      </a>
    </div>
  );
}

export function PathBreadcrumbs({ ctx, gitRef, path, last = "link" }: { ctx: RepoCtx; gitRef: string; path: string; last?: "link" | "text" }) {
  const { owner, name } = ctx.repo;
  const parts = path ? path.split("/") : [];
  return (
    <nav aria-label="Breadcrumbs" class="f4 d-flex flex-items-center flex-wrap">
      <a class="text-bold" href={treeUrl(owner, name, gitRef)}>{name}</a>
      {parts.map((p, i) => {
        const sub = parts.slice(0, i + 1).join("/");
        const isLast = i === parts.length - 1;
        return (
          <>
            <span class="mx-1 color-fg-muted">/</span>
            {isLast && last === "text" ? <strong>{p}</strong> : <a href={treeUrl(owner, name, gitRef, sub)}>{p}</a>}
          </>
        );
      })}
      {path && (
        <button class="btn-octicon ml-1" type="button" data-copy-text={path} aria-label="Copy path">
          <Octicon name="copy" />
        </button>
      )}
    </nav>
  );
}

/** Folders and files table; last-commit columns fill in from /tree-commit-info (rea-findings §2). */
export function FileTable({ ctx, gitRef, path, entries }: { ctx: RepoCtx; gitRef: string; path: string; entries: TreeEntry[] }) {
  const { owner, name } = ctx.repo;
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const infoUrl = repoUrl(owner, name, "tree-commit-info", encPath(gitRef), path && encPath(path));
  return (
    <table class="file-table" aria-label="Folders and files" data-tree-commit-info={infoUrl}>
      <thead class="sr-only">
        <tr><th>Name</th><th>Last commit message</th><th>Last commit date</th></tr>
      </thead>
      <tbody>
        {path && (
          <tr>
            <td class="col-name" colspan={3}>
              <a class="Link--primary" href={treeUrl(owner, name, gitRef, parent)} aria-label="Parent directory">
                <Octicon name="file-directory-fill" class="mr-2" />..
              </a>
            </td>
          </tr>
        )}
        {entries.map((e) => {
          const icon = e.type === "tree" ? "file-directory-fill" : e.type === "commit" ? "file-submodule" : "file";
          const href = e.type === "blob" ? blobUrl(owner, name, gitRef, e.path) : treeUrl(owner, name, gitRef, e.path);
          return (
            <tr data-entry={e.name}>
              <td class="col-name">
                <Octicon name={icon} class="mr-2" />
                {e.type === "commit" ? (
                  <span title="Submodule">{e.name}</span>
                ) : (
                  <a class="Link--primary" href={href} title={e.name}>
                    {e.name}
                    <span class="sr-only">{e.type === "tree" ? ", (Directory)" : ", (File)"}</span>
                  </a>
                )}
              </td>
              <td class="col-msg"><span class="color-fg-subtle">…</span></td>
              <td class="col-age"></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function commitHistoryHref(ctx: RepoCtx, gitRef: string, path = "") {
  return commitsUrl(ctx.repo.owner, ctx.repo.name, gitRef, path);
}
