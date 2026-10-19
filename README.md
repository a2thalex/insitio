# Insitio

A self-hosted, invite-only git forge with a GitHub-style web UI. Push and clone over HTTP, browse code, review diffs, track issues and merge pull requests.

The page layouts, URL scheme and data-loading approach come from evidence gathered on github.com with [REA (Reverse Engineer Anything)](https://github.com/morluto/rea). See [docs/rea-findings.md](docs/rea-findings.md) for what was observed and what Insitio adopted.

## Features

- **Git over HTTP**: clone, fetch and push through `git http-backend`, authenticated with personal access tokens. Private repos stay hidden (404) from anyone without access.
- **Code**: repository home with README, file tree, syntax-highlighted file view with line-range permalinks, raw and download links, blame, creating and editing files in the browser, zip and tar.gz archives, branches and tags, releases with downloadable assets, forks, watches, topics, a language bar, license detection and contributors.
- **Fast listings**: directory listings render immediately, and the "last commit" columns load afterwards from `/tree-commit-info/`, the same split github.com uses.
- **Issues**: Markdown comments, `#123` and `@user` links, labels, open/closed filters, search, close and reopen.
- **Pull requests**: compare branches, open a PR, then use the Conversation, Commits and Files changed tabs. Merges happen server-side with a merge commit, and conflicts are detected before you click merge.
- **People**: invite-only sign-up, profiles, stars, collaborators with read, write or admin roles, and a site-admin page.
- **Code search**: case-insensitive search across the default branch (`git grep`).
- **Command line**: `nsit`, a single-file client for people and AI agents that does everyday git work without git installed and signs in, creates repositories and pushes from the terminal. See [The nsit command line](#the-nsit-command-line).
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

Prefer a single tool? [`nsit`](#the-nsit-command-line) signs in without you copying a token, and does the cloning and pushing itself.

## The nsit command line

`nsit` is the Insitio command-line client, for people at a terminal and for AI agents. It is one file with nothing to install alongside it: it does the everyday git work (init, clone, status, add, commit, log, branch, switch, pull, push) itself, so git does not have to be installed on the machine, and it signs in, creates repositories and talks to the `/api/v1` of an Insitio server. Use it where you would use `git`. It reads your git configuration when there is one (name and email, `core.autocrlf`, ignore files) and writes only a repository's own `.git/config` and its own config file.

### Install

Every Insitio server serves installers and a `/download` page that shows these two commands with its own address. Replace `git.example.com` with your server:

```powershell
# Windows (PowerShell)
irm https://git.example.com/install.ps1 | iex
```

```bash
# macOS and Linux
curl -fsSL https://git.example.com/install.sh | sh
```

Each script downloads the binary for your system from the latest GitHub release, checks its SHA-256 against the release's `SHA256SUMS` and stops if it does not match. Nothing needs admin rights: nsit goes to `%LOCALAPPDATA%\Programs\nsit` on Windows (and onto your user PATH) and to `~/.local/bin` on macOS and Linux. Open a script in your browser first if you want to read it.

To install by hand, take the file for your system from the [latest release](https://github.com/a2thalex/insitio/releases/latest) and check it against `SHA256SUMS` from the same release:

| File | System |
|---|---|
| `nsit-windows-x64.exe` | Windows, 64-bit |
| `nsit-linux-x64` | Linux, 64-bit (static, so any distribution) |
| `nsit-macos-arm64` | macOS, Apple silicon |
| `nsit-macos-x64` | macOS, Intel |

`nsit --version` prints the version and the commit it was built from.

- The macOS binaries are signed with a Developer ID certificate and notarized by Apple.
- The Windows binary is **not code-signed** (there is no Microsoft certificate yet), so Windows may warn about an unknown publisher the first time a downloaded copy runs. The installer checks the checksum instead. The C runtime is built in, so no redistributable is needed.
- A pre-release (a version with a suffix such as `-rc.1`) is never "latest", so the installers do not pick it up. Download those by hand.

### Sign in

```bash
nsit auth login
```

nsit prints a short code such as `BCDF-GHJK` and the address of your server's approval page, and opens that page in the browser when it is running in a terminal. Approve it there as yourself, from this machine or any other: no password or token is typed into the terminal. The token goes into the system credential store (Windows Credential Manager, macOS Keychain, or the Secret Service on Linux). On a machine with no credential store at all, such as a headless Linux box, it goes into an owner-only file beside nsit's config instead. `nsit auth status` says which. `nsit auth logout` revokes this machine's token on the server and forgets it.

Agents, scripts and CI cannot approve in a browser. Make a token under **Settings → Personal access tokens**, then either store it:

```bash
printf %s "$TOKEN" | nsit auth login --with-token
```

or give it to a single run, without storing anything, in `NSIT_TOKEN`. nsit never takes a token as a command-line argument (it would land in shell history and process lists) and never writes one into `.git/config`, a remote URL, a log or an error message. Without a token, a command that needs one exits with code 3 at once and a hint, and never waits for input.

### Commands

Global flags work before or after the subcommand: `--host <host>` (default: `$NSIT_HOST`, then the server built into nsit), `--json`, `--jq <expr>`, `-q`/`--quiet`, `--no-color` and `-C <dir>` (run as if started in that directory).

| Command | What it does |
|---|---|
| `nsit auth login [--with-token]` | Sign in with a browser approval, or with a token read from stdin. |
| `nsit auth logout` | Revoke this machine's token on the server and forget it. |
| `nsit auth status` | Show the signed-in account and where its token is stored. |
| `nsit init [name] [--remote] [--readme] [--public]` | Start a repository (branch `main`) here, or in a new directory called `name`. With a name, or with `--remote`, it also creates the repository on Insitio (private unless `--public`), sets `origin`, and pushes if there are commits. `--readme` writes a starter README and makes the first commit; a README that is already there is left as it is and is not committed. |
| `nsit clone <repo> [dir]` | Copy a repository. `<repo>` is `name` (yours), `owner/name`, or a full URL. |
| `nsit status` | Staged, unstaged and untracked changes, and how far ahead of or behind the upstream you are. |
| `nsit add <paths>` | Stage files or directories. |
| `nsit commit [-m <msg>] [--staged] [--allow-secret <path>]` | Stage every change, including new files but never anything ignored, and commit. `--staged` commits only what `nsit add` staged. Without `-m` it can only finish a merge, using the message the merge left. Commits are by your git `user.name` and `user.email`, else by the name and email Insitio gave nsit at sign-in. |
| `nsit log [-n N] [--oneline]` | History of the current branch, newest first. It shows 20 entries unless `-n` asks for another number, and that holds for `--json` too. |
| `nsit branch [name] [-d name]` | List branches, create `name`, or delete a branch. |
| `nsit switch <branch> [-c]` | Switch branches (`-c` creates the branch first). Refuses when uncommitted changes would be overwritten. |
| `nsit pull [--abort]` | Fetch, then fast-forward or merge. A conflict leaves the merge in progress with conflict markers in the files and exits with code 4: fix the files, then `nsit commit`. `--abort` goes back to how things were before the pull. |
| `nsit push [-u] [--force-with-lease] [branch]` | Send the current branch (or `branch`). Refuses a push that is not a fast-forward unless `--force-with-lease`, which overwrites the remote branch only if it is where you last saw it. `-u` sets the upstream; the first push of a branch does that by itself. |
| `nsit readme` | Write a starter `README.md` if there is none. |
| `nsit repo create <name> [--description <text>] [--public]` | Create a repository on Insitio (private unless `--public`). |
| `nsit repo list [--owner <user>]` | List the repositories you can see. |
| `nsit repo view <repo>` | Show one repository. |

There is no command to delete a repository: tokens are not scoped, so an agent holding yours could otherwise delete your repositories. Deleting stays in the web UI, where you type the repository's name to confirm.

### For scripts and agents

- `--json` prints stable, machine-readable JSON from every command that prints data. `--jq <expr>` filters it with jq syntax and implies `--json`; a string result prints raw and anything else prints as JSON, as in `gh`. For example, `nsit auth status --jq .user` prints just the user name.
- Data goes to stdout; progress, hints and errors go to stderr.
- Nothing prompts when stdin or stdout is not a terminal.
- Color and progress appear only on a terminal, and `NO_COLOR` or `--no-color` turns color off. `-q` hides progress and hints.
- Network use follows your machine's proxy settings. Git traffic (`clone`, `push`, `pull`) uses `http.proxy` from your git configuration, then `HTTPS_PROXY` / `HTTP_PROXY`, and skips hosts listed in `NO_PROXY`; the API calls (`auth`, `repo`) use the same environment variables. A server on a loopback address (`localhost`, `127.0.0.1`) is always reached directly, never through a proxy.
- Timeouts for git traffic: connecting gives up after 30 seconds, and on Linux and macOS a server that connects and then says nothing is given up on after 10 minutes. On Windows git traffic goes through WinHTTP, whose connect limit is 60 seconds, and it has no limit for a server that connects and then goes silent: `clone`, `push` or `pull` can then wait indefinitely, so press Ctrl-C.

The fields of `--json` for the main commands. The names are exact, and a field that is said to be null is still there:

| Command | `--json` output |
|---|---|
| `nsit auth status` (and `auth login`) | `{host, user, token_source}`. `token_source` is `Env`, `Keychain` or `File`. The token itself is never printed. |
| `nsit repo list` | An array of repositories, each as in the next row. |
| `nsit repo view`, `nsit repo create` | One repository: `{owner, name, full_name, description, private, default_branch, clone_url, html_url, created_at}`. `created_at` is ISO-8601. |
| `nsit status` | `{branch, upstream, ahead, behind, staged, unstaged, untracked, conflicted}`. The last four are arrays of repository-relative paths. `branch` is null on a detached HEAD, and `upstream` is null (with `ahead` and `behind` 0) when there is none. |
| `nsit log` | An array of `{sha, author, email, date, subject}`, newest first, 20 unless `-n` says otherwise. `date` is ISO-8601 in the author's own UTC offset. |
| `nsit commit` | `{sha, files}`. `sha` is null and `files` is empty when there was nothing to commit. |
| `nsit clone` | `{owner, name, dir, default_branch}`. |
| `nsit push` | `{branch, remote, updated, old, new}`. `remote` is `owner/name`; `updated` is false when the server already had `new`; `old` is null when the server had no such branch. |
| `nsit pull` | `{result, head, conflicts}`. `result` is `up_to_date`, `fast_forward`, `merged`, `conflict` or (with `--abort`) `aborted`; `head` is the commit `HEAD` is at afterwards; `conflicts` lists the paths that stopped a merge. On a conflict this still goes to stdout, and the exit code is 4. |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | General error (network, files, anything not listed below) |
| 2 | Usage error: bad arguments, or something the command needs is missing (for example, no `origin`) |
| 3 | Not signed in, or the server refused the token |
| 4 | Merge conflict (`nsit pull`) |
| 5 | Blocked by the secret guard (`nsit commit`) |
| 6 | Rejected by the server, for example a push that is not a fast-forward |

### The secret guard

Before it commits, `nsit commit` refuses (exit code 5, listing the files) when a file the commit adds or changes looks like a secret. The file name is one of `.env`, `.env.*` (except `.env.example` and `.env.sample`), `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*.p12`, `*.pfx` or `credentials.json`; or the contents hold a private-key header or an Insitio, GitHub or AWS token; or it is an `.npmrc` or `.pypirc` with an auth line. It applies to `--staged` too.

To commit such a file anyway, say so by name: `nsit commit -m "..." --allow-secret path/to/file`. That adds the exact path to `.nsit-allow-secrets` (one path per line, `#` for comments) as part of the same commit, so every exception shows up in review and in the history. There is no switch that turns the guard off.

### Environment variables

| Variable | Purpose |
|---|---|
| `NSIT_TOKEN` | A token to use instead of a stored one, for agents and CI. It is only ever sent to the selected host. Blank counts as unset. |
| `NSIT_HOST` | The Insitio server (a host name or a URL) when `--host` is not given. The default is the server built into nsit, `git.iam.bot`. |
| `NSIT_CONFIG_DIR` | An absolute path for nsit's own files (`nsit.toml`, and the token file on a machine with no credential store). The default is `%APPDATA%\insitio` on Windows, and `$XDG_CONFIG_HOME/insitio` or `~/.config/insitio` elsewhere. |
| `NSIT_NO_KEYCHAIN` | `1` makes nsit behave as if the machine had no credential store, so tokens go in the owner-only file in the config directory. The test suites use it. |
| `NO_COLOR` | Any value other than empty turns color off. |

### Building from source

```bash
cargo build --release --manifest-path cli/Cargo.toml   # writes cli/target/release/nsit
```

This needs Rust 1.89 or later and a C compiler: libgit2 is compiled into the binary, and so is OpenSSL on Linux (which also needs `perl` and `make`). Git is not needed. For the static Linux binary that the releases ship, install `musl-tools`, run `rustup target add x86_64-unknown-linux-musl`, and add `--target x86_64-unknown-linux-musl` to the command above. With `--target`, cargo puts the binary in a different place: `cli/target/x86_64-unknown-linux-musl/release/nsit`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `BASE_URL` | `http://localhost:$PORT` | Public URL, used in clone URLs and invite links. An `https://` value turns on secure cookies. |
| `DATA_DIR` | `./data` | Database (`gitfkd.db`) and bare repositories (`repos/<owner>/<name>.git`) |
| `ALLOW_USER_INVITES` | unset | `1` lets non-admins create invite links |
| `NSIT_RELEASE_REPO` | `a2thalex/insitio` | GitHub `owner/repo` whose Releases hold the `nsit` binaries that `/download`, `/install.ps1` and `/install.sh` point at |
| `TRUST_PROXY` | unset | `1` trusts a proxy on loopback (or a comma list of proxy IPs) for client addresses, and binds the app to 127.0.0.1 |
| `HOST` | all interfaces (127.0.0.1 with `TRUST_PROXY`) | Interface to listen on |
| `REQUEST_TIMEOUT_MS` | `7200000` (2 hours) | The longest a client may take to send one whole request. Large git pushes (up to 2 GB) are sent in one request, so this is long; it is a bound and cannot be 0. Node's own default is 5 minutes, which would cut off a slow push. |
| `HEADERS_TIMEOUT_MS` | `60000` | The longest a client may take to send the request line and headers. Must not be more than `REQUEST_TIMEOUT_MS`. |
| `GIT_DRAIN_MAX_BYTES` | `268435456` (256 MiB) | When git stops reading a push early (a pack over `receive.maxInputSize`, a fatal error), the rest of the upload is read and dropped so the client sees git's answer. Past this many bytes the connection is closed instead. |
| `GIT_DRAIN_IDLE_MS` | `60000` | The same drain also gives up when the client sends nothing for this long. |

The four numbers above must be whole numbers of at least 1; a bad value stops the server at start-up with a message that names it.

Two things to know about the limits:

- Node's request timeout belongs to the whole server, not to a route, so `REQUEST_TIMEOUT_MS` (2 hours) applies to every request, not only to git pushes. What stops a client from holding a connection open by trickling its headers is `HEADERS_TIMEOUT_MS` in the app and, behind the shipped Caddyfile, Caddy's `read_header` (30 s) in front of it. A client that trickles a request body is bounded only by the full 2 hours, on any route.
- When a push is turned away before it has been read to the end, the server keeps reading and dropping it for up to `GIT_DRAIN_MAX_BYTES`, so the client can receive the server's message. If more than that is still to come, the connection is closed instead: the client sees a dropped connection, not the server's message.

For anything beyond your own machine, put Insitio behind an HTTPS reverse proxy (Caddy, nginx) and set `BASE_URL` to the public `https://` address. Tokens and session cookies must not travel over plain HTTP. Back up `DATA_DIR` to back up everything.

## Deploy to a VM

`deploy/` runs Insitio on Ubuntu 24.04 behind Caddy, which handles HTTPS certificates automatically:

- `setup.sh` installs Node 24, git and Caddy, creates a `gitfkd` service user, installs the app to `/opt/gitfkd` with data in `/var/lib/gitfkd`, and starts the `gitfkd` systemd service. It is safe to re-run for updates.
- `gitfkd.service` is a hardened systemd unit that can only write its data directory.
- `Caddyfile` proxies your domain to the app on 127.0.0.1:3000, allows git pushes up to 2 GB, and gives clients 30 s to send their request headers (the app bounds the rest, see `REQUEST_TIMEOUT_MS`).
- `deploy.sh` packs the committed code and runs `setup.sh` on a Google Cloud VM over IAP SSH. It has no defaults: you give it five environment variables, `PROJECT` (the Google Cloud project), `ZONE`, `VM` (the instance name), `DOMAIN` (the host name Caddy serves) and `ACCOUNT` (the Google account gcloud runs as). If any is missing it names them all and exits with status 2.

```bash
PROJECT=my-project ZONE=us-central1-a VM=my-vm DOMAIN=git.example.com ACCOUNT=you@example.com deploy/deploy.sh
```

Point your domain's A record at the VM first, so Caddy can get a certificate. Then create the first admin on the server:

```bash
gcloud compute ssh my-vm --project my-project --account you@example.com --zone us-central1-a --tunnel-through-iap --command 'cd /opt/gitfkd && sudo -u gitfkd env DATA_DIR=/var/lib/gitfkd BASE_URL=https://git.example.com node --disable-warning=ExperimentalWarning --import tsx src/cli/admin-create.ts yourname you@example.com'
```

## Development

```bash
npm test           # unit, route and end-to-end git tests (Vitest)
npm run typecheck  # tsc --noEmit
cargo test --manifest-path cli/Cargo.toml   # the nsit CLI's own tests (needs Rust)
```

The end-to-end tests start a real server and run `git clone` and `git push` against it. They use an isolated git config with credential helpers disabled, so they never touch your own git settings or credential store. The `nsit` end-to-end tests build the debug CLI with cargo and run it against the server; one of them pushes and clones a repository of 2,000 commits and a 20 MB file, and `NSIT_SKIP_SCALE=1 npm test` leaves that one out.

`.github/workflows/ci.yml` runs all of the above, plus `cargo fmt`, `cargo clippy` and the type check, on Windows, Linux and macOS. It runs on pushes to `main`, on pull requests, and on demand (`workflow_dispatch`, from the Actions tab), so a branch with no pull request is only built when someone starts it by hand.

### Layout

```
src/git/        bare-repo access through the git CLI (reads, server-side merge, grep)
src/githttp/    smart-HTTP bridge to git http-backend
src/services/   users, invites, tokens, repos, permissions, issues, pull requests
src/web/        Hono routes and server-rendered JSX views
cli/            the nsit command-line client (Rust)
deploy/         VM install and deploy scripts, systemd unit, Caddyfile
docs/           design spec, implementation plan, REA findings
```

### Releasing nsit

`.github/workflows/nsit-release.yml` builds the four `nsit` binaries and publishes them, with `SHA256SUMS`, as a GitHub release when a tag `nsit-vX.Y.Z` is pushed. The tag must match `version` in `cli/Cargo.toml`, so raise that (and `cli/Cargo.lock`) first. To try the pipeline without publishing anything, run it by hand from the Actions tab: it is a dry run by default, and the binaries stay as artifacts of that run.

The macOS binaries are signed with a Developer ID certificate and notarized by Apple inside the workflow, in a job of their own (`sign-macos`) that runs after the Mac build and builds nothing. The build jobs, which run every dependency's build script, never see a secret. Signing needs six repository secrets (Settings → Secrets and variables → Actions), and a tag build stops at once if any is missing:

| Secret | What it holds |
|---|---|
| `APPLE_CERT_P12_BASE64` | The Developer ID Application certificate with its private key, exported as a `.p12` file and base64-encoded |
| `APPLE_CERT_PASSWORD` | The password that `.p12` file was exported with |
| `APPLE_SIGNING_IDENTITY` | The certificate's name, as `security find-identity -v -p codesigning` prints it, such as `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_API_KEY_P8_BASE64` | An App Store Connect API key (`AuthKey_XXXX.p8`), base64-encoded, which notarization signs in with |
| `APPLE_API_KEY_ID` | That key's Key ID |
| `APPLE_API_ISSUER_ID` | The Issuer ID shown above the key list in App Store Connect |

The Windows binary is not signed.

## Not included (yet)

SSH access, organizations and teams, forks, Actions/CI, webhooks, releases, wikis, line-level review comments, and email notifications. `nsit` covers git and repositories only: for now, issues and pull requests are used in the web UI.
