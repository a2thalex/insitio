import type { DatabaseSync } from "node:sqlite";
import { now, tx } from "../db/db.js";
import { ValidationError } from "./errors.js";
import { notify } from "./notifications.js";

type Row = Record<string, any>;

export type WikiPage = { slug: string; title: string; body: string; updatedAt: number };
export type Discussion = {
  id: number;
  number: number;
  authorId: number;
  author: string;
  category: "general" | "ideas" | "q-and-a";
  title: string;
  body: string;
  state: "open" | "closed";
  createdAt: number;
};
export type DiscussionComment = { id: number; author: string; body: string; createdAt: number };
export type Project = { id: number; name: string };
export type ProjectColumn = { id: number; name: string; position: number; cards: { id: number; title: string; issueNumber: number | null }[] };
export type Advisory = { id: number; title: string; severity: string; summary: string; published: boolean; createdAt: number };
export type ActionRun = { id: number; name: string; headSha: string; status: string; conclusion: string | null; createdAt: number };

const CATEGORIES = new Set(["general", "ideas", "q-and-a"]);
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const RUN_STATUS = new Set(["queued", "in_progress", "completed"]);
const RUN_CONCLUSION = new Set(["success", "failure", "cancelled"]);

export function wikiSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
    throw new ValidationError("Page names use letters, numbers, and single hyphens.");
  }
  return slug;
}

export function listWiki(db: DatabaseSync, repoId: number): WikiPage[] {
  return (db.prepare("select slug, title, body, updated_at from wiki_pages where repo_id = ? order by slug").all(repoId) as Row[]).map(toWiki);
}

export function getWiki(db: DatabaseSync, repoId: number, slug: string): WikiPage | null {
  const row = db.prepare("select slug, title, body, updated_at from wiki_pages where repo_id = ? and slug = ?").get(repoId, slug) as Row | undefined;
  return row ? toWiki(row) : null;
}

export function saveWiki(db: DatabaseSync, repoId: number, slug: string, title: string, body: string, userId: number): void {
  const cleanTitle = title.trim().slice(0, 120);
  if (!cleanTitle) throw new ValidationError("A page needs a title.");
  if (body.length > 100_000) throw new ValidationError("A wiki page can be at most 100,000 characters.");
  const existing = getWiki(db, repoId, slug);
  if (!existing) {
    const count = (db.prepare("select count(*) as n from wiki_pages where repo_id = ?").get(repoId) as Row).n as number;
    if (count >= 100) throw new ValidationError("This repository already has 100 wiki pages.");
  }
  db.prepare(
    `insert into wiki_pages (repo_id, slug, title, body, updated_by, updated_at) values (?, ?, ?, ?, ?, ?)
     on conflict (repo_id, slug) do update set title = excluded.title, body = excluded.body, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(repoId, slug, cleanTitle, body, userId, now());
}

function toWiki(row: Row): WikiPage {
  return { slug: row.slug, title: row.title, body: row.body, updatedAt: row.updated_at };
}

export function listDiscussions(db: DatabaseSync, repoId: number): Discussion[] {
  return (
    db
      .prepare(
        `select d.*, u.username as author from discussions d join users u on u.id = d.author_id
         where d.repo_id = ? order by d.number desc limit 200`,
      )
      .all(repoId) as Row[]
  ).map(toDiscussion);
}

export function getDiscussion(db: DatabaseSync, repoId: number, number: number): Discussion | null {
  const row = db
    .prepare(
      `select d.*, u.username as author from discussions d join users u on u.id = d.author_id
       where d.repo_id = ? and d.number = ?`,
    )
    .get(repoId, number) as Row | undefined;
  return row ? toDiscussion(row) : null;
}

export function discussionComments(db: DatabaseSync, discussionId: number): DiscussionComment[] {
  return (
    db
      .prepare(
        `select c.id, c.body, c.created_at, u.username as author from discussion_comments c
         join users u on u.id = c.author_id where c.discussion_id = ? order by c.id`,
      )
      .all(discussionId) as Row[]
  ).map((row) => ({ id: row.id, author: row.author, body: row.body, createdAt: row.created_at }));
}

export function createDiscussion(
  db: DatabaseSync,
  repo: { id: number; owner: string; name: string },
  authorId: number,
  input: { category: string; title: string; body: string },
): number {
  const category = input.category.trim();
  if (!CATEGORIES.has(category)) throw new ValidationError("Pick General, Ideas, or Q&A.");
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new ValidationError("A discussion needs a title.");
  if (input.body.length > 20_000) throw new ValidationError("A discussion can be at most 20,000 characters.");
  return tx(db, () => {
    const number = ((db.prepare("select coalesce(max(number), 0) as n from discussions where repo_id = ?").get(repo.id) as Row).n as number) + 1;
    db.prepare(
      "insert into discussions (repo_id, number, author_id, category, title, body, created_at) values (?, ?, ?, ?, ?, ?, ?)",
    ).run(repo.id, number, authorId, category, title, input.body, now());
    return number;
  });
}

export function addDiscussionComment(
  db: DatabaseSync,
  repo: { id: number; owner: string; name: string },
  discussion: Discussion,
  authorId: number,
  authorName: string,
  body: string,
): void {
  const text = body.trim();
  if (!text) throw new ValidationError("Comment can't be blank");
  if (text.length > 20_000) throw new ValidationError("A comment can be at most 20,000 characters.");
  db.prepare("insert into discussion_comments (discussion_id, author_id, body, created_at) values (?, ?, ?, ?)").run(
    discussion.id,
    authorId,
    text,
    now(),
  );
  notify(db, discussion.authorId, authorId, {
    title: `${authorName} commented on ${repo.owner}/${repo.name} discussion #${discussion.number}`,
    url: `/${repo.owner}/${repo.name}/discussions/${discussion.number}`,
    reason: "discussion",
    repoId: repo.id,
  });
}

export function setDiscussionState(db: DatabaseSync, repoId: number, number: number, state: "open" | "closed"): void {
  db.prepare("update discussions set state = ? where repo_id = ? and number = ?").run(state, repoId, number);
}

function toDiscussion(row: Row): Discussion {
  return {
    id: row.id,
    number: row.number,
    authorId: row.author_id,
    author: row.author,
    category: row.category,
    title: row.title,
    body: row.body,
    state: row.state,
    createdAt: row.created_at,
  };
}

export function listProjects(db: DatabaseSync, repoId: number): Project[] {
  return (db.prepare("select id, name from projects where repo_id = ? order by id desc limit 10").all(repoId) as Row[]).map((row) => ({
    id: row.id,
    name: row.name,
  }));
}

export function getProject(db: DatabaseSync, repoId: number, projectId: number): { project: Project; columns: ProjectColumn[] } | null {
  const project = db.prepare("select id, name from projects where repo_id = ? and id = ?").get(repoId, projectId) as Row | undefined;
  if (!project) return null;
  const columns = db.prepare("select id, name, position from project_columns where project_id = ? order by position, id").all(project.id) as Row[];
  return {
    project: { id: project.id, name: project.name },
    columns: columns.map((column) => ({
      id: column.id,
      name: column.name,
      position: column.position,
      cards: (db.prepare("select id, title, issue_number from project_cards where column_id = ? order by position, id").all(column.id) as Row[]).map(
        (card) => ({ id: card.id, title: card.title, issueNumber: card.issue_number }),
      ),
    })),
  };
}

export function createProject(db: DatabaseSync, repoId: number, name: string): number {
  const title = name.trim().slice(0, 80);
  if (!title) throw new ValidationError("A project needs a name.");
  const count = (db.prepare("select count(*) as n from projects where repo_id = ?").get(repoId) as Row).n as number;
  if (count >= 10) throw new ValidationError("A repository can have at most 10 projects.");
  return tx(db, () => {
    const id = Number(db.prepare("insert into projects (repo_id, name, created_at) values (?, ?, ?)").run(repoId, title, now()).lastInsertRowid);
    ["To do", "In progress", "Done"].forEach((column, index) => {
      db.prepare("insert into project_columns (project_id, name, position) values (?, ?, ?)").run(id, column, index);
    });
    return id;
  });
}

export function addProjectCard(db: DatabaseSync, repoId: number, columnId: number, title: string, issueNumber: number | null): void {
  const column = columnInRepo(db, repoId, columnId);
  const cards = (db.prepare("select count(*) as n from project_cards c join project_columns col on col.id = c.column_id join projects p on p.id = col.project_id where p.repo_id = ?").get(repoId) as Row).n as number;
  if (cards >= 100) throw new ValidationError("A project can have at most 100 cards.");
  const clean = title.trim().slice(0, 200);
  if (!clean) throw new ValidationError("A card needs a title.");
  const position = ((db.prepare("select coalesce(max(position), -1) as n from project_cards where column_id = ?").get(column.id) as Row).n as number) + 1;
  db.prepare("insert into project_cards (column_id, title, issue_number, position) values (?, ?, ?, ?)").run(column.id, clean, issueNumber, position);
}

export function moveProjectCard(db: DatabaseSync, repoId: number, cardId: number, columnId: number): void {
  const column = columnInRepo(db, repoId, columnId);
  const card = db
    .prepare(
      `select c.id from project_cards c join project_columns col on col.id = c.column_id join projects p on p.id = col.project_id
       where c.id = ? and p.repo_id = ?`,
    )
    .get(cardId, repoId) as Row | undefined;
  if (!card) throw new ValidationError("That card is not on this repository.");
  db.prepare("update project_cards set column_id = ? where id = ?").run(column.id, card.id);
}

function columnInRepo(db: DatabaseSync, repoId: number, columnId: number): Row {
  const column = db
    .prepare(
      `select col.id from project_columns col join projects p on p.id = col.project_id where col.id = ? and p.repo_id = ?`,
    )
    .get(columnId, repoId) as Row | undefined;
  if (!column) throw new ValidationError("That column is not on this repository.");
  return column;
}

export function listAdvisories(db: DatabaseSync, repoId: number, includeDrafts: boolean): Advisory[] {
  const where = includeDrafts ? "" : "and published = 1";
  return (db.prepare(`select * from advisories where repo_id = ? ${where} order by id desc limit 50`).all(repoId) as Row[]).map((row) => ({
    id: row.id,
    title: row.title,
    severity: row.severity,
    summary: row.summary,
    published: !!row.published,
    createdAt: row.created_at,
  }));
}

export function createAdvisory(
  db: DatabaseSync,
  repoId: number,
  userId: number,
  input: { title: string; severity: string; summary: string; published: boolean },
): void {
  const title = input.title.trim().slice(0, 120);
  if (!title) throw new ValidationError("An advisory needs a title.");
  if (!SEVERITIES.has(input.severity)) throw new ValidationError("Severity must be low, medium, high, or critical.");
  if (input.summary.length > 10_000) throw new ValidationError("A summary can be at most 10,000 characters.");
  const count = (db.prepare("select count(*) as n from advisories where repo_id = ?").get(repoId) as Row).n as number;
  if (count >= 50) throw new ValidationError("This repository already has 50 advisories.");
  db.prepare(
    "insert into advisories (repo_id, title, severity, summary, published, created_by, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run(repoId, title, input.severity, input.summary, input.published ? 1 : 0, userId, now());
}

export function recordActionRun(
  db: DatabaseSync,
  repoId: number,
  input: { name: string; headSha: string; status: string; conclusion: string | null },
): number {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new ValidationError("A run needs a name.");
  if (!/^[0-9a-f]{40}$/i.test(input.headSha)) throw new ValidationError("head_sha must be a 40-character commit id");
  if (!RUN_STATUS.has(input.status)) throw new ValidationError("status must be queued, in_progress, or completed");
  const conclusion = input.conclusion?.trim() || null;
  if (conclusion && !RUN_CONCLUSION.has(conclusion)) throw new ValidationError("conclusion must be success, failure, or cancelled");
  if (input.status !== "completed" && conclusion) throw new ValidationError("A conclusion belongs on a completed run.");
  const count = (db.prepare("select count(*) as n from action_runs where repo_id = ?").get(repoId) as Row).n as number;
  if (count >= 30) db.prepare("delete from action_runs where repo_id = ? and id = (select min(id) from action_runs where repo_id = ?)").run(repoId, repoId);
  return Number(
    db.prepare("insert into action_runs (repo_id, name, head_sha, status, conclusion, created_at) values (?, ?, ?, ?, ?, ?)").run(
      repoId,
      name,
      input.headSha.toLowerCase(),
      input.status,
      conclusion,
      now(),
    ).lastInsertRowid,
  );
}

export function listActionRuns(db: DatabaseSync, repoId: number): ActionRun[] {
  return (db.prepare("select * from action_runs where repo_id = ? order by id desc limit 30").all(repoId) as Row[]).map((row) => ({
    id: row.id,
    name: row.name,
    headSha: row.head_sha,
    status: row.status,
    conclusion: row.conclusion,
    createdAt: row.created_at,
  }));
}

const SECRET_RULES: { name: string; re: RegExp }[] = [
  { name: "Private key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: "GitHub token", re: /\bghp_[A-Za-z0-9]{20,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
];

/** Rule names only. The matched text stays in the file. */
export function secretRulesIn(text: string): string[] {
  return SECRET_RULES.filter((rule) => rule.re.test(text)).map((rule) => rule.name);
}

export function issuesOpenedSince(db: DatabaseSync, repoId: number, since: number): number {
  return (db.prepare("select count(*) as n from issues where repo_id = ? and is_pull = 0 and created_at >= ?").get(repoId, since) as Row).n as number;
}
