import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "./run.js";

export function reposRoot(dataDir: string): string {
  return join(dataDir, "repos");
}

/** On-disk location of a bare repo. Names are lowercased so lookups are case-insensitive. */
export function repoDir(dataDir: string, owner: string, name: string): string {
  return join(reposRoot(dataDir), owner.toLowerCase(), `${name.toLowerCase()}.git`);
}

export async function initBareRepo(dir: string, defaultBranch: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await runGit(dir, ["init", "--bare", "-q", `--initial-branch=${defaultBranch}`]);
  await runGit(dir, ["config", "http.receivepack", "true"]);
  await runGit(dir, ["config", "receive.denyNonFastForwards", "false"]);
}

export async function removeRepoDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
