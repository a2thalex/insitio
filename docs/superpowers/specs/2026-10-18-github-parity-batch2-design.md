# GitHub parity, batch 2: issues

Status: design by the builder (the user asked for all of GitHub's remaining features without a
question round, so every decision below is the builder's call unless marked otherwise).

Depends on batch 1 (merged). Cross-references and "Fixes #n" also apply to pull requests, which
batch 3 will extend. This batch stores the data and runs the rules for issues.

## Intent

An issue on git.iam.bot should be workable the way a GitHub issue is: someone is assigned, it sits
in a milestone, comments can be edited, people can react, and merging or committing "Fixes #n"
closes it. The page should still be server-rendered Primer, and a hidden private issue stays a 404.

## Goals

1. **Assignees** — up to 10 users who already have read access. On `/:owner/:repo/issues/:number`,
   a sidebar "Assignees" editor for writers. Filter `?assignee=username` and `no:assignee` on the
   issue list. The API field is `assignees: ["login"]` on `GET/PATCH /api/v1/repos/:owner/:name/issues/:number`
   (PATCH is new; creating an issue may also send assignees).
2. **Milestones** — `/:owner/:repo/milestones` and `/:owner/:repo/milestones/new`,
   `/:owner/:repo/milestones/:number/edit`. Fields: title (120 chars), description (Markdown, 10_000),
   optional due date, open/closed. An issue has at most one milestone. Sidebar editor for writers.
   Filter `?milestone=title` and `no:milestone`. Closing a milestone does not close its issues.
   Deleting a milestone clears it from issues. 30 per page.
3. **Edit and delete comments** — the author, or a repo admin, may edit a comment for  the
   current body (history is not kept). Delete asks for confirmation and removes the row. The issue
   body uses the existing edit route, now linked from the issue page. A deleted comment leaves no
   placeholder.
4. **Reactions** — on the issue body and on each comment: 👍 👎 😄 🎉 😕 ❤️ 🚀 👀. One row per
   user per target per emoji. Toggle by clicking. Show the count and, to a signed-in user, whether
   they reacted. Anyone who can read the repo and is signed in may react. No custom emoji.
5. **Close reasons** — closing an issue chooses "completed" (default) or "not planned". Reopening
   clears the reason. The list and the issue header show the reason. Filter `?reason=completed` and
   `?reason=not_planned` among closed issues.
6. **Lock** — writers can lock a conversation. While locked, only writers can comment or react.
   Readers see "This conversation has been locked." Unlock is the same control.
7. **Pin** — up to 3 pinned issues per repo, writers only. Pinned issues render above the list on
   `/:owner/:repo/issues`, open or closed.
8. **Templates** — writers edit them at `/:owner/:repo/issues/templates`. Up to 10 templates.
   Each has a name (60 chars), about line (120), default title, and body (10_000, Markdown).
   "New issue" shows a chooser when any template exists; picking one fills the form. A template
   named `config` is not special. No YAML front matter.
9. **"Fixes #n" auto-close** — when a pull request is merged, or when a commit is pushed to the
   default branch, scan the message for `fix`, `fixes`, or `fixed`, then `#n` or
   `owner/repo#n` (case insensitive, the keyword and the reference on the same line). Each match
   closes that open issue with reason completed, records who did it, and comments
   "Closed by <sha or PR link>." A reference to another repo on this server is followed only when
   the actor can write there. `close`, `closes`, `closed`, `resolve`, `resolves`, `resolved` count
   the same way. Nothing reopens on a force-push.
10. **Cross-references** — the issue timeline lists "mentioned this in #m / PR #m / commit sha"
    when another issue, pull request, or commit message on the same repo links `#n`. Rendering of
    `#n` links already exists; this goal adds the timeline row. Mentions in comments and bodies
    are recorded when the comment or issue is saved, not by scraping history.

## Non-goals (this batch)

- Sub-issues, issue dependencies, and saved replies (saved replies are account settings, batch 5).
- Review comments on pull requests (batch 3). The auto-close rule runs for the merge that batch 1
  already performs, and for commits on the default branch.
- Notifications when you are assigned (batch 6). The assignee row is the whole of this batch.
- Multiple milestones per issue, milestone burndown charts.

## Anti-goals

- A reaction, assignee, or milestone must not reveal a private issue or a private user list.
  Candidates for assignee are users who can already read the repo.
- Closing via "Fixes #n" must not close an issue the actor cannot write to.
- Locking must not delete comments.

## Constraints

- Same stack as batch 1. New tables go in one new migration in `src/db/schema.ts`. Do not edit
  older migrations.
- CSRF on every form. `repoContext` / `accessLevel`. Hidden repos stay 404.
- Issue numbers stay on the shared `repo_counters` sequence.

## Left to the builder

Exact SQL, the shape of the timeline events, and how a push is scanned (a hook in the smart HTTP
receive path versus reading the new commits after the push returns). The scan must see the commit
messages of commits that landed on the default branch and must not run `git log` over the whole
history on every page view.
