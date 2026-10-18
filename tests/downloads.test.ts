import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { testApp } from "./helpers.js";

const BASE = "https://git.iam.bot";
const DEFAULT_REPO = "a2thalex/gitfkd";
const ASSETS = ["nsit-windows-x64.exe", "nsit-linux-x64", "nsit-macos-arm64", "nsit-macos-x64"];
const releaseUrl = (repo: string, asset: string) => `https://github.com/${repo}/releases/latest/download/${asset}`;

async function text(res: Response | Promise<Response>) {
  return (await res).text();
}

/** Writes a script to a temp file so an external interpreter can check its syntax. */
function scriptFile(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "insitio-script-"));
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

function canRun(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 15_000 });
  return !r.error && r.status === 0;
}

const hasSh = canRun("sh", ["-c", "exit 0"]);
// Windows PowerShell 5.1 is the strictest target, so prefer it over PowerShell 7.
const psExe = ["powershell", "pwsh"].find((exe) => canRun(exe, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]));

describe("GET /download", () => {
  it("is reachable signed out and lists the four assets, the checksums and both one-liners", async () => {
    const t = testApp({ baseUrl: BASE });
    const res = await t.get("/download");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    for (const asset of ASSETS) expect(html).toContain(releaseUrl(DEFAULT_REPO, asset));
    expect(html).toContain(releaseUrl(DEFAULT_REPO, "SHA256SUMS"));
    expect(html).toContain("irm https://git.iam.bot/install.ps1 | iex");
    expect(html).toContain("curl -fsSL https://git.iam.bot/install.sh | sh");
    // Both commands come with a copy button.
    expect(html).toContain('data-copy-text="irm https://git.iam.bot/install.ps1 | iex"');
    expect(html).toContain('data-copy-text="curl -fsSL https://git.iam.bot/install.sh | sh"');
  });

  it("builds the one-liners from baseUrl", async () => {
    const t = testApp({ baseUrl: "https://forge.example.org" });
    const html = await text(t.get("/download"));
    expect(html).toContain("irm https://forge.example.org/install.ps1 | iex");
    expect(html).toContain("curl -fsSL https://forge.example.org/install.sh | sh");
    expect(html).not.toContain("git.iam.bot");
  });

  it("renders for a signed-in user too", async () => {
    const t = testApp({ baseUrl: BASE });
    const ada = t.loginAs(t.user("ada"));
    const res = await t.get("/download", ada);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(releaseUrl(DEFAULT_REPO, "nsit-linux-x64"));
  });

  it("points every asset at the configured release repository", async () => {
    const t = testApp({ baseUrl: BASE, releaseRepo: "me/fork" });
    const html = await text(t.get("/download"));
    for (const asset of [...ASSETS, "SHA256SUMS"]) expect(html).toContain(releaseUrl("me/fork", asset));
    expect(html).not.toContain(DEFAULT_REPO);
  });

  it("is not shadowed by a user named download", async () => {
    const t = testApp();
    expect(() => t.user("download")).toThrow(/reserved/);
  });
});

describe("GET /install.sh", () => {
  it("is plain text that is never cached, and reachable signed out", async () => {
    const t = testApp({ baseUrl: BASE });
    const res = await t.get("/install.sh");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect((await res.text()).startsWith("#!/bin/sh\n")).toBe(true);
  });

  it("picks the asset by platform and downloads from the release repository", async () => {
    const sh = await text(testApp().get("/install.sh"));
    for (const asset of ["nsit-linux-x64", "nsit-macos-arm64", "nsit-macos-x64"]) expect(sh).toContain(asset);
    expect(sh).not.toContain("nsit-windows-x64.exe");
    expect(sh).toContain(`https://github.com/${DEFAULT_REPO}/releases/latest/download`);
    expect(sh).toContain("uname -s");
    expect(sh).toContain("uname -m");
    expect(sh).toContain("x86_64|amd64");
    expect(sh).toContain("arm64|aarch64");
    // Unknown platforms are refused, not guessed.
    expect(sh).toMatch(/\*\) fail "unsupported OS/);
    expect(sh).toMatch(/\*\) fail "unsupported CPU/);
  });

  it("verifies the SHA-256 checksum and exits on a mismatch", async () => {
    const sh = await text(testApp().get("/install.sh"));
    expect(sh).toContain("SHA256SUMS");
    expect(sh).toContain("sha256sum");
    expect(sh).toContain("shasum -a 256");
    expect(sh).toContain('if [ "$actual" != "$expected" ]; then');
    // The mismatch branch ends the script before anything is installed.
    const mismatch = sh.slice(sh.indexOf('if [ "$actual" != "$expected" ]; then'));
    expect(mismatch.indexOf("exit 1")).toBeGreaterThan(0);
    expect(mismatch.indexOf("exit 1")).toBeLessThan(mismatch.indexOf("mv -f"));
    // A missing checksum entry is a failure as well.
    expect(sh).toContain('[ -n "$expected" ] || fail');
  });

  it("uses curl -fsSL, falls back to wget, never needs sudo, and installs to ~/.local/bin", async () => {
    const sh = await text(testApp().get("/install.sh"));
    expect(sh).toContain('curl -fsSL "$1"');
    expect(sh).toContain('wget -qO- "$1"');
    expect(sh).not.toMatch(/\bsudo\b/);
    expect(sh).toContain("$HOME/.local/bin");
    expect(sh).toContain("chmod 755");
    expect(sh).toContain('"$bin_dir/nsit" --version');
    expect(sh).toContain("is not on your PATH");
  });

  it("sticks to POSIX sh and ASCII", async () => {
    const sh = await text(testApp().get("/install.sh"));
    // No bash-only syntax: [[ ]], pipefail, the local and function keywords, echo -e, process substitution, source, ${var/x/y}, $RANDOM.
    expect(sh).not.toMatch(/\[\[|\bpipefail\b|^\s*local\s|\bfunction\b|echo -e|<\(|\bsource\b|\$\{[A-Za-z_]+\/|\$RANDOM/m);
    expect(sh).toMatch(/^[\x00-\x7f]*$/);
    // Wrapped in main so a connection dropped mid-pipe cannot run half a script.
    expect(sh.trimEnd().endsWith('main "$@"')).toBe(true);
  });

  it.skipIf(!hasSh)("parses with sh -n", async () => {
    const sh = await text(testApp().get("/install.sh"));
    const r = spawnSync("sh", ["-n", scriptFile("install.sh", sh)], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("changes every URL when NSIT_RELEASE_REPO is set", async () => {
    const config = loadConfig({ NSIT_RELEASE_REPO: "me/fork" } as NodeJS.ProcessEnv);
    const sh = await text(testApp({ releaseRepo: config.releaseRepo }).get("/install.sh"));
    expect(sh).toContain("https://github.com/me/fork/releases/latest/download");
    expect(sh).not.toContain(DEFAULT_REPO);
  });
});

describe("GET /install.ps1", () => {
  it("is plain text that is never cached, and reachable signed out", async () => {
    const t = testApp({ baseUrl: BASE });
    const res = await t.get("/install.ps1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("downloads the Windows asset and checks it with Get-FileHash", async () => {
    const ps = await text(testApp().get("/install.ps1"));
    expect(ps).toContain("Get-FileHash");
    expect(ps).toContain("SHA256");
    expect(ps).toContain("nsit-windows-x64.exe");
    expect(ps).toContain("SHA256SUMS");
    for (const other of ["nsit-linux-x64", "nsit-macos-arm64", "nsit-macos-x64"]) expect(ps).not.toContain(other);
    expect(ps).toContain(`https://github.com/${DEFAULT_REPO}/releases/latest/download`);
  });

  it("refuses to install when the checksum does not match", async () => {
    const ps = await text(testApp().get("/install.ps1"));
    const check = ps.indexOf("-ne $expected");
    expect(check).toBeGreaterThan(0);
    // The throw for a mismatch comes before the file is copied to the install folder.
    const afterCheck = ps.slice(check);
    expect(afterCheck.indexOf("throw")).toBeGreaterThan(0);
    expect(afterCheck.indexOf("throw")).toBeLessThan(afterCheck.indexOf("Copy-Item"));
    // `exit` would close the caller's window when run as irm | iex.
    expect(ps).not.toMatch(/\bexit\b/);
  });

  it("works in Windows PowerShell 5.1: TLS 1.2, no pipeline chains, no null operators", async () => {
    const ps = await text(testApp().get("/install.ps1"));
    expect(ps).toContain("[Net.ServicePointManager]::SecurityProtocol");
    expect(ps).toContain("Tls12");
    expect(ps).toContain("-UseBasicParsing");
    expect(ps).not.toMatch(/&&|\|\||\?\.|\?\?/);
    expect(ps).toMatch(/^[\x00-\x7f]*$/);
  });

  it("installs under LOCALAPPDATA without admin and adds the folder to the user PATH once", async () => {
    const ps = await text(testApp().get("/install.ps1"));
    expect(ps).toContain("$env:LOCALAPPDATA");
    expect(ps).toContain("Programs\\nsit");
    expect(ps).toContain("nsit.exe");
    expect(ps).toContain('[Environment]::GetEnvironmentVariable("Path", "User")');
    expect(ps).toContain('[Environment]::SetEnvironmentVariable("Path", $newPath, "User")');
    expect(ps).toContain("if (-not $onPath)");
    expect(ps).not.toMatch(/RunAs|Machine/);
    expect(ps).toContain("--version");
  });

  it.skipIf(!psExe)("parses in PowerShell", async () => {
    const ps = await text(testApp().get("/install.ps1"));
    const file = scriptFile("install.ps1", ps);
    const parse =
      "$e = $null; $t = $null; " +
      "[void][System.Management.Automation.Language.Parser]::ParseFile($env:NSIT_TEST_SCRIPT, [ref]$t, [ref]$e); " +
      "if ($e.Count -gt 0) { $e | ForEach-Object { $_.Message }; exit 1 }";
    const r = spawnSync(psExe!, ["-NoProfile", "-NonInteractive", "-Command", parse], {
      encoding: "utf8",
      env: { ...process.env, NSIT_TEST_SCRIPT: file },
      timeout: 30_000,
    });
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
  }, 40_000);

  it("changes every URL when NSIT_RELEASE_REPO is set", async () => {
    const config = loadConfig({ NSIT_RELEASE_REPO: "me/fork" } as NodeJS.ProcessEnv);
    const ps = await text(testApp({ releaseRepo: config.releaseRepo }).get("/install.ps1"));
    expect(ps).toContain("https://github.com/me/fork/releases/latest/download");
    expect(ps).not.toContain(DEFAULT_REPO);
  });
});

describe("releaseRepo config", () => {
  it("defaults to a2thalex/gitfkd", () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).releaseRepo).toBe(DEFAULT_REPO);
    expect(loadConfig({ NSIT_RELEASE_REPO: "" } as NodeJS.ProcessEnv).releaseRepo).toBe(DEFAULT_REPO);
  });

  it("reads NSIT_RELEASE_REPO", () => {
    expect(loadConfig({ NSIT_RELEASE_REPO: "me/fork" } as NodeJS.ProcessEnv).releaseRepo).toBe("me/fork");
    expect(loadConfig({ NSIT_RELEASE_REPO: " me/fork " } as NodeJS.ProcessEnv).releaseRepo).toBe("me/fork");
  });

  it("rejects values that are not owner/repo, since they end up inside shell scripts", () => {
    for (const bad of ["fork", "a/b/c", 'me/fork"; rm -rf ~; "', "me/fork name", "https://github.com/me/fork", "me/fork$(id)"]) {
      expect(() => loadConfig({ NSIT_RELEASE_REPO: bad } as NodeJS.ProcessEnv), bad).toThrow(/NSIT_RELEASE_REPO/);
    }
  });
});
