# REA findings: how GitHub's `gh` CLI is built

Date: 2026-10-18. Target: `C:\Program Files\GitHub CLI\gh.exe`, gh 2.83.2.
Tools: REA `inspect-go-binary` and `inspect-artifact` (static, no execution of the
target), plus `gh help` output for the command tree. Raw evidence is in
`docs/rea-evidence/gh/` (gitignored).

## Build (observed, `inspect-go-binary`)

- Go 1.25.5, main package `github.com/cli/cli/v2/cmd/gh`, revision
  `560ea94fc7d6`, built 2025-12-10, Windows amd64, CGO on, stripped (`-s -w`).
- 221 module dependencies. Version and date are injected at link time
  (`-X …/internal/build.Version`).

## Architecture (inferred from the dependency list)

| Concern | Library in gh | What it tells us |
|---|---|---|
| Command tree and flags | `spf13/cobra`, `spf13/pflag` | Noun-verb commands (`gh pr merge`) with shared global flags |
| Login | `cli/oauth` (device flow), `cli/browser` | `gh auth login` shows a one-time code and opens the browser; no password typed into the terminal |
| Token storage | `zalando/go-keyring` | Tokens live in the OS keychain (Windows Credential Manager, macOS Keychain), with a config-file fallback |
| API access | `cli/go-gh`, `shurcooL/githubv4` (GraphQL), REST | Every command is a thin client over the server API; `gh api` exposes raw requests |
| Output filtering | `itchyny/gojq` | `--json fields` + `--jq` / `--template` on list and view commands |
| Terminal UI | `charmbracelet/huh`, `bubbletea`, `lipgloss`, `survey`, `briandowns/spinner` | Interactive prompts when a TTY is attached, plain output when piped (`mattn/go-isatty`, `termenv`) |
| Markdown in terminal | `charmbracelet/glamour`, `yuin/goldmark` (+ emoji) | Issue and PR bodies render as formatted text |
| Git integration | `cli/safeexec`, shell quoting | Shells out to the user's `git` for clone, checkout, credential setup |
| Debugging | `henvic/httpretty` | `GH_DEBUG=api` prints HTTP traffic |
| Other | `sigstore/*`, `microsoft/dev-tunnels` | Attestation verification and Codespaces (out of scope for Insitio) |

## Command tree (observed, `gh help`)

- **Core:** `auth`, `browse`, `issue`, `pr`, `repo`, `release`, `gist`, `org`, `project`, `codespace`
- **Actions:** `run`, `workflow`, `cache`
- **Additional:** `api`, `alias`, `config`, `extension`, `label`, `search`, `secret`, `variable`, `ssh-key`, `gpg-key`, `ruleset`, `status`, `completion`, `attestation`
- `auth`: login, logout, refresh, setup-git, status, switch, token
- `repo`: create, list, view, clone, fork, sync, edit, rename, archive, unarchive, delete, deploy-key, set-default, autolink, gitignore, license
- `issue`: create, list, status, view, comment, edit, close, reopen, delete, lock, unlock, pin, unpin, transfer, develop
- `pr`: create, list, status, view, checkout, diff, checks, comment, review, edit, ready, merge, update-branch, close, reopen, revert, lock, unlock
- `release`: create, list, view, edit, upload, download, delete, delete-asset, verify, verify-asset

## Reference 2: Jujutsu (`jj`), a git-compatible CLI in Rust

Target: `jj-v0.46.0-x86_64-pc-windows-msvc.zip` from the official jj-vcs/jj
release (SHA-256 `c42316b1…999b83`, matches GitHub's published digest);
`jj.exe` is 30 MB. Raw evidence in `docs/rea-evidence/jj/` (gitignored).

- **REA `inspect-rust-binary`** (observed): no cargo-auditable dependency
  metadata is embedded; rustc commit `b940084d7eb6` (inferred from embedded
  paths).
- **Crate inventory** (observed, recovered from 153 cargo registry paths left
  in panic locations): `gix` 0.88 with ~40 `gix-*` crates (odb, pack, index,
  ref, diff, worktree, config, filter, ignore, attributes, discover), `clap`
  4.6 (+ completions, man pages), `crossterm` + `ratatui` (terminal UI),
  `sapling-streampager` (pager), `sapling-renderdag` (graph log), `tokio`,
  `rayon`, `serde_json`, `pest` (revset language), `watchman_client`,
  `zlib-rs`, `sha1dc`.
- **Not present:** `gix-transport`, `gix-protocol`, `gix-credentials`, `curl`,
  `reqwest`; `gix-command` is present. Inference: jj does all local repository
  work in pure Rust through gitoxide but runs the user's `git` for fetch and
  push, so jj alone does not work for remotes on a machine without git.

## What this means for an Insitio CLI

1. Insitio needs a JSON API first. Today the web app serves HTML (plus the
   `/tree-commit-info/` JSON); `gh` is only a client of GitHub's API.
2. Login should be a device flow with keychain storage, so the CLI never asks
   for a password and the token is the same kind the web settings page issues.
3. Commands should follow `gh`'s noun-verb shape and flag names, so people who
   know `gh` already know `insitio`.
4. `--json`/`--jq` output and TTY-aware formatting are what make `gh`
   scriptable; they belong in the first version.
5. A git CLI that works without git installed can follow jj's local design
   (gitoxide for everything on disk) but must also do the network side itself:
   gitoxide's HTTP transport for clone/fetch, plus a receive-pack client for
   push, which gitoxide does not provide.
