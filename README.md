# Insitio

A self-hosted, invite-only git forge with a GitHub-style web UI. Push and clone over HTTP, browse code, review diffs, track issues and merge pull requests.

The page layouts, URL scheme and data-loading approach come from evidence gathered on github.com with [REA (Reverse Engineer Anything)](https://github.com/morluto/rea). See [docs/rea-findings.md](docs/rea-findings.md) for what was observed and what Insitio adopted.

## Features

- **Git over HTTP**: clone, fetch and push through `git http-backend`, authenticated with personal access tokens. Private repos stay hidden (404) from anyone without access.
- **Code**: repository home with README, file tree, syntax-highlighted file view, raw and download links, branch and tag switcher, commit history grouped by day, and commit diffs.
- **Fast listings**: directory listings render immediately, and the "last commit" columns load afterwards from `/tree-commit-info/`, the same split github.com uses.
- **Issues**: Markdown comments, `#123` and `@user` links, labels, open/closed filters, search, close and reopen.
- **Pull requests**: compare branches, open a PR, then use the Conversation, Commits and Files changed tabs. Merges happen server-side with a merge commit, and conflicts are detected before you click merge.
- **People**: invite-only sign-up, profiles, stars, collaborators with read, write or admin roles, and a site-admin page.
- **Code search**: case-insensitive search across the default branch (`git grep`).
- Light and dark themes that follow the system setting, built on Primer CSS and Octicons (both MIT).

## Requirements

- Node.js 22.13 or later (uses the built-in `node:sqlite`)
- git 2.38 or later (for `git merge-tree --write-tree`), with `git http-backend` (included in Git for Windows and most Linux packages)

## Getting started

```bash
npm install
```

Create the first site admin. This prints a one-time password:

```bash
npm run admin:create -- yourname you@example.com
```

Start the server:

```bash
npm run dev
```

Open http://localhost:3000, sign in, and change your password under **Settings → Password**.

### Inviting people

Insitio has no open sign-up. As a site admin, open **Site admin** from the avatar menu and click **Create invite link**, then send the link to the person you're inviting. Each link creates one account and expires after 7 days. You can also print one from the terminal:

```bash
npm run invite:create
```

Set `ALLOW_USER_INVITES=1` to let every user create invites from **Settings → Invites**.

### Cloning and pushing

Create a token under **Settings → Personal access tokens** and use it as the password:

```bash
git clone http://localhost:3000/yourname/your-repo.git
```

A new empty repository shows these push instructions on its page. If the first push is a `master` branch instead of `main`, Insitio makes it the default branch.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `BASE_URL` | `http://localhost:$PORT` | Public URL, used in clone URLs and invite links. An `https://` value turns on secure cookies. |
| `DATA_DIR` | `./data` | Database (`gitfkd.db`) and bare repositories (`repos/<owner>/<name>.git`) |
| `ALLOW_USER_INVITES` | unset | `1` lets non-admins create invite links |
| `NSIT_RELEASE_REPO` | `a2thalex/gitfkd` | GitHub `owner/repo` whose Releases hold the `nsit` binaries that `/download`, `/install.ps1` and `/install.sh` point at |

| `TRUST_PROXY` | unset | `1` trusts a proxy on loopback (or a comma list of proxy IPs) for client addresses, and binds the app to 127.0.0.1 |
| `HOST` | all interfaces (127.0.0.1 with `TRUST_PROXY`) | Interface to listen on |

For anything beyond your own machine, put Insitio behind an HTTPS reverse proxy (Caddy, nginx) and set `BASE_URL` to the public `https://` address. Tokens and session cookies must not travel over plain HTTP. Back up `DATA_DIR` to back up everything.

## Deploy to a VM

`deploy/` runs Insitio on Ubuntu 24.04 behind Caddy, which handles HTTPS certificates automatically:

- `setup.sh` installs Node 24, git and Caddy, creates a `gitfkd` service user, installs the app to `/opt/gitfkd` with data in `/var/lib/gitfkd`, and starts the `gitfkd` systemd service. It is safe to re-run for updates.
- `gitfkd.service` is a hardened systemd unit that can only write its data directory.
- `Caddyfile` proxies your domain to the app on 127.0.0.1:3000 and allows git pushes up to 2 GB.
- `deploy.sh` packs the committed code and runs `setup.sh` on a Google Cloud VM over IAP SSH.

```bash
deploy/deploy.sh
```

Point your domain's A record at the VM first, so Caddy can get a certificate. Then create the first admin on the server:

```bash
gcloud compute ssh gitfkd-1 --zone us-central1-a --tunnel-through-iap --command 'cd /opt/gitfkd && sudo -u gitfkd env DATA_DIR=/var/lib/gitfkd BASE_URL=https://git.example.com node --disable-warning=ExperimentalWarning --import tsx src/cli/admin-create.ts yourname you@example.com'
```

## Development

```bash
npm test           # unit, route and end-to-end git tests (Vitest)
npm run typecheck  # tsc --noEmit
```

The end-to-end tests start a real server and run `git clone` and `git push` against it. They use an isolated git config with credential helpers disabled, so they never touch your own git settings or credential store.

Layout:

```
src/git/        bare-repo access through the git CLI (reads, server-side merge, grep)
src/githttp/    smart-HTTP bridge to git http-backend
src/services/   users, invites, tokens, repos, permissions, issues, pull requests
src/web/        Hono routes and server-rendered JSX views
docs/           design spec, implementation plan, REA findings
```

## Not included (yet)

SSH access, organizations and teams, forks, Actions/CI, webhooks, releases, wikis, line-level review comments, and email notifications.
