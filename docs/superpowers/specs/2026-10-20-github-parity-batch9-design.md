# GitHub parity, batch 9: rules, environments, explore, views

Status: design by the builder. The user asked to continue and to do full parity.

## Intent

Close the in-app gaps that are still partial: branch rules that match a pattern and block force-pushes
and deletes, deployment environments, a public explore page, and insight counts that come from real
page loads.

## Goals

1. **Branch rules** — a rule name may be exact (`main`) or a prefix (`release/*` or `*`). It can
   require a pull request, require up to 6 approvals, block force-push, and block deletion. An
   admin push still bypasses. A fast-forward is allowed when only force-push is blocked.
2. **Environments** — `POST /:owner/:repo/settings/environments` creates one (at most 20). A
   deployment names an environment and a commit that exists. Listed at `GET /:owner/:repo/deployments`.
3. **Explore** — `GET /explore` shows recent public repositories, public issues, and public gists.
   A private repository does not appear.
4. **Views** — opening a repository page adds one to that UTC day's count. Insights shows the last
   14 days. The number is page loads, not unique people.

## Non-goals

- Running workflow files.
- Dependabot, email, SSH git, Git LFS, packages, Pages, Codespaces, Copilot, Marketplace, Sponsors.

## Anti-goals

- A pattern rule must not protect a branch outside its prefix.
- Explore must not list a private repository or a secret gist.
- A deployment must not accept a commit that is not in the repository.

## Constraints

- One new migration. The device rewind drops the new tables and columns first.
- CSRF on forms. Tests cover a pattern rule, a hidden private repo on explore, and a rejected deployment sha.
