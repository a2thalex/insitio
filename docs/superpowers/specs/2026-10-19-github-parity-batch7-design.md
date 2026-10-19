# GitHub parity, batch 7: repository tabs

Status: design by the builder (the user asked for the remaining batch without a question round).

Depends on batch 6 (merged and deployed).

## Intent

Each repository should have the remaining GitHub tabs that are in scope: Actions, Projects, Wiki,
Discussions, Security, and Insights. A private repository stays hidden. Insitio does not run
workflow files, and it does not invent traffic numbers.

## Goals

1. **Wiki** — `GET /:owner/:repo/wiki` and `GET/POST /:owner/:repo/wiki/:slug`. A page name is
   letters, numbers, and single hyphens, at most 80 characters. The body is Markdown, at most
   100,000 characters, and at most 100 pages per repository. Writing needs write access.
2. **Discussions** — `GET/POST /:owner/:repo/discussions` and `GET/POST .../discussions/:n`.
   Categories are General, Ideas, and Q&A. A comment notifies the thread author unless they
   wrote it or their notification preference is ignore. At most 200 threads are listed.
3. **Projects** — `GET/POST /:owner/:repo/projects` and `GET /:owner/:repo/projects/:id`. A new
   board starts with To do, In progress, and Done. Cards have a title and can name an issue
   number. Moving a card is a form. At most 10 boards, 8 columns, and 100 cards.
4. **Actions** — `GET /:owner/:repo/actions` lists `.github/workflows/*.yml` on the default
   branch and the latest 30 recorded runs. `POST .../actions/runs`, and the same call on the
   bearer API, records a run (name, commit, status, conclusion). Insitio does not execute the
   workflow. The commit must already exist in the repository.
5. **Security** — `GET /:owner/:repo/security`. Readers see published advisories. An admin can
   draft one and publish it. A person with write access can scan the default branch: at most 40
   text files, 200 KB each. A finding is a path and a rule name. The matched text is not shown.
6. **Insights** — `GET /:owner/:repo/insights` shows contributors, recent commits, issues opened
   in seven days, stars, and forks. It says page views are not recorded.

## Non-goals

- Running workflow YAML, hosting runners, or scheduling jobs.
- Dependabot, code scanning alerts, and dependency graphs.
- Traffic, clones, and referrer charts.
- Codespaces, Copilot agents, Pages, wikis stored as a second git repository, and SSH.

## Anti-goals

- A wiki slug must not be used as a filesystem path.
- A secret scan must not print the secret.
- A private repository's new tabs must 404 for someone with no access.
- An action run must not be a shell command.

## Constraints

- One new migration. The device-code rewind drops the new tables first.
- CSRF on every form. Routes use `withRepo`. Archived repositories stay read-only.
- Tests cover a private 404, a rejected wiki slug, a discussion notification, a secret scan that
  hides the secret, and an action run that is only a record.
