import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { now, tx } from "../db/db.js";
import type { Deps } from "../deps.js";
import { GitError } from "../git/run.js";
import { gitFor, type RepoRow } from "./repos.js";
import { ValidationError } from "./errors.js";
import type { User } from "./users.js";
import { authorFor } from "./repos.js";

export type MakeLatest = "true" | "false" | "legacy";

export type Release = {
  id: number;
  repoId: number;
  tag: string;
  target: string;
  title: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  makeLatest: MakeLatest;
  authorId: number;
  author: string;
  createdAt: number;
  publishedAt: number | null;
};

export type ReleaseAsset = {
  id: number;
  releaseId: number;
  name: string;
  size: number;
  contentType: string;
  downloadCount: number;
  createdAt: number;
};

export type ReleaseInput = {
  tag: string;
  target: string;
  title: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  /** Checked "Set as the latest release". */
  setLatest: boolean;
};

type Row = Record<string, any>;

const SELECT = `select rel.*, u.username as author_name from releases rel join users u on u.id = rel.author_id`;

export const RELEASE_ASSET_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const TAGS_PER_PAGE = 30;
export const RELEASES_PER_PAGE = 30;

function toRelease(row: Row): Release {
  return {
    id: row.id,
    repoId: row.repo_id,
    tag: row.tag,
    target: row.target,
    title: row.title,
    body: row.body,
    draft: !!row.draft,
    prerelease: !!row.prerelease,
    makeLatest: row.make_latest,
    authorId: row.author_id,
    author: row.author_name,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

export function assetDisplayName(name: string): string {
  const base = (name.split(/[/\\]/).pop() ?? "").replace(/[\0\r\n]/g, "").trim();
  if (!base || base === "." || base === ".." || base.length > 255) throw new ValidationError("Choose a file name that is not a path.");
  return base;
}

/** On-disk bytes for one asset. The name is the numeric id, never the uploader's filename. */
export function releaseAssetPath(dataDir: string, repoId: number, releaseId: number, assetId: number): string {
  for (const id of [repoId, releaseId, assetId]) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("bad release asset id");
  }
  return join(dataDir, "releases", String(repoId), String(releaseId), String(assetId));
}

export function releaseDir(dataDir: string, repoId: number, releaseId: number): string {
  if (!Number.isSafeInteger(repoId) || repoId < 1 || !Number.isSafeInteger(releaseId) || releaseId < 1) throw new Error("bad release id");
  return join(dataDir, "releases", String(repoId), String(releaseId));
}

function cleanTag(tag: string): string {
  const value = tag.trim();
  if (!value || value.length > 250) throw new ValidationError("Choose a tag name.");
  return value;
}

function cleanInput(input: ReleaseInput, fallbackTarget: string): ReleaseInput & { tag: string; title: string } {
  const title = input.title.trim();
  if (!title) throw new ValidationError("A release needs a title.");
  if (title.length > 250) throw new ValidationError("The title is too long.");
  if (input.body.length > 100_000) throw new ValidationError("The release notes are too long.");
  return { ...input, tag: cleanTag(input.tag), title, target: input.target.trim() || fallbackTarget };
}

async function ensureTag(deps: Deps, repo: RepoRow, user: User, tag: string, target: string, title: string): Promise<void> {
  const git = gitFor(deps, repo);
  let exists = false;
  try {
    exists = await git.hasRef("tags", tag);
  } catch (err) {
    if (err instanceof GitError) throw new ValidationError("That tag name is not allowed.");
    throw err;
  }
  if (exists) return;
  if (!(await git.resolve(target))) throw new ValidationError("Choose a branch or commit for the new tag.");
  try {
    await git.createTag(tag, target, title, authorFor(user, deps.config.baseUrl));
  } catch (err) {
    if (err instanceof GitError && err.stderr.includes("invalid tag")) throw new ValidationError("That tag name is not allowed.");
    if (err instanceof GitError && err.stderr.includes("tag exists")) return;
    if (err instanceof GitError && err.stderr.includes("target not found")) throw new ValidationError("Choose a branch or commit for the new tag.");
    throw err;
  }
}

function pinLatest(db: DatabaseSync, repoId: number, releaseId: number, setLatest: boolean): MakeLatest {
  if (!setLatest) return "false";
  db.prepare("update releases set make_latest = 'legacy' where repo_id = ? and id != ? and make_latest = 'true'").run(repoId, releaseId);
  return "true";
}

export async function createRelease(deps: Deps, repo: RepoRow, user: User, input: ReleaseInput): Promise<Release> {
  const clean = cleanInput(input, repo.defaultBranch);
  if (getReleaseByTag(deps.db, repo.id, clean.tag)) throw new ValidationError(`A release for ${clean.tag} already exists.`);
  if (!clean.draft) await ensureTag(deps, repo, user, clean.tag, clean.target, clean.title);
  const publishedAt = clean.draft ? null : now();
  let id: number;
  try {
    id = tx(deps.db, () => {
    const res = deps.db
      .prepare(
        `insert into releases (repo_id, tag, target, title, body, draft, prerelease, make_latest, author_id, created_at, published_at)
         values (?, ?, ?, ?, ?, ?, ?, 'legacy', ?, ?, ?)`,
      )
      .run(repo.id, clean.tag, clean.target, clean.title, clean.body, clean.draft ? 1 : 0, clean.prerelease ? 1 : 0, user.id, now(), publishedAt);
    const releaseId = Number(res.lastInsertRowid);
    const latest = pinLatest(deps.db, repo.id, releaseId, clean.setLatest);
    deps.db.prepare("update releases set make_latest = ? where id = ?").run(latest, releaseId);
    return releaseId;
  });
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw new ValidationError(`A release for ${clean.tag} already exists.`);
    throw err;
  }
  return getReleaseById(deps.db, id)!;
}

export async function updateRelease(deps: Deps, repo: RepoRow, user: User, release: Release, input: ReleaseInput): Promise<Release> {
  const clean = cleanInput(input, release.target || repo.defaultBranch);
  const other = getReleaseByTag(deps.db, repo.id, clean.tag);
  if (other && other.id !== release.id) throw new ValidationError(`A release for ${clean.tag} already exists.`);
  if (!clean.draft) await ensureTag(deps, repo, user, clean.tag, clean.target, clean.title);
  const publishedAt = clean.draft ? null : (release.publishedAt ?? now());
  tx(deps.db, () => {
    const latest = pinLatest(deps.db, repo.id, release.id, clean.setLatest);
    deps.db
      .prepare(
        `update releases set tag = ?, target = ?, title = ?, body = ?, draft = ?, prerelease = ?, make_latest = ?, published_at = ?
         where id = ?`,
      )
      .run(clean.tag, clean.target, clean.title, clean.body, clean.draft ? 1 : 0, clean.prerelease ? 1 : 0, latest, publishedAt, release.id);
  });
  return getReleaseById(deps.db, release.id)!;
}

export async function deleteRelease(deps: Deps, repo: RepoRow, release: Release): Promise<void> {
  deps.db.prepare("delete from releases where id = ?").run(release.id);
  await rm(releaseDir(deps.config.dataDir, repo.id, release.id), { recursive: true, force: true });
}

export function getReleaseById(db: DatabaseSync, id: number): Release | null {
  const row = db.prepare(`${SELECT} where rel.id = ?`).get(id) as Row | undefined;
  return row ? toRelease(row) : null;
}

export function getReleaseByTag(db: DatabaseSync, repoId: number, tag: string): Release | null {
  const row = db.prepare(`${SELECT} where rel.repo_id = ? and rel.tag = ?`).get(repoId, tag) as Row | undefined;
  return row ? toRelease(row) : null;
}

export function listReleases(db: DatabaseSync, repoId: number, opts: { includeDrafts: boolean; page: number }): { items: Release[]; total: number } {
  const where = opts.includeDrafts ? "rel.repo_id = ?" : "rel.repo_id = ? and rel.draft = 0";
  const total = Number((db.prepare(`select count(*) as n from releases rel where ${where}`).get(repoId) as Row).n);
  const page = Math.max(1, opts.page);
  const rows = db
    .prepare(`${SELECT} where ${where} order by rel.draft desc, coalesce(rel.published_at, rel.created_at) desc limit ? offset ?`)
    .all(repoId, RELEASES_PER_PAGE, (page - 1) * RELEASES_PER_PAGE) as Row[];
  return { items: rows.map(toRelease), total };
}

/** The release "latest" points at: an explicit one, otherwise the newest stable release. */
export function latestRelease(db: DatabaseSync, repoId: number): Release | null {
  const pinned = db
    .prepare(`${SELECT} where rel.repo_id = ? and rel.draft = 0 and rel.make_latest = 'true' order by rel.published_at desc limit 1`)
    .get(repoId) as Row | undefined;
  if (pinned) return toRelease(pinned);
  const auto = db
    .prepare(
      `${SELECT} where rel.repo_id = ? and rel.draft = 0 and rel.prerelease = 0 and rel.make_latest != 'false'
       order by rel.published_at desc limit 1`,
    )
    .get(repoId) as Row | undefined;
  return auto ? toRelease(auto) : null;
}

export function releaseNamesByTag(db: DatabaseSync, repoId: number): Map<string, string> {
  const rows = db.prepare("select tag, title from releases where repo_id = ? and draft = 0").all(repoId) as { tag: string; title: string }[];
  return new Map(rows.map((row) => [row.tag, row.title]));
}

export function listAssets(db: DatabaseSync, releaseId: number): ReleaseAsset[] {
  return (db.prepare("select * from release_assets where release_id = ? order by name collate nocase").all(releaseId) as Row[]).map(toAsset);
}

export function getAssetByName(db: DatabaseSync, releaseId: number, name: string): ReleaseAsset | null {
  const row = db.prepare("select * from release_assets where release_id = ? and name = ?").get(releaseId, name) as Row | undefined;
  return row ? toAsset(row) : null;
}

function toAsset(row: Row): ReleaseAsset {
  return {
    id: row.id,
    releaseId: row.release_id,
    name: row.name,
    size: row.size,
    contentType: row.content_type,
    downloadCount: row.download_count,
    createdAt: row.created_at,
  };
}

export function recordDownload(db: DatabaseSync, assetId: number): void {
  db.prepare("update release_assets set download_count = download_count + 1 where id = ?").run(assetId);
}

/**
 * Moves an already-written temp file into the asset store under its new id.
 * `tempPath` must sit in the release directory so the rename stays on one volume.
 */
export async function attachAsset(deps: Deps, repo: RepoRow, release: Release, tempPath: string, name: string, size: number, contentType: string): Promise<ReleaseAsset> {
  const display = assetDisplayName(name);
  if (getAssetByName(deps.db, release.id, display)) throw new ValidationError(`An asset named ${display} is already attached to this release.`);
  const id = Number(
    deps.db
      .prepare("insert into release_assets (release_id, name, size, content_type, download_count, created_at) values (?, ?, ?, ?, 0, ?)")
      .run(release.id, display, size, contentType, now()).lastInsertRowid,
  );
  const dest = releaseAssetPath(deps.config.dataDir, repo.id, release.id, id);
  try {
    await mkdir(releaseDir(deps.config.dataDir, repo.id, release.id), { recursive: true });
    await rename(tempPath, dest);
  } catch (err) {
    deps.db.prepare("delete from release_assets where id = ?").run(id);
    throw err;
  }
  return getAssetByName(deps.db, release.id, display)!;
}

export function partialAssetPath(dataDir: string, repoId: number, releaseId: number): string {
  return join(releaseDir(dataDir, repoId, releaseId), `partial-${randomBytes(8).toString("hex")}`);
}

export async function deleteAsset(deps: Deps, repo: RepoRow, asset: ReleaseAsset): Promise<void> {
  deps.db.prepare("delete from release_assets where id = ?").run(asset.id);
  await rm(releaseAssetPath(deps.config.dataDir, repo.id, asset.releaseId, asset.id), { force: true });
}
