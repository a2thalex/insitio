# Push mirrors

Status: design by the builder. Asked for so a GitHub copy of an Insitio repository stays current
without anyone running a sync by hand.

## Intent

An admin points a repository at another forge (an https git URL plus a username and access token).
From then on Insitio keeps that copy an exact match: every branch and tag, pushed after each change.

## Goals

1. **Settings** — "Push mirrors" on the repository settings page, admins only: add (URL, username,
   token), "Sync now", delete. At most 10 per repository. The token is never shown again.
2. **After a push** — a `git push` over HTTP starts the mirror push once git has answered the
   client; the client never waits for it.
3. **Sweep** — once a minute, any mirror whose branches or tags changed since its last good push is
   pushed. This catches changes made in the web UI (merges, file edits, branch create and delete).
4. **Exact copy** — `+refs/heads/*` and `+refs/tags/*` with `--prune`: force-pushed, and a branch
   deleted here is deleted there.
5. **Status** — each mirror shows when it last pushed and, if the last attempt failed, git's reason.

## Non-goals

- Pulling from the other forge (two-way sync). Anything pushed only to the mirror is overwritten.
- SSH remotes, pull-request refs, Git LFS.

## Anti-goals

- The token must not appear in the URL, the argument list, logs, or a recorded error.
- A mirror must not reach a private, loopback or metadata address, follow a redirect, or use any
  protocol but https (plain http on loopback only when `MIRROR_ALLOW_LOOPBACK=1`, for tests).
- An empty repository must not prune the mirror's branches.
- A failing mirror must not be retried every minute: the sweep waits 10 minutes after a failure.

## Constraints

- One new migration (`push_mirrors`); the device-code rewind drops it first.
- One push per mirror at a time; a change during a push runs it once more afterwards.
- A push is killed after 10 minutes. CSRF on forms. Tests mirror one repository into another on a
  real server: after a push, after a web edit, a refused push, and an empty source.
