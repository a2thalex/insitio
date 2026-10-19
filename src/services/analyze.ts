import type { DatabaseSync } from "node:sqlite";
import type { Deps } from "../deps.js";
import type { Contributor } from "../git/repo.js";
import { gitFor, type RepoRow } from "./repos.js";
import { languageShares, type LanguageShare } from "./languages.js";
import { detectLicense, licenseFilename } from "./licenses.js";

export type Analysis = {
  languages: LanguageShare[];
  /** SPDX id, or "" when there is no recognized license. */
  licenseId: string;
  /** Root license filename, or "" when the repo has none. Set with an empty id means "View license". */
  licensePath: string;
  contributors: Contributor[];
};

type Row = { languages_json: string; license_id: string; license_path: string; contributors_json: string };

function fromRow(row: Row): Analysis {
  return {
    languages: JSON.parse(row.languages_json) as LanguageShare[],
    licenseId: row.license_id,
    licensePath: row.license_path,
    contributors: JSON.parse(row.contributors_json) as Contributor[],
  };
}

const EMPTY: Analysis = { languages: [], licenseId: "", licensePath: "", contributors: [] };

/** Languages, license and contributors for one commit. Computed once, then read back. */
export async function repoAnalysis(deps: Deps, repo: RepoRow, sha: string): Promise<Analysis> {
  const db: DatabaseSync = deps.db;
  const cached = db.prepare("select * from repo_analyses where repo_id = ? and commit_sha = ?").get(repo.id, sha) as Row | undefined;
  if (cached) return fromRow(cached);
  try {
    const git = gitFor(deps, repo);
    const files = await git.listFiles(sha);
    const languages = languageShares(files);
    const rootNames = (await git.tree(sha, "")).map((entry) => entry.name);
    const licensePath = licenseFilename(rootNames) ?? "";
    let licenseId = "";
    if (licensePath) {
      const blob = await git.blob(sha, licensePath, 64 * 1024);
      licenseId = detectLicense(blob.content.toString("utf8")) ?? "";
    }
    const contributors = await git.contributors(sha);
    const analysis: Analysis = { languages, licenseId, licensePath, contributors };
    db.prepare(
      `insert or ignore into repo_analyses (repo_id, commit_sha, languages_json, license_id, license_path, contributors_json)
       values (?, ?, ?, ?, ?, ?)`,
    ).run(repo.id, sha, JSON.stringify(languages), licenseId, licensePath, JSON.stringify(contributors));
    return analysis;
  } catch (err) {
    console.error(err);
    return EMPTY;
  }
}
