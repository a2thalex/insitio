import { spawn } from "node:child_process";

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args[0]} failed (${code}): ${stderr.trim().split("\n")[0] ?? ""}`);
  }
}

export type RunOptions = {
  input?: string | Buffer;
  env?: Record<string, string>;
  /** Stop reading and kill git once stdout exceeds this many bytes. */
  maxBytes?: number;
  /** Exit codes treated as success. */
  okCodes?: number[];
};

export const GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
};

const BASE_ARGS = ["-c", "core.quotepath=off", "-c", "core.autocrlf=false"];

/** Runs git with an argument array (never a shell) in cwd. */
export function runGit(
  cwd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<{ stdout: Buffer; code: number; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...BASE_ARGS, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, ...opts.env },
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      if (truncated) return;
      if (opts.maxBytes !== undefined && size + d.length > opts.maxBytes) {
        chunks.push(d.subarray(0, opts.maxBytes - size));
        size = opts.maxBytes;
        truncated = true;
        child.kill();
        return;
      }
      chunks.push(d);
      size += d.length;
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const ok = opts.okCodes ?? [0];
      if (truncated || (code !== null && ok.includes(code))) {
        resolve({ stdout: Buffer.concat(chunks), code: code ?? -1, truncated });
      } else {
        reject(new GitError(args, code, stderr));
      }
    });
    child.stdin.on("error", () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Rejects user-supplied refs that git could parse as options or that are malformed. */
export function assertSafeRef(ref: string): void {
  if (!ref || ref.startsWith("-") || /[\0\n\r]/.test(ref) || ref.includes("..")) {
    throw new GitError(["check-ref"], null, `invalid ref: ${JSON.stringify(ref)}`);
  }
}

/** Rejects paths that are absolute, escape the tree, or contain control characters. */
export function assertSafePath(path: string): void {
  if (path.startsWith("/") || /[\0\n\r]/.test(path) || path.split("/").some((s) => s === "..")) {
    throw new GitError(["check-path"], null, `invalid path: ${JSON.stringify(path)}`);
  }
}
