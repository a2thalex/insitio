# nsit — the Insitio command line

Date: 2026-10-18. Status: awaiting approval (builder check done).
Evidence: `docs/rea-findings-cli.md` (REA analysis of GitHub's `gh` and of Jujutsu `jj`).

## Intent

`nsit` is how people and AI agents work with Insitio repositories from a
terminal, typed in place of `git`. It must work on a machine that does not
have git installed, so a fresh laptop, a CI box or an agent's sandbox can
download one file and immediately init, clone, commit, pull and push against
git.iam.bot.

Why: today working with Insitio needs both the browser (create repos, make
tokens) and a separately installed, separately configured git. Agents in
particular need one predictable tool with machine-readable output.

## Users

Both, equally (user's answer):
- **People at a terminal:** readable output, prompts before risky steps.
- **AI agents and scripts:** never prompt when stdin/stdout is not a TTY,
  `--json` on every command that prints data, documented exit codes,
  non-interactive auth via an environment variable.

## Goals (v1)

1. Single self-contained executable for Windows x64, Linux x64 and macOS
   (arm64 and x64). No git, Node or other runtime required.
2. Sign in once (`nsit auth login`) without typing a password into the
   terminal; tokens stored in the OS credential store.
3. Everyday git work without git: init, clone, status, add, commit, log,
   branch, switch, pull, push.
4. Create and inspect Insitio repositories from the terminal, including
   `nsit init` creating the server-side repo and pushing the first commit.
5. Repositories made or changed by `nsit` are ordinary git repositories that
   real git can read (`git fsck` clean).

## Non-goals (v1)

- Issues, pull requests, releases, labels and other `gh`-style commands
  (next iteration; the API added here is designed so they slot in).
- SSH transport, Git LFS, submodules, rebase, stash, cherry-pick, bisect,
  worktrees, signing commits, shallow/partial clones.
- Hosting on GitHub or other forges as a first-class target. `nsit` speaks
  standard smart HTTP, so plain clone/pull/push against other servers may
  work, but only Insitio is supported and tested for auth and repo commands.

## Anti-goals (would be a failure even if it works)

- Leaking tokens: in shell history, process lists, logs, error messages,
  repo config files or remote URLs written to disk.
- Silently committing secrets or ignored files.
- Leaving a repository in a state real git considers corrupt.
- Hanging on a prompt when run by an agent.

## Decisions made with the user

- Name `nsit`, used instead of `git`.
- Must work without git installed.
- Rust, following what REA showed about Jujutsu (user: "use rust").
- Commit behavior: "whatever is the easiest and most secure" → see Commit.
- Default server git.iam.bot.

## How it works

### Stack (builder may substitute equivalents)

| Concern | Choice | Reason |
|---|---|---|
| Language | Rust (stable 1.94 installed locally with MSVC build tools) | User's call; matches jj |
| Local git | `gix` (gitoxide), same family of crates jj ships | Pure Rust, no git binary |
| Clone/fetch | `gix` HTTP transport with the reqwest + rustls backend | No OpenSSL to bundle |
| Push | Own smart-HTTP receive-pack client, packs built with `gix-pack` | gitoxide has no push (REA: jj shells out to git for this) |
| Merge on pull | `gix-merge` (tree/blob merge with conflict markers) | Pure Rust |
| CLI | `clap` with derive | jj's choice; Rust analog of gh's cobra |
| Credentials | `keyring` crate (Windows Credential Manager, macOS Keychain, Secret Service) | Analog of gh's go-keyring |
| HTTP API | `reqwest` (rustls) + `serde` | |
| `--jq` | `jaq` | Analog of gh's gojq |
| Terminal | `crossterm` / simple prompts only on a TTY; color only on a TTY and not with `NO_COLOR` | |

The crate lives in this repository at `cli/` (Cargo workspace member), next to
the server, so the API and its only client change together.

### Configuration and auth

- Config file: `%APPDATA%\insitio\nsit.toml` on Windows,
  `$XDG_CONFIG_HOME/insitio/nsit.toml` (or `~/.config`) elsewhere. Holds
  hosts and usernames, never tokens.
- Default host `git.iam.bot`; `--host` / `NSIT_HOST` selects another
  Insitio server. Multiple hosts can be signed in.
- Token resolution order: `NSIT_TOKEN` env var (for agents and CI), then the
  OS credential store entry for the host, then (only if no credential store
  is available, e.g. a headless Linux box) a token file next to the config
  with owner-only permissions; `nsit auth status` says which is in use.
- `nsit auth login`: device flow (below). `--with-token` reads a token from
  stdin for non-interactive setup. Never accepts a token as a command-line
  argument (it would land in shell history and process lists).
- `nsit auth logout`: deletes the stored token and revokes it on the server.
- Git operations authenticate with HTTP Basic (`username:token`), sent only
  over HTTPS (refuse plain `http://` hosts except `localhost`). Remote URLs
  saved in `.git/config` never contain credentials.

### Device flow (server and client)

1. `POST /api/v1/device/code` → `{device_code, user_code, verification_uri,
   expires_in, interval}`. `user_code` is 8 characters (`ABCD-EFGH`),
   expires in 10 minutes.
2. `nsit` prints the code and URL (`https://git.iam.bot/login/device`) and
   opens the browser when it can.
3. The signed-in user enters the code on that page, sees which machine is
   asking ("nsit on GREGORY-PC"), and approves or denies. Approval creates a
   personal access token named after the machine.
4. `nsit` polls `POST /api/v1/device/token` every `interval` seconds; the
   server answers `authorization_pending`, `slow_down`, `access_denied`,
   `expired_token`, or the token once.
5. Device codes are single-use, stored hashed, and rate limited per client
   address.

### Insitio API v1 (server additions)

JSON over HTTPS under `/api/v1`, `Authorization: Bearer <token>` (the same
personal access tokens as git). Private repos return 404 to callers without
access, as the web UI does. Errors: `{"error": {"code", "message"}}` with
matching HTTP status. v1 endpoints:

- `GET /api/v1/user` — the signed-in user.
- `GET /api/v1/repos?owner=` — repos visible to the caller.
- `POST /api/v1/repos` — `{name, description, private}` (private defaults to
  true).
- `GET /api/v1/repos/:owner/:name` — repo details including clone URL and
  default branch.
- No delete endpoint in v1 (builder check; my call): tokens are not scoped,
  so an agent holding a user's token could otherwise delete their repos.
  Deleting stays in the web UI, which requires typing the repo name.
- Device flow endpoints above, `DELETE /api/v1/user/tokens/current` for
  logout.

Requests and responses are covered by route tests in the server suite.

### Commands (v1)

Global flags: `--host`, `--json`, `--jq <expr>` (implies `--json`), `-q`,
`--no-color`, `-C <dir>`.

| Command | Behavior |
|---|---|
| `nsit auth login / logout / status` | As above |
| `nsit init [name]` | `git init` equivalent in the current (or new) directory with branch `main`; with a name (or `--remote`), also creates the private repo on the server, sets `origin`, and pushes if there are commits. `--readme` writes a starter README and makes the first commit. |
| `nsit clone <repo> [dir]` | `name` means your own repo, `owner/name` anyone's, a full URL also works. |
| `nsit status` | Staged, unstaged, untracked, ahead/behind upstream. |
| `nsit add <paths>` | Stage paths. |
| `nsit commit -m <msg>` | See Commit. |
| `nsit log [-n N] [--oneline]` | History of the current branch. |
| `nsit branch [name] [-d name]` | List, create, delete branches. |
| `nsit switch <branch> [-c]` | Switch branches; refuses with uncommitted changes that would be overwritten. |
| `nsit pull` | Fetch, then fast-forward or merge (see Pull). |
| `nsit push [-u] [branch]` | Push the current branch; refuses non-fast-forward unless `--force-with-lease`. |
| `nsit readme` | Writes a starter README.md (repo name, description from the server if known, clone and usage stub) if none exists. |
| `nsit repo create / list / view` | API commands (no delete in v1). |

Commit author: `user.name`/`user.email` from git config (see below) or `nsit`
config; `nsit auth login` fills them from the Insitio account the first time.

### Existing git configuration (builder check; my call)

`nsit` reads standard git configuration whenever it exists, through gix's
config loading: system, global (`~/.gitconfig`, XDG) and repository files.
That includes `user.*`, `core.autocrlf`, `core.eol`, `core.excludesFile` and
`.gitattributes` `text`/`eol` rules, so a repo behaves the same under `nsit`
and git on the same machine (no "every file modified" on Windows with
`core.autocrlf=true`). On a machine with no git config, `nsit` writes nothing
global and applies no line-ending conversion. `nsit` writes only repository
config (`.git/config`) and its own `nsit.toml`.

### Commit ("easiest and most secure")

- `nsit commit -m <msg>` stages every change, including new files, then
  commits. `--staged` commits only what was added with `nsit add`.
- Never stages anything matched by `.gitignore` / `.git/info/exclude`.
- **Secret guard:** before committing, refuses (exit code 5) if a file this
  commit adds or changes (compared with HEAD; for a merge, only files whose
  result differs from the merged-in branch, i.e. the user's own changes)
  matches a built-in list of secret-looking names (`.env`,
  `.env.*` except `.env.example`/`.env.sample`, `*.pem`, `*.key`, `id_rsa*`,
  `id_ed25519*`, `*.p12`, `*.pfx`, `credentials.json`, `.npmrc` / `.pypirc`
  with auth lines) or contains an obvious private-key header or an Insitio /
  GitHub / AWS token pattern. The message lists the files and how to override.
  The guard applies to `--staged` too.
- **Overrides are recorded, not one-off (builder check; my call):**
  `nsit commit --allow-secret <path>` adds the exact path to a committed
  `.nsit-allow-secrets` file (one path per line, `#` comments) as part of the
  same commit, so every exception is visible in review and history. Paths
  listed there are not flagged again. There is no flag that disables the
  guard wholesale.
- Prints the committed file list (and `--json` returns it).

### Pull

- Fetch the upstream branch, fast-forward if possible, otherwise merge with
  `gix-merge`. On conflict: write standard conflict markers, leave the merge
  in progress (`MERGE_HEAD`) so real git recognizes it, list the files, exit
  code 4. `nsit commit` after resolving completes the merge;
  `nsit pull --abort` restores the pre-merge state.

### Push

- Advertise refs from the server, compute objects reachable from the local
  commit and not from any advertised ref, build a pack with `gix-pack`, send
  the receive-pack request with `report-status`, parse the result.
- Thin packs and delta compression are optional for v1 (full objects are
  acceptable); pushes up to the server's 2 GB limit must work.
- `-u` sets the upstream in `.git/config`.

### Output and exit codes

- Human output by default; `--json` returns stable field names (documented
  per command); `--jq` filters JSON with jq syntax.
- Exit codes: 0 success, 1 general error, 2 usage error, 3 not signed in /
  auth failed, 4 merge conflict, 5 blocked by the secret guard, 6 rejected by
  the server (e.g. non-fast-forward).
- Errors go to stderr, data to stdout. No color or spinners when not a TTY.

### Distribution (decided with the user)

- **Public GitHub releases.** The user chose to make the GitHub repository
  public so binaries can be downloaded without a login. Before the
  visibility change (which the user performs or explicitly approves at that
  time): remove personal and infrastructure defaults from tracked files
  (`deploy/deploy.sh` hardcodes the gcloud account and project; make them
  required environment variables), and re-scan history for secrets.
- GitHub Actions builds release binaries on a `nsit-v*` tag:
  `x86_64-pc-windows-msvc`, `x86_64-unknown-linux-musl` (static),
  `aarch64-apple-darwin`, `x86_64-apple-darwin`; uploads them with a
  `SHA256SUMS` file to the GitHub release.
- **Signing:** macOS binaries are signed with the user's Apple Developer ID
  and notarized in CI. The user adds the certificate (.p12), its password,
  and App Store Connect API key details as GitHub Actions secrets; the
  workflow fails clearly if they are missing. Windows binaries are unsigned
  for now (no Microsoft certificate), so first runs may show an "unknown
  publisher" prompt; the install script verifies the checksum.
- Insitio serves `/download` (links to the latest release assets and
  checksums) and install scripts: `irm https://git.iam.bot/install.ps1 | iex`
  and `curl -fsSL https://git.iam.bot/install.sh | sh`, which download from
  the GitHub release, verify SHA-256 before installing to the user's PATH,
  and never require admin rights.
- `nsit --version` prints the version and commit; `nsit update` is out of
  scope for v1.

## Testing

- Rust unit tests for each command's core logic on temporary repos.
- Integration tests run `nsit` against a real Insitio server started from
  this repo (the existing e2e harness) for auth, init → push → clone → pull
  round trips, conflicts and the secret guard.
- Interop: every test repo is checked with real `git fsck` and `git log`
  (git is a test-only dependency), and repos created by real git must work
  with `nsit`.
- CI runs the suite on Windows, Linux and macOS.

## Left to the builder

- Exact crate versions and feature flags, internal module layout, pack
  generation strategy, how the device-flow page looks (must use the Insitio
  theme), the exact secret-pattern regexes beyond the list above, README
  template wording.
