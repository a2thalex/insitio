import { spawn, type ChildProcess } from "node:child_process";
import { GIT_ENV } from "./run.js";
import { archivePrefix } from "./paths.js";

export type ArchiveFormat = "zip" | "tar.gz";

const BASE_ARGS = ["-c", "core.quotepath=off", "-c", "core.autocrlf=false"];

/** Starts `git archive` and leaves the caller to stream stdout. The prefix is always `<repo>-<ref>/`. */
export function startArchive(dir: string, sha: string, repoName: string, refLabel: string, format: ArchiveFormat): ChildProcess {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("archive requires a full commit sha");
  const prefix = archivePrefix(repoName, refLabel);
  const gitFormat = format === "zip" ? "zip" : "tar.gz";
  return spawn("git", [...BASE_ARGS, "archive", `--format=${gitFormat}`, `--prefix=${prefix}`, sha], {
    cwd: dir,
    env: { ...process.env, ...GIT_ENV },
    windowsHide: true,
  });
}

export function archiveContentType(format: ArchiveFormat): string {
  return format === "zip" ? "application/zip" : "application/gzip";
}
