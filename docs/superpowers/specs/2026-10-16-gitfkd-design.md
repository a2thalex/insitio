# GitFkd — design spec

Date: 2026-10-16
Status: approved design, pending spec review

## Goal

A self-hosted, invite-only code forge that works like GitHub: real git
repositories you can clone from and push to over HTTP, browsed and
collaborated on through a GitHub-style web UI. The UI and URL structure are
informed by evidence gathered with REA (Reverse Engineer Anything,
`morluto/rea`) from public github.com pages.

## Non-goals (v1)

- SSH transport (HTTP only).
- Organizations/teams, Actions/CI, webhooks, wikis, releases, forks, Git LFS.
- Line-level PR review comments (PR comments are conversation-level).
- Email delivery (invites are links an admin copies and sends).
- Copying GitHub's name, logo, Octocat or any proprietary asset. Primer CSS and
  Octicons are MIT-licensed and may be used.

## Phase 1 — REA analysis of github.com

1. Start Chrome with a dedicated profile (`--user-data-dir` in the scratchpad)
   and `--remote-debugging-port=9222`, signed out.
2. Open public pages of one public repository: repo home, tree, blob, commits
   list, single commit, issues list, issue detail, pulls list, PR
   conversation, PR files, user profile.
3. For each page run REA's `list-browser-targets`, `inspect-web-page`
   (with accessibility text), `analyze-web-bundle` and
   `capture-web-screenshot`.
4. Record findings in `docs/rea-findings.md`: per-page anatomy (landmarks,
   header, tabs, side bars), URL/route map, how page data is delivered
   (embedded JSON vs fetch endpoints), and the decisions GitFkd adopts.
   Raw REA JSON goes to `docs/rea-evidence/` (gitignored if large).

REA runs from the clone at `../rea`. If Node 25 is rejected, a portable
Node 24 from nodejs.org is used for REA only.

## Phase 2 — the application

### Stack

- Node.js + TypeScript, run with `tsx` in dev, compiled with `tsc` for prod.
- Hono on `@hono/node-server`; views are server-rendered `hono/jsx`.
- SQLite via the built-in `node:sqlite` (no native compile on Windows).
- The system `git` binary for all repository operations;
  `git-http-backend` (ships with Git for Windows) for smart HTTP.
- Primer CSS + Octicons (MIT) for styling; `marked` + `sanitize-html` for
  Markdown; `highlight.js` for server-side syntax highlighting.
- Vitest for tests.

### Layout

```
src/
  config.ts            env + paths (DATA_DIR, PORT, BASE_URL)
  db/                  schema.sql, migrations, typed query helpers
  git/                 Repo class wrapping git CLI on bare repos
  githttp/             smart-HTTP handler (git-http-backend CGI bridge)
  auth/                passwords (scrypt), sessions, CSRF, tokens, invites
  services/            repos, issues, pulls, stars, search, permissions
  web/
    routes/            one file per area (home, auth, repo, issues, pulls, user, admin, settings)
    views/             JSX components and page templates
    markdown.ts, highlight.ts
  cli/                 admin:create, invite:create
  server.ts            app composition
public/                built CSS, small JS (copy buttons, tab toggles)
data/                  (runtime, gitignored) gitfkd.db, repos/<owner>/<name>.git
tests/
```

### Data model (SQLite)

- `users(id, username UNIQUE, display_name, email, password_hash, is_admin, bio, created_at)`
- `sessions(id TEXT PK, user_id, csrf_token, expires_at)`
- `invites(token PK, created_by, used_by NULL, expires_at, created_at)`
- `access_tokens(id, user_id, name, token_hash, last_used_at, created_at)`
- `repos(id, owner_id, name, description, is_private, default_branch, created_at, UNIQUE(owner_id,name))`
- `collaborators(repo_id, user_id, role CHECK(role IN ('read','write','admin')))`
- `stars(user_id, repo_id, created_at)`
- `issues(id, repo_id, number, author_id, title, body, state('open','closed'), is_pull, created_at, updated_at, closed_at, UNIQUE(repo_id,number))`
- `pulls(issue_id PK, base_ref, head_ref, merged_at, merged_by, merge_commit)`
- `comments(id, issue_id, author_id, body, created_at)`
- `labels(id, repo_id, name, color)` / `issue_labels(issue_id, label_id)`
- `repo_counters(repo_id PK, next_number)` — issues and PRs share numbering.

### Permissions

- Owner = admin. Collaborators: read/write/admin. Site admins see everything.
- Public repo: anyone signed in or anonymous can read; write needs write role.
- Private repo: non-members get 404 (not 403), same as GitHub.
- One `permissions.ts` owns the rules; routes and git-http both call it.

### Auth (invite-only)

- No open sign-up. `/join/:token` is the only sign-up path; the token is
  single-use and expires (default 7 days).
- `npm run admin:create -- <username>` bootstraps the first admin and prints a
  generated password once. `npm run invite:create` prints an invite link.
- Admin page `/admin/invites` lists, creates and revokes invites. Setting
  `ALLOW_USER_INVITES=1` lets non-admins create invites from settings.
- Passwords: scrypt with per-user salt. Sessions: random 32-byte id in an
  HttpOnly, SameSite=Lax cookie. Every POST form carries a CSRF token.
- Git over HTTP: Basic auth with username + personal access token
  (created in `/settings/tokens`, shown once, stored hashed).

### Git layer

`Repo` (one bare repo path) exposes: `branches()`, `resolve(ref)`,
`tree(ref, path)`, `blob(ref, path)`, `log(ref, path?, page)`,
`commit(sha)` with diff, `compare(base, head)` (commits + diff),
`grep(ref, query)`, `mergeable(base, head)`, `merge(base, head, author, message)`.
All calls spawn `git` with argument arrays (never a shell), validate refs
and paths, and cap output size. Merges use `git merge-tree --write-tree`
then `git commit-tree` and `git update-ref` with the old value, so no working
tree is needed and concurrent pushes cannot be clobbered.

### Smart HTTP

`/:owner/:repo.git/info/refs`, `/git-upload-pack`, `/git-receive-pack` are
bridged to `git-http-backend` as CGI (env: `GIT_PROJECT_ROOT`,
`GIT_HTTP_EXPORT_ALL`, `PATH_INFO`, `REMOTE_USER`, `CONTENT_TYPE`, …),
streaming request and response bodies. Read needs read permission, receive-pack
needs write. Unauthenticated access to a private repo returns 401 with
`WWW-Authenticate` so git prompts for credentials. Pushing to a repo that does
not exist is rejected (repos are created in the UI).

### Web pages (URL scheme mirrors GitHub; refined by REA findings)

- `/` dashboard (signed in: your repos, starred, recent activity) or landing.
- `/login`, `/logout`, `/join/:token`, `/settings/profile`, `/settings/password`, `/settings/tokens`.
- `/new` create repo (name, description, private, init with README).
- `/:owner` profile: repos tab, stars tab.
- `/:owner/:repo` code tab: file list for default branch, README rendered, clone URL box, stars.
- `/:owner/:repo/tree/:ref/*path`, `/blob/:ref/*path` (highlighted, raw link), `/raw/:ref/*path`.
- `/:owner/:repo/tree-commit-info/:ref/*path` JSON: last commit per entry,
  fetched by the tree page after render (GitHub's split, see `docs/rea-findings.md` §2).
- `/:owner/:repo/commits/:ref`, `/commit/:sha` (diff), `/branches`.
- `/:owner/:repo/issues` (open/closed filter, label filter), `/issues/new`, `/issues/:n`.
- `/:owner/:repo/pulls`, `/compare/:base...:head` + open PR form, `/pull/:n` (conversation), `/pull/:n/commits`, `/pull/:n/files`, merge button.
- `/:owner/:repo/search?q=` code search (git grep on default branch).
- `/:owner/:repo/settings` (description, visibility, collaborators, delete with name confirmation).
- `/:owner/:repo/labels` manage labels.
- `/admin/invites`, `/admin/users`.

Refs containing `/` are resolved by longest matching branch prefix, as GitHub does.

### Error handling

- Unknown user/repo/ref/path → 404 page. Hidden private repo → 404.
- Git failures surface as a 500 page with no internal paths shown.
- Merge conflicts: PR page shows "This branch has conflicts" and disables merge.
- Large files/diffs: blobs over 1 MB show "view raw"; diffs truncate per file
  with a notice.

### Testing

- Unit: git layer against temporary repos built in the test (tree, blob, log,
  compare, grep, merge clean + conflict).
- Unit: auth (hashing, invite consumption, CSRF), permissions matrix.
- Route: Hono `app.request()` for sign-up via invite, repo create, issue and PR
  flows, private-repo 404s.
- End-to-end: start the server, `git clone`, commit, `git push` with a token,
  confirm the commit appears in the UI; push without token to private repo
  fails.
- Manual: click-through in the browser pane; screenshots compared against REA
  captures for layout parity.

## Open questions

None blocking. Product name is GitFkd.
