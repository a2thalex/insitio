# GitHub parity, batch 6: site-wide

Status: design by the builder (the user asked for all of GitHub's remaining features without a
question round, so every decision below is the builder's call unless marked otherwise).

Depends on batch 5 (merged and deployed).

## Intent

A signed-in person on git.iam.bot should be able to see notices about their own work, search
the site, and share repositories through an organization. A private repository stays hidden
from anyone who was not given access.

## Goals

1. **Notifications inbox** — `GET /notifications` and `POST /notifications/read`. Each row is a
   title, a URL on this site, a short reason, and a read time. The header links here and shows
   the unread count. A comment notifies the issue or pull-request author. A new assignee is
   notified once, not on every save. The actor is not notified. `users.notify = ignore` drops
   the row. There is still no outbound mail. The list shows the latest 50.
2. **Search** — `GET /search?q=&type=repos|issues|users|code`. An empty query still lists recent
   public repositories. Issues match title or body, then the viewer's access, at most 30 hits
   from 80 candidates. People match the username, and an organization is labeled and linked to
   its profile at `/:name`. Code runs `git grep` on the default branch of at most 15 repositories
   the viewer can already see, 5 files each, and stops at 30 lines.
3. **Organizations and teams** — `GET/POST /orgs/new`, `GET /orgs/:name` (owners only), and
   posts to add a member, create a team, add a team member, and grant a repository role
   (`read`, `write`, or `admin`). An organization is a user row with `kind = org`. It cannot
   sign in. The owner is an `org_members` row. A team grant applies only to a repository that
   organization owns. The new-repository form can create the repository as yourself or as an
   organization you own. The profile at `/:org` says Organization.
4. **Access** — a site admin, the repository owner, and an organization owner are admin. Anyone
   else gets the higher of their collaborator role and their team roles on that repository.
   A plain organization member, with no team grant and no collaborator row, does not see a
   private organization repository. Hidden repositories stay 404.

## Non-goals (this batch)

- Email delivery and address verification.
- SSH git, Git LFS, gists, and packages.
- Billing, nested teams, and WebAuthn.
- Actions, Projects, Wiki, Discussions, Security, and Insights (batch 7).

## Anti-goals

- Organization membership must not turn a private repository into a 200 for a stranger, or for
  a member who was not granted that repository.
- A team grant must not apply to a repository owned by someone else.
- One person's inbox must not list another person's notifications.
- Search must not return an issue or a line of code from a repository the viewer cannot read.

## Constraints

- One new migration. Do not edit older migrations. The device-code rewind drops the new tables
  and the `users.kind` column before it replays.
- CSRF on every form. `/orgs` and `/notifications` are registered before `/:owner/:repo`.
- Tests cover organization access, a comment notification against `ignore`, and search that
  hides a private issue.
