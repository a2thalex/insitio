import type { Context, Hono } from "hono";
import type { Deps } from "../../deps.js";
import type { Env } from "../env.js";
import { render } from "../render.js";
import { Octicon } from "../views/layout.js";

// The binaries are built by the release workflow and published to GitHub Releases under these names.
const DOWNLOADS = [
  { file: "nsit-windows-x64.exe", platform: "Windows", detail: "x64" },
  { file: "nsit-linux-x64", platform: "Linux", detail: "x64" },
  { file: "nsit-macos-arm64", platform: "macOS", detail: "Apple silicon" },
  { file: "nsit-macos-x64", platform: "macOS", detail: "Intel" },
] as const;

const releaseBase = (repo: string) => `https://github.com/${repo}/releases/latest/download`;

function CopyCommand({ command, label }: { command: string; label: string }) {
  return (
    <div class="Box d-flex flex-items-center px-3 py-2" style="gap:8px">
      <code class="text-mono f5 flex-auto" style="overflow-x:auto;white-space:nowrap">{command}</code>
      <button class="btn btn-sm flex-shrink-0" type="button" data-copy-text={command} aria-label={`Copy the ${label} install command`}>
        <Octicon name="copy" />
      </button>
    </div>
  );
}

function DownloadPage({ baseUrl, releaseRepo }: { baseUrl: string; releaseRepo: string }) {
  const base = releaseBase(releaseRepo);
  return (
    <div class="container-md p-responsive py-5" style="max-width:760px">
      <span class="eyebrow">Command-line client</span>
      <h1 class="f1 text-normal mt-1 mb-2">Download nsit</h1>
      <p class="f4 color-fg-muted mb-4">
        nsit is the Insitio command-line tool. Install it, then run <code class="text-mono">nsit auth login</code> to connect it to this server.
      </p>

      <h2 class="f3 mb-2">Install with one command</h2>
      <h3 class="f5 mt-3 mb-1">Windows (PowerShell)</h3>
      <CopyCommand label="Windows" command={`irm ${baseUrl}/install.ps1 | iex`} />
      <h3 class="f5 mt-3 mb-1">macOS and Linux</h3>
      <CopyCommand label="macOS and Linux" command={`curl -fsSL ${baseUrl}/install.sh | sh`} />
      <p class="color-fg-muted f6 mt-3 mb-5">
        Each script downloads the binary from the latest release, checks its SHA-256 checksum and stops if it does not match.
        Nothing needs admin rights: nsit goes to <code class="text-mono">%LOCALAPPDATA%\Programs\nsit</code> on Windows and to{" "}
        <code class="text-mono">~/.local/bin</code> on macOS and Linux. Want to read a script first?{" "}
        <a href="/install.ps1">install.ps1</a> · <a href="/install.sh">install.sh</a>
      </p>

      <h2 class="f3 mb-2">Download a binary</h2>
      <div class="Box mb-2">
        {DOWNLOADS.map((d) => (
          <div class="Box-row d-flex flex-items-center">
            <div class="flex-auto min-width-0">
              <a class="text-bold" href={`${base}/${d.file}`}>{d.platform}</a>
              <span class="color-fg-muted"> · {d.detail}</span>
              <div class="text-mono f6 color-fg-muted">{d.file}</div>
            </div>
            <a class="btn btn-sm flex-shrink-0" href={`${base}/${d.file}`} aria-label={`Download ${d.file}`}>
              <Octicon name="download" class="mr-1" />Download
            </a>
          </div>
        ))}
      </div>
      <p class="color-fg-muted f6 mb-2">
        Checksums for every file are in <a href={`${base}/SHA256SUMS`}>SHA256SUMS</a>. Download it next to the binary and check that one file
        (macOS: use the line for your Mac). Older versions are on the <a href={`https://github.com/${releaseRepo}/releases`}>releases page</a>.
      </p>
      <div class="Box px-3 py-2 mb-5 f6" style="overflow-x:auto">
        <code class="text-mono d-block" style="white-space:nowrap">grep nsit-linux-x64 SHA256SUMS | sha256sum -c</code>
        <code class="text-mono d-block" style="white-space:nowrap">grep nsit-macos-arm64 SHA256SUMS | shasum -a 256 -c</code>
        <code class="text-mono d-block" style="white-space:nowrap">grep nsit-macos-x64 SHA256SUMS | shasum -a 256 -c</code>
        <code class="text-mono d-block" style="white-space:nowrap">Get-FileHash .\nsit-windows-x64.exe</code>
        <span class="color-fg-muted">On Windows, compare the hash with the nsit-windows-x64.exe line in SHA256SUMS.</span>
      </div>

      <h2 class="f3 mb-2">Connect it</h2>
      <p class="mb-2">
        Run <code class="text-mono">nsit auth login</code> in your terminal. It shows a short code to approve in your browser, so no password or token is typed
        into the terminal.
      </p>
    </div>
  );
}

// Written as String.raw so backslashes stay literal; the bodies must not contain
// a dollar sign followed by a brace or a backtick, which a template literal would interpolate.

/** PowerShell installer for Windows PowerShell 5.1 and PowerShell 7. Runs as `irm <url> | iex`, so it never calls `exit`. */
export function installPs1(releaseRepo: string): string {
  return String.raw`# nsit installer for Windows. Works in Windows PowerShell 5.1 and PowerShell 7.
#
# Downloads nsit-windows-x64.exe from the latest release, checks its SHA-256 against
# SHA256SUMS, installs it to %LOCALAPPDATA%\Programs\nsit\nsit.exe and adds that folder
# to your user PATH. No administrator rights are needed.

& {
    $ErrorActionPreference = "Stop"
    $ProgressPreference = "SilentlyContinue"

    # Windows PowerShell 5.1 does not offer TLS 1.2 by default, and GitHub requires it.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    if (-not [Environment]::Is64BitOperatingSystem) {
        throw "nsit is only built for 64-bit Windows, and this is a 32-bit system. Nothing was installed."
    }

    $releaseUrl = "${releaseBase(releaseRepo)}"
    $asset = "nsit-windows-x64.exe"

    if (-not $env:LOCALAPPDATA) { throw "LOCALAPPDATA is not set, so there is nowhere to install nsit." }
    $installDir = Join-Path $env:LOCALAPPDATA "Programs\nsit"
    $exe = Join-Path $installDir "nsit.exe"

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("nsit-install-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $assetFile = Join-Path $tmp $asset
        $sumsFile = Join-Path $tmp "SHA256SUMS"

        Write-Host "Downloading $asset ..."
        foreach ($download in @(@($asset, $assetFile), @("SHA256SUMS", $sumsFile))) {
            $url = "$releaseUrl/" + $download[0]
            try {
                Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $download[1]
            } catch {
                throw "Could not download $url ($($_.Exception.Message))"
            }
        }

        # Each SHA256SUMS line is "<hex>  <file name>", with an optional * before the name.
        # The first line for the asset wins, as in install.sh.
        $expected = $null
        foreach ($line in (Get-Content -LiteralPath $sumsFile)) {
            if (-not $expected -and $line -match '^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $asset) {
                $expected = $Matches[1].ToLowerInvariant()
            }
        }
        if (-not $expected) { throw "SHA256SUMS has no entry for $asset. Nothing was installed." }

        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $assetFile).Hash.ToLowerInvariant()
        if ($actual -ne $expected) {
            throw "Checksum mismatch for $asset (expected $expected, got $actual). Nothing was installed."
        }

        New-Item -ItemType Directory -Force -Path $installDir | Out-Null
        try {
            Copy-Item -LiteralPath $assetFile -Destination $exe -Force
        } catch {
            throw "Could not write $exe. If nsit is running, close it and run this again. ($($_.Exception.Message))"
        }
        Write-Host "Installed $exe"

        # Add the folder to the user PATH (never the system one), once. The registry is edited
        # directly: the .NET accessors expand %VARIABLE% entries and save them back expanded,
        # which would freeze entries like %JAVA_HOME%\bin. Reading the raw value and writing it
        # back as REG_EXPAND_SZ leaves every existing entry exactly as it was.
        $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
        if (-not $envKey) { throw "Could not open HKCU\Environment to update your user PATH." }
        $onPath = $false
        try {
            # A missing Path value reads as empty and is created below.
            $rawPath = [string]$envKey.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $entries = @()
            if ($rawPath) { $entries = @($rawPath.Split(";") | Where-Object { $_ -ne "" }) }
            foreach ($entry in $entries) {
                # Compare expanded, ignoring case and a trailing backslash.
                if ([Environment]::ExpandEnvironmentVariables($entry).TrimEnd("\") -ieq $installDir.TrimEnd("\")) { $onPath = $true }
            }
            if (-not $onPath) {
                $newPath = (@($entries) + $installDir) -join ";"
                $envKey.SetValue("Path", $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
            }
        } finally {
            $envKey.Close()
        }
        if (-not $onPath) {
            # Writing the registry does not tell running programs. Setting and clearing a throwaway
            # user variable makes Windows broadcast WM_SETTINGCHANGE, so new shells see the new PATH.
            [Environment]::SetEnvironmentVariable("NSIT_INSTALL_TMP", "1", "User")
            [Environment]::SetEnvironmentVariable("NSIT_INSTALL_TMP", $null, "User")
            Write-Host "Added $installDir to your user PATH. Terminals opened from now on will find nsit."
        }
        # Let this window find nsit straight away too.
        $sessionHasIt = $false
        foreach ($entry in $env:Path.Split(";")) {
            if ($entry.TrimEnd("\") -ieq $installDir.TrimEnd("\")) { $sessionHasIt = $true }
        }
        if (-not $sessionHasIt) { $env:Path = "$env:Path;$installDir" }

        & $exe --version
        if ($LASTEXITCODE -ne 0) { throw "$exe was installed but did not run (code $LASTEXITCODE)." }
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
`;
}

/** POSIX sh installer for Linux and macOS. Runs as `curl ... | sh`, so everything sits in main(), called on the last line. */
export function installSh(releaseRepo: string): string {
  return String.raw`#!/bin/sh
# nsit installer for Linux and macOS. Plain POSIX sh.
#
# Downloads the nsit binary for this machine from the latest release, checks its
# SHA-256 against SHA256SUMS and installs it to ~/.local/bin/nsit. No root access is needed.

set -e

RELEASE_URL="${releaseBase(releaseRepo)}"

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'nsit install: %s\n' "$*" >&2
  exit 1
}

# Everything runs inside main, which is only called on the last line, so a connection
# that drops while this script is piped into sh cannot run half of it.
main() {
  [ -n "$HOME" ] || fail "HOME is not set, so there is nowhere to install nsit"

  # Pick the release asset for this machine. Anything else is refused rather than guessed.
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Linux) os_id=linux ;;
    Darwin) os_id=macos ;;
    *) fail "unsupported OS: $os (this script supports Linux and macOS; on Windows use install.ps1)" ;;
  esac
  case "$arch" in
    x86_64|amd64) arch_id=x64 ;;
    arm64|aarch64) arch_id=arm64 ;;
    *) fail "unsupported CPU: $arch (nsit is built for x86_64 and arm64)" ;;
  esac
  case "$os_id-$arch_id" in
    linux-x64) asset=nsit-linux-x64 ;;
    macos-arm64) asset=nsit-macos-arm64 ;;
    macos-x64) asset=nsit-macos-x64 ;;
    *) fail "there is no nsit build for $os on $arch yet (available: Linux x64, macOS arm64, macOS x64)" ;;
  esac

  # Find the tools before downloading anything.
  if command -v curl >/dev/null 2>&1; then
    # HTTPS only, even across redirects, and TLS 1.2 or newer.
    fetch() { curl --proto '=https' --tlsv1.2 -fsSL "$1"; }
  elif command -v wget >/dev/null 2>&1; then
    # BusyBox wget has no --https-only, so only pass it when wget lists it.
    if wget --help 2>&1 | grep -q -e '--https-only'; then
      fetch() { wget --https-only -qO- "$1"; }
    else
      fetch() { wget -qO- "$1"; }
    fi
  else
    fail "curl or wget is required to download nsit"
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    sha256="shasum -a 256"
  else
    fail "sha256sum or shasum is required to verify the download"
  fi

  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t nsit) || fail "could not create a temporary directory"
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 1' HUP INT TERM

  say "Downloading $asset ..."
  fetch "$RELEASE_URL/$asset" > "$tmp/$asset" || fail "could not download $RELEASE_URL/$asset"
  fetch "$RELEASE_URL/SHA256SUMS" > "$tmp/SHA256SUMS" || fail "could not download $RELEASE_URL/SHA256SUMS"

  # Each SHA256SUMS line is "<hex>  <file name>", with an optional * before the name.
  expected=$(tr -d '\r' < "$tmp/SHA256SUMS" | awk -v name="$asset" '{ n = $2; sub(/^\*/, "", n); if (n == name) { print $1; exit } }' | tr 'A-F' 'a-f')
  [ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset"

  actual=$($sha256 "$tmp/$asset" | cut -d ' ' -f 1)
  if [ "$actual" != "$expected" ]; then
    printf 'nsit install: checksum mismatch for %s\n  expected %s\n  actual   %s\nNothing was installed.\n' "$asset" "$expected" "$actual" >&2
    exit 1
  fi

  # Stage next to the target and rename, so replacing a running nsit works.
  bin_dir="$HOME/.local/bin"
  mkdir -p "$bin_dir" || fail "could not create $bin_dir"
  staged="$bin_dir/.nsit.$$"
  cp "$tmp/$asset" "$staged" || { rm -f "$staged"; fail "could not write to $bin_dir"; }
  chmod 755 "$staged" || { rm -f "$staged"; fail "could not make $staged executable"; }
  mv -f "$staged" "$bin_dir/nsit" || { rm -f "$staged"; fail "could not install $bin_dir/nsit"; }
  say "Installed $bin_dir/nsit"

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *)
      say ""
      say "$bin_dir is not on your PATH. To run nsit from anywhere, add this line to ~/.profile, ~/.bashrc or ~/.zshrc:"
      say "  export PATH=\"$bin_dir:\$PATH\""
      say ""
      ;;
  esac

  "$bin_dir/nsit" --version || fail "$bin_dir/nsit was installed but did not run on this system"
}

main "$@"
`;
}

/** The /download page and the two install scripts it advertises. Public: none of it needs a session. */
export function downloadRoutes(deps: Deps, app: Hono<Env>) {
  const { baseUrl, releaseRepo } = deps.config;
  const script = (c: Context<Env>, body: string) =>
    c.body(body, 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" });

  app.get("/download", (c) => render(c, "Download nsit", <DownloadPage baseUrl={baseUrl} releaseRepo={releaseRepo} />));
  app.get("/install.ps1", (c) => script(c, installPs1(releaseRepo)));
  app.get("/install.sh", (c) => script(c, installSh(releaseRepo)));
}
