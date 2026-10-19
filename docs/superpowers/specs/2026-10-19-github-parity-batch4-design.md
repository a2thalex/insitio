# GitHub parity, batch 4: repository settings

Status: design by the builder (the user asked for all of GitHub's remaining features without a
question round, so every decision below is the builder's call unless marked otherwise).

Depends on batch 3 (merged). Merge-button options apply to the merge methods that batch already
performs. Required status checks stay as they are.

## Intent

An admin on git.iam.bot should be able to rename a repository, give it to someone else, archive
it, turn issues or pull requests off, choose which merge buttons exist, protect a branch, and add
webhooks and deploy keys. A hidden private repository stays a 404.

## Goals

1. **Rename** — `POST /:owner/:repo/settings/rename` with the new name. Same rules as creating a
   repository (letters, numbers, `.`, `-`, `_`, at most 100 characters, not ending in `.git`).
   The name must be free for this owner. The bare repo directory moves with the row. The old URL
   is a 404.
2. **Transfer** — `POST /:owner/:repo/settings/transfer`. The admin types `newowner/name`. The
   new owner must exist and must not already have that repository name. Collaborators, issues and
   pull requests stay. The directory moves. The old URL is a 404.
3. **Archive** — an archived repository is read-only. Pushes, issue and pull-request changes, and
   browser edits are refused (403, "This repository is archived."). Stars, watches and forks still
   work. Settings stay available so an admin can unarchive. The repository header says Archived.
4. **Feature toggles** — issues and pull requests can each be turned off. A turned-off feature is
   a 404, including its tab. Labels stay, because pull requests use them. Both default to on.
5. **Merge buttons** — three switches: merge commit, squash, and rebase. At least one stays on.
   All three default to on. Merging by a method that is off is a 409.
6. **Branch protection** — an admin names one branch (an exact name, not a pattern) and sets
   "require a pull request" and a number of approving reviews from 0 to 6. Up to 10 branches.
   A non-admin push that moves a branch which requires a pull request is rejected by the
   pre-receive hook. Admins can still push. A merge needs that many approving reviews from people
   other than the pull-request author. The latest review from each person counts.
7. **Webhooks** — up to 10. URL is `http` or `https`, with no user or password in it. Literal
   loopback, link-local, and private addresses are refused, including `localhost`. Events are
   `push`, `issues`, and `pull_request`. An optional secret is sent as `X-Insitio-Signature:
   sha256=<hmac of the body>`. Delivery waits at most 2 seconds and does not undo the action that
   triggered it. The settings page shows the last 20 deliveries (status code only).
8. **Deploy keys** — up to 10 repo-scoped tokens, titled, each read or write. The token is shown
   once and stored as a hash. Git HTTP accepts it as the password for that repository only. It is
   not an account token and does not open the API. A write key is not an admin, so it cannot push
   to a branch that requires a pull request. SSH keys are out of scope until SSH git exists.

## Non-goals (this batch)

- Environments, Pages, Codespaces, Actions settings, and GitHub Apps.
- Rulesets, wildcard branch patterns, CODEOWNERS, and linear history.
- Resolving webhook hostnames before delivery. A public name that points at a private address is
  not detected.
- Retrying a failed webhook.
- Signed-in audit log of setting changes.

## Anti-goals

- Rename, transfer, and the on-disk path must not accept `..` or an absolute path. The directory
  is always `repos/<owner>/<name>.git` under the data directory, with both names lowercased.
- Transfer must not reveal whether a private repository exists at the destination beyond "that
  name is taken" for a name the admin is trying to create.
- An archived repository must not accept a push that the client can treat as success.
- A webhook must not be a request to `127.0.0.1`, `localhost`, link-local, or a private range.
- A deploy key for one repository must not authenticate to another.

## Constraints

- One new migration. Do not edit older migrations.
- CSRF on every form. Deploy keys are git HTTP Basic passwords, not cookies.
- `repoContext` / `accessLevel`. Hidden repos stay 404.
- Tests drive real git for the protected-branch hook.

## Left to the builder

Exact SQL, the hook script, and which handlers call the webhook sender. The sender must include
`push` after a receive-pack, `issues` when an issue is opened, and `pull_request` when a pull
request is opened or merged.
