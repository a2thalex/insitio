# GitHub parity, batch 3: pull requests

Status: design by the builder (the user asked for all of GitHub's remaining features without a
question round, so every decision below is the builder's call unless marked otherwise).

Depends on batch 2 (merged). Reviews, merge methods, and required checks apply to pull requests
that batch 1 already opens and merges with a merge commit.

## Intent

A pull request on git.iam.bot should be reviewable and mergeable the way a GitHub pull request is:
it can be a draft, people can be asked to review it, a review can approve or request changes,
comments can sit on a diff line, and the merge can be a merge commit, a squash, or a rebase.
A hidden private pull request stays a 404.

## Goals

1. **Drafts** — the new-pull-request form can mark the pull request as a draft. The list and the
   header show "Draft". The author, or a writer, can mark it ready or convert it back to a draft.
   Merging a draft is refused (409).
2. **Reviewers** — up to 10 users who already have read access, edited from the sidebar by a
   writer. Requesting or removing a reviewer is the whole of this goal. Nobody is notified
   (notifications are batch 6).
3. **Reviews** — a signed-in reader submits a review with a body (Markdown, 10_000) and one of
   `comment`, `approve`, or `request changes`. Anyone who can read may comment. Approve and
   request changes require write. The latest review from each user is the current decision; older
   reviews stay on the timeline. A request for changes does not by itself block the merge.
4. **Line comments** — on `/:owner/:repo/pull/:number/files`, a comment anchors to a file path and
   one diff side (`left` or `right`) plus a line number. The path goes through the same checks as
   a browser commit (`..`, absolute paths, `.git`, and ASCII controls are rejected). The author,
   or a repo admin, may edit or delete it. A fenced `suggestion` block is shown as a suggestion.
   Nothing in this batch turns a suggestion into a commit.
5. **Merge methods** — the merge form offers merge, squash, and rebase, for writers, and only while
   the pull request is open, not a draft, and not already merged.
   - Merge keeps today's merge commit (two parents).
   - Squash writes one commit on the base. Its message is the title and the body. Its only parent
     is the base tip. The same conflict check as merge applies.
   - Rebase replays at most 100 commits from the merge base to the head onto the base. If any
     commit conflicts, the base ref does not move. If the head is already contained in the base,
     the merge is refused as having nothing to merge. If the base is an ancestor of the head, the
     base ref moves to the head commit and no new commits are written.
   - A "Delete branch" checkbox deletes the head branch after a successful merge when that branch
     is not the default branch. The delete compares the branch to the SHA that was merged, so a
     branch that moved is left alone. Failure to delete does not undo the merge.
6. **Update branch** — when the base has commits the head does not, a writer can merge the base
   into the head from the pull request page. Conflicts are a 409 and the head does not move.
   This merge is not a push to the default branch, so it does not auto-close issues.
7. **Templates** — writers edit them at `/:owner/:repo/pulls/templates`. Up to 10. Each has a name
   (60 chars), an about line (120), a default title, and a body (10_000, Markdown). Opening a pull
   request shows a chooser when any template exists, unless `?template=<id>` or `?blank=1`. A
   template named `config` is not special. No YAML front matter.
8. **Commit statuses and required checks** — a writer with a personal access token posts
   `POST /api/v1/repos/:owner/:name/statuses/:sha` with `state` (`pending`, `success`, `failure`,
   or `error`), `context` (1–40 characters), and an optional `description` (140). One row per SHA
   and context; a later post replaces it. The pull request page lists the statuses of the head
   commit. Writers name up to 10 required contexts in the repository settings. Merge is refused
   (409) while any required context is missing or not `success` on the head commit that will be
   merged.

## Non-goals (this batch)

- Actions workflows, runners, and logs. A status is a row posted to the API, not a workflow run.
- A pending review that collects comments before it is submitted. A review is one POST. Line
  comments can also be added on their own after that.
- Turning a suggestion into a commit.
- Dismissing a review, CODEOWNERS, and branch rules beyond the required-context list.
- Notifications when you are asked to review.

## Anti-goals

- A review, a reviewer, a line comment, or a status must not reveal a private pull request or a
  private user list. Reviewer candidates are users who can already read the repository.
- Required checks are read from the head commit at merge time, not from a SHA the page showed
  earlier.
- Squash and rebase must not move the base ref if a commit conflicts.
- Deleting the head branch must not delete the default branch.

## Constraints

- Same stack as batch 2. New tables go in one new migration in `src/db/schema.ts`. Do not edit
  older migrations.
- CSRF on every form. The status API uses a bearer token and ignores cookies.
- `repoContext` / `accessLevel`. Hidden repos stay 404.
- Pull request numbers stay on the shared `repo_counters` sequence.
- Tests drive real git.

## Left to the builder

Exact SQL, whether a line comment stores a review id, and how rebase replays commits (commit-tree
rather than a work tree). The base ref moves only after every new commit object exists, with
`update-ref` compare-and-swap.
