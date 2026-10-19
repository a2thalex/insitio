# GitHub parity batch 1 implementation plan

Source of truth: `docs/superpowers/specs/2026-10-18-github-parity-batch1-design.md`.
Branch: `feat/github-parity-batch-1`. Test-first. One PR.

## Schema (one new migration)

- `repos.website` (text, default `''`), `repos.forked_from_id` (nullable, on delete set null).
- `watches(user_id, repo_id, level)` with `level in ('all', 'ignore')`. Participating stores no row.
- `topics(name primary key)`, `repo_topics(repo_id, topic)`.
- `releases` (tag, target, title, body, draft, prerelease, make_latest `true|false|legacy`, author, timestamps).
- `release_assets` (release_id, display name, size, content_type, download_count). Bytes live at `DATA_DIR/releases/<repo id>/<release id>/<asset id>`.
- `repo_analyses(repo_id, commit_sha, languages_json, license_id, license_path, contributors_json)`.

## Git (`src/git/repo.ts`, `src/git/archive.ts`, `src/git/run.ts`)

- `assertCommitPath`: no `..`, no leading `/`, no empty segment, no `.git` segment, no NUL, no backslash.
- `commitChanges(branch, changes, message, author, { expected, parent })`: temp index, `hash-object` + `update-index`, `commit-tree`, `update-ref` compare-and-swap. `expected === null` means the branch must not exist. Preserve `100755`. Reject a path that is both a file and a folder (`PathConflictError`). `RefMovedError` when the CAS fails.
- `createBranch`, `deleteBranch` (CAS on the sha), `createTag` (annotated), `tagList` (name, annotated message, commit sha, commit date).
- `blame` via `git blame --line-porcelain`, grouped into hunks.
- `listFiles`, `contributors` via `git shortlog -sne`.
- `startArchive` streams `git archive` with prefix `<repo>-<ref>/` (`/` in the ref becomes `-`).

## Services

- `edits.ts`: commit message defaults (`Create` / `Update` / `Delete` / `Add files via upload`), CRLF kept only when the existing blob is consistently CRLF, author from `authorFor(user, baseUrl)`.
- `branches.ts`: create from a branch, tag or sha; refuse deleting the default branch; refuse deleting a branch that is the head of an open PR (name the number); restore recreates the branch at the sha from the redirect query.
- `releases.ts`: publish creates a missing tag at the chosen target; deleting a release keeps the tag; latest is an explicit `make_latest=true` release, otherwise the newest non-draft non-prerelease. Drafts are writer-only.
- `forks.ts`: `git clone --bare --local`, same visibility as the source, name or `name-N`.
- `watches.ts`, `topics.ts` (20 topics, `[a-z0-9-]{1,50}`), `analyze.ts` (language map, license fingerprints, cache per sha).

## HTTP

New route modules, registered beside `codeRoutes`. CSRF on every form. Streaming uploads (`/upload/…` and `/releases/:id/assets`, plus the API asset route) skip the 2 MB / 1 MB body limits and are not parsed by the CSRF middleware; the token is the `x-csrf-token` header or the `_csrf` query.

- Blame, new/edit/delete/upload, branches create/delete/restore, tags, archive, releases (pages, assets, downloads), fork, forks, watch, watchers, about, `graphs/contributors`, `/topics/:topic`.
- File view: Blame button, edit/delete for writers, line menu (permalink uses the commit sha, blame link). `app.js` highlights `#L10-L20`, click and shift-click.
- Code dropdown: Download ZIP and tar.gz.
- Header: Fork and Watch. Home sidebar: description, website, topics, license, counts, latest release, languages, contributors. Admin `<details>` editor.
- Repo search understands `topic:name`.
- API: `GET/POST /repos/:owner/:name/releases`, `GET …/releases/latest`, `POST …/releases/:id/assets?name=` (raw body).

## Tests

`tests/git.batch1.test.ts` plus `tests/web.{edit,blame,branches,tags,archive,releases,fork,watch,about}.test.ts` and API cases in `tests/api.releases.test.ts`. Private repos stay 404. A concurrent ref move keeps the submitted text and says the branch changed.
