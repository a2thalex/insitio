# GitHub parity, batch 1: the Code tab

Status: design by the builder (the user asked for all of GitHub's remaining features without a
question round, so every decision below is the builder's call unless marked otherwise).

## Intent

Insitio (git.iam.bot) should feel like GitHub to people who live in it every day. Batch 1 closes the
Code-tab gaps listed in `docs/github-feature-map.md`, so that a repository page, its files, branches,
tags and releases work the way a GitHub user expects. Later batches (issues, pull requests, settings,
account, site-wide, platform features) build on what this batch adds.

## Goals

1. **Blame** — `/:owner/:repo/blame/:ref/*path`: each line with its commit (short sha, author,
   relative date, message) grouped into hunks like GitHub; link to the commit; "Blame" button on the
   file view. Text files only; binary and very large files (over 1 MB) show "Can't show blame".
2. **Edit files in the browser** (write access required):
   - Create a file (`/:owner/:repo/new/:ref/*dir`), edit a file (`/edit/:ref/*path`), delete a file
     (`/delete/:ref/*path`), upload files (`/upload/:ref/*dir`, multiple files, keeps relative
     folder paths when a folder is dropped).
   - Every change is one commit: message (default like GitHub's "Update README.md"), optional
     extended description, and the choice "Commit directly to `<branch>`" or "Create a new branch
     for this commit" (then redirect to the compare page so a PR can be opened).
   - Commits are made on the bare repository with git plumbing and a temporary index
     (`GIT_INDEX_FILE`), never a working tree. The branch update is compare-and-swap
     (`git update-ref <ref> <new> <old>`): if someone pushed meanwhile, the user sees "This branch
     changed while you were editing" and their text is kept in the form.
   - Author and committer: the signed-in user's display name (or username) and email; if the user
     has no email, `<username>@users.noreply.<host>`.
   - Upload limit: 25 MB per file, 100 files, 100 MB per upload (GitHub's web limits); bigger files
     get "use git or nsit to push it".
   - Path rules: no `..`, no leading `/`, no `.git` segment, no empty segments, no NUL; same rules as
     git itself (`git check-ref-format`-style checks are not needed for paths, but the tree must be
     valid: a path can't be both a file and a folder).
   - Line endings: the editor's text is committed as typed, except that if the existing file used
     CRLF consistently, CRLF is kept.
3. **Branches in the UI** — on `/:owner/:repo/branches`: "New branch" (name + source branch/tag/sha)
   and delete (trash icon) for every branch except the default branch. Write access required.
   Deleting a branch with an open PR is refused with a message naming the PR. A deleted branch shows
   a "Restore" button on that page until the page is left (GitHub-style), implemented by remembering
   the sha in the response.
4. **Tags page** — `/:owner/:repo/tags`: tag name, commit date, short sha, zip/tar.gz links, and the
   release name if a release uses that tag. Annotated tags show their message. Pagination by 30.
5. **Releases** — `/:owner/:repo/releases`, `/releases/tag/:tag`, `/releases/new`,
   `/releases/edit/:tag`, `/releases/latest` (redirect to the latest non-draft, non-prerelease):
   - Fields: tag (existing, or new tag created at a chosen branch/sha on publish), title, Markdown
     notes, draft, prerelease, "set as latest" (default: newest by publish date).
   - Assets: upload files to a release (2 GB per file, the server's push limit; streamed to disk, not
     buffered), list with size and download count, delete. Stored under
     `DATA_DIR/releases/<repo id>/<release id>/<asset id>`, never under a user-controlled name.
   - Downloads: `/:owner/:repo/releases/download/:tag/:asset` and
     `/:owner/:repo/releases/latest/download/:asset` (same URL shapes as GitHub, so `nsit`'s release
     URL format works against Insitio too). Private repos: assets follow repo read access (404
     otherwise). Download count increments per request. `content-disposition: attachment`.
   - Auto-generated source code links (zip, tar.gz) on every release.
   - Deleting a release keeps its tag (as GitHub does). Draft releases are visible only to writers.
   - API: `GET /api/v1/repos/:owner/:name/releases`, `GET .../releases/latest`,
     `POST .../releases`, `POST .../releases/:id/assets?name=` (raw body upload) for scripts and
     `nsit` later.
6. **Download ZIP / tarball** — `/:owner/:repo/archive/refs/heads/:branch.zip`, `.../refs/tags/:tag.zip`,
   `/:owner/:repo/archive/:sha.zip` and the same with `.tar.gz`; produced by `git archive` streamed to
   the response with prefix `<repo>-<ref>/`. "Download ZIP" in the Code button dropdown.
7. **Fork** — "Fork" button with count; `/:owner/:repo/fork` creates `<you>/<name>` (or a new name if
   taken) as a bare clone (`git clone --bare --local`, hardlinked objects) with all branches and tags;
   `repos.forked_from_id`; "forked from owner/name" under the title; `/:owner/:repo/forks` lists forks
   the viewer can see. A private repo can only be forked by someone with read access, and the fork is
   private. Cross-fork pull requests are batch 3.
8. **Watch** — "Watch" button with count and levels: Participating (default, nothing stored),
   All activity, Ignore. Stored in `watches(user_id, repo_id, level)`. `/:owner/:repo/watchers`.
   Batch 6 (notifications) consumes this table.
9. **About sidebar** on the repo home: description, website URL, topics, license, stars / watchers /
   forks counts, latest release, languages, contributors.
   - **Topics**: up to 20 per repo, lowercase letters, digits and hyphens, max 50 chars; edited by
     admins in an "About" edit dialog (also description and website); `/topics/:topic` lists public
     (and visible) repos with that topic; repo search supports `topic:x`.
   - **Language bar**: bytes per language for the default branch's tree, from file extensions and a
     few well-known filenames, ignoring vendored/generated paths (`node_modules/`, `vendor/`,
     `dist/`, `build/`, `*.min.js`, `*.lock`, files over 1 MB) and non-programming files (images,
     data, docs other than Markdown are excluded like GitHub's linguist "prose/data" types). Colors
     from linguist's palette for the ~40 most common languages. Cached per (repo, commit sha) in the
     DB; computed on first view after a push.
   - **License**: detect `LICENSE`, `LICENSE.md`, `LICENSE.txt`, `COPYING` at the root and match
     against fingerprints for MIT, Apache-2.0, GPL-2.0, GPL-3.0, LGPL-2.1, LGPL-3.0, AGPL-3.0,
     BSD-2-Clause, BSD-3-Clause, MPL-2.0, ISC, Unlicense, CC0-1.0; otherwise "View license".
     Cached with the language result.
   - **Contributors**: `git shortlog -sne` on the default branch, mapped to Insitio users by email
     (any verified/primary email the user has — today the single `email` field), top 14 avatars in the
     sidebar, `/:owner/:repo/graphs/contributors` with the full list (commit counts). Cached per sha.
10. **Line-range permalinks** — `#L10-L20` highlights a range; click a line number to select it,
    shift-click to extend; a "…" line menu with "Copy permalink" (URL with the commit sha instead of
    the branch name) and "View git blame". Works on file and blame views.

## Non-goals (this batch)

- Pull requests from forks, "sync fork" (batch 3).
- Notifications for watched repos (batch 6).
- Branch protection (batch 4); deleting the default branch is simply refused.
- Online editor beyond a plain monospace textarea with tab handling and line numbers (no
  Monaco/CodeMirror bundle).
- Git LFS, signed commits/verification badges.

## Anti-goals

- A web edit must never silently overwrite a concurrent push (compare-and-swap, see goal 2).
- A user-supplied file or asset name must never become a filesystem path on the server.
- Private repository content (blame, archives, assets, forks, contributors) must never leak to
  someone without read access: everything goes through the existing `repoContext`/`accessLevel`
  checks and hidden repos stay 404.
- No page may run git over the whole history on every request: languages, license and contributors
  are cached per commit sha.

## Constraints

- Existing stack only: Hono server-rendered JSX, `node:sqlite` with the append-only migrations array
  in `src/db/schema.ts`, the git CLI over bare repos (`src/git/*`), Primer CSS 21 with the Insitio
  theme (`public/theme.css`), Octicons, Vitest. No new runtime dependency unless unavoidable;
  `git archive` covers zip/tar.gz.
- Follow existing patterns: routes in `src/web/routes/*.tsx`, views in `src/web/views/*.tsx`,
  services in `src/services/*.ts`, git access in `src/git/*.ts`, CSRF on every form, `ValidationError`
  / `NotFoundError` / `ForbiddenError`.
- Body limits: the global 2 MB form limit stays; upload routes (file upload, release assets) get
  their own streaming handling with the limits above, mounted before the global limit or exempted
  from it.
- Deployed by `deploy/deploy.sh`; the server runs as the `gitfkd` user with data in
  `/var/lib/gitfkd` (release assets go under that `DATA_DIR`).
- Must look right in the Insitio dark theme (vanderbot.com style); match GitHub's layout and wording.

## Left to the builder

File layout within the existing patterns, exact SQL, extension-to-language map contents, caching
strategy details, pagination sizes not stated above, and test structure.
