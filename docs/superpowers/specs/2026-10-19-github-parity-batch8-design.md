# GitHub parity, batch 8: sub-issues, suggestions, gists

Status: design by the builder. The seven planned batches are deployed. This batch closes three
gaps that were still in scope.

## Intent

An issue can list the issues that belong under it. A pull-request suggestion can be applied as
a commit on the head branch when the line has not moved. A person can keep a small snippet as
a gist. A secret gist is hidden the same way a private repository is hidden.

## Goals

1. **Sub-issues** — on an issue, a person with write access can attach another issue in the same
   repository by number. At most 50 children. An issue has one parent. A cycle is refused.
   Pull requests are not sub-issues.
2. **Apply suggestion** — a line comment whose body contains a `suggestion` fence gets an Apply
   button for someone with write access. It replaces that one line in the file on the pull
   request's head branch and commits. The stored line must still match. The right side only.
   A merged pull request cannot be changed this way.
3. **Gists** — `GET /gists`, `GET /gists/new`, `POST /gists`, `GET /gists/:id`. A gist has a
   description, up to 10 files, and a secret flag. File names are a single path segment.
   Each file is at most 100,000 characters. A secret gist returns 404 to anyone except its
   owner. The id is a random token, not a counter.

## Non-goals

- SSH git, Git LFS, packages, Dependabot, and email.
- Codespaces, Copilot, Marketplace, Sponsors, and Pages.
- Applying a suggestion across more than the one commented line.
- Forking a gist or starring it.

## Anti-goals

- A gist file name must not be used as a filesystem path.
- A secret gist must not appear in a public list.
- Applying a suggestion must not commit if the line text changed.
- A sub-issue link must not point at another repository.

## Constraints

- One new migration. The device-code rewind drops the new tables first.
- CSRF on every form. `/gists` is registered before `/:owner`.
- Tests cover a secret gist 404, a refused sub-issue cycle, and a suggestion that updates the
  file only when the line still matches.
