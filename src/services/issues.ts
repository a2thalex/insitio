import type { DatabaseSync } from "node:sqlite";
import { now, tx } from "../db/db.js";
import { ValidationError } from "./errors.js";

export type Label = { id: number; repoId: number; name: string; color: string };

export type Issue = {
  id: number;
  repoId: number;
  number: number;
  authorId: number;
  author: string;
  title: string;
  body: string;
  state: "open" | "closed";
  isPull: boolean;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  commentCount: number;
  labels: Label[];
};

export type Comment = { id: number; authorId: number; author: string; body: string; createdAt: number };
export type IssueEvent = { id: number; actor: string | null; kind: "closed" | "reopened" | "merged" | "head_deleted"; detail: string; createdAt: number };

type Row = Record<string, any>;

export const PER_PAGE = 25;

// GitHub's default label set.
const DEFAULT_LABELS: [string, string][] = [
  ["bug", "#d73a4a"],
  ["documentation", "#0075ca"],
  ["duplicate", "#cfd3d7"],
  ["enhancement", "#a2eeef"],
  ["good first issue", "#7057ff"],
  ["help wanted", "#008672"],
  ["question", "#d876e3"],
  ["wontfix", "#ffffff"],
];

export const ISSUE_SELECT = `select i.*, u.username as author,
  (select count(*) from comments c where c.issue_id = i.id) as comment_count
  from issues i join users u on u.id = i.author_id`;

function labelsFor(db: DatabaseSync, issueIds: number[]): Map<number, Label[]> {
  const map = new Map<number, Label[]>();
  if (!issueIds.length) return map;
  const rows = db
    .prepare(
      `select il.issue_id, l.* from issue_labels il join labels l on l.id = il.label_id
       where il.issue_id in (${issueIds.map(() => "?").join(",")}) order by l.name`,
    )
    .all(...issueIds) as Row[];
  for (const r of rows) {
    const list = map.get(r.issue_id) ?? [];
    list.push({ id: r.id, repoId: r.repo_id, name: r.name, color: r.color });
    map.set(r.issue_id, list);
  }
  return map;
}

export function toIssues(db: DatabaseSync, rows: Row[]): Issue[] {
  const labels = labelsFor(db, rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    repoId: r.repo_id,
    number: r.number,
    authorId: r.author_id,
    author: r.author,
    title: r.title,
    body: r.body,
    state: r.state,
    isPull: !!r.is_pull,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    closedAt: r.closed_at,
    commentCount: r.comment_count,
    labels: labels.get(r.id) ?? [],
  }));
}

function validateTitle(title: string): string {
  const t = title.trim();
  if (!t) throw new ValidationError("Title can't be blank");
  return t.slice(0, 256);
}

/** Inserts an issue (or the issue half of a pull request) with the repo's next number. */
export function insertIssue(db: DatabaseSync, repoId: number, authorId: number, p: { title: string; body: string; isPull: boolean }): number {
  const title = validateTitle(p.title);
  return tx(db, () => {
    db.prepare("insert or ignore into repo_counters (repo_id) values (?)").run(repoId);
    const { next_number: number } = db.prepare("select next_number from repo_counters where repo_id = ?").get(repoId) as Row;
    db.prepare("update repo_counters set next_number = next_number + 1 where repo_id = ?").run(repoId);
    const t = now();
    const res = db
      .prepare(
        "insert into issues (repo_id, number, author_id, title, body, is_pull, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(repoId, number, authorId, title, p.body.slice(0, 65536), p.isPull ? 1 : 0, t, t);
    return Number(res.lastInsertRowid);
  });
}

export function createIssue(db: DatabaseSync, repoId: number, authorId: number, p: { title: string; body: string }): Issue {
  const id = insertIssue(db, repoId, authorId, { ...p, isPull: false });
  return toIssues(db, [db.prepare(`${ISSUE_SELECT} where i.id = ?`).get(id) as Row])[0];
}

export function getIssue(db: DatabaseSync, repoId: number, number: number): Issue | null {
  const r = db.prepare(`${ISSUE_SELECT} where i.repo_id = ? and i.number = ?`).get(repoId, number) as Row | undefined;
  return r ? toIssues(db, [r])[0] : null;
}

export type IssueFilter = {
  state: "open" | "closed" | "all";
  isPull: boolean;
  labelId?: number;
  q?: string;
  page: number;
};

export function listIssues(db: DatabaseSync, repoId: number, f: IssueFilter): { items: Issue[]; total: number } {
  const where = ["i.repo_id = ?", "i.is_pull = ?"];
  const args: (string | number)[] = [repoId, f.isPull ? 1 : 0];
  if (f.state !== "all") {
    where.push("i.state = ?");
    args.push(f.state);
  }
  if (f.labelId) {
    where.push("exists (select 1 from issue_labels il where il.issue_id = i.id and il.label_id = ?)");
    args.push(f.labelId);
  }
  if (f.q?.trim()) {
    where.push("(i.title like ? escape '\\' or i.body like ? escape '\\')");
    const like = `%${f.q.trim().replace(/[%_\\]/g, (m) => "\\" + m)}%`;
    args.push(like, like);
  }
  const clause = where.join(" and ");
  const total = (db.prepare(`select count(*) as n from issues i where ${clause}`).get(...args) as Row).n;
  const rows = db
    .prepare(`${ISSUE_SELECT} where ${clause} order by i.number desc limit ? offset ?`)
    .all(...args, PER_PAGE, (Math.max(1, f.page) - 1) * PER_PAGE) as Row[];
  return { items: toIssues(db, rows), total };
}

export function countIssues(db: DatabaseSync, repoId: number, isPull: boolean): { open: number; closed: number } {
  const rows = db
    .prepare("select state, count(*) as n from issues where repo_id = ? and is_pull = ? group by state")
    .all(repoId, isPull ? 1 : 0) as Row[];
  return {
    open: rows.find((r) => r.state === "open")?.n ?? 0,
    closed: rows.find((r) => r.state === "closed")?.n ?? 0,
  };
}

export function updateIssue(db: DatabaseSync, issueId: number, p: { title: string; body: string }): void {
  db.prepare("update issues set title = ?, body = ?, updated_at = ? where id = ?").run(validateTitle(p.title), p.body.slice(0, 65536), now(), issueId);
}

export function addEvent(db: DatabaseSync, issueId: number, actorId: number, kind: IssueEvent["kind"], detail = ""): void {
  db.prepare("insert into issue_events (issue_id, actor_id, kind, detail, created_at) values (?, ?, ?, ?, ?)").run(
    issueId,
    actorId,
    kind,
    detail,
    now(),
  );
}

export function setIssueState(db: DatabaseSync, issueId: number, state: "open" | "closed", actorId: number): void {
  tx(db, () => {
    const cur = db.prepare("select state from issues where id = ?").get(issueId) as Row | undefined;
    if (!cur || cur.state === state) return;
    const t = now();
    db.prepare("update issues set state = ?, closed_at = ?, updated_at = ? where id = ?").run(state, state === "closed" ? t : null, t, issueId);
    addEvent(db, issueId, actorId, state === "closed" ? "closed" : "reopened");
  });
}

export function addComment(db: DatabaseSync, issueId: number, authorId: number, body: string): Comment {
  const text = body.trim();
  if (!text) throw new ValidationError("Comment can't be blank");
  const t = now();
  const res = db.prepare("insert into comments (issue_id, author_id, body, created_at) values (?, ?, ?, ?)").run(issueId, authorId, text.slice(0, 65536), t);
  db.prepare("update issues set updated_at = ? where id = ?").run(t, issueId);
  return listComments(db, issueId).find((c) => c.id === Number(res.lastInsertRowid))!;
}

export function listComments(db: DatabaseSync, issueId: number): Comment[] {
  return (
    db
      .prepare("select c.*, u.username as author from comments c join users u on u.id = c.author_id where c.issue_id = ? order by c.created_at, c.id")
      .all(issueId) as Row[]
  ).map((r) => ({ id: r.id, authorId: r.author_id, author: r.author, body: r.body, createdAt: r.created_at }));
}

export function listEvents(db: DatabaseSync, issueId: number): IssueEvent[] {
  return (
    db
      .prepare("select e.*, u.username as actor from issue_events e left join users u on u.id = e.actor_id where e.issue_id = ? order by e.created_at, e.id")
      .all(issueId) as Row[]
  ).map((r) => ({ id: r.id, actor: r.actor, kind: r.kind, detail: r.detail, createdAt: r.created_at }));
}

/** Participants: the author and every commenter, in order of first appearance. */
export function participants(issue: Issue, comments: Comment[]): string[] {
  return [...new Set([issue.author, ...comments.map((c) => c.author)])];
}

// Labels

function normalizeColor(color: string): string {
  const c = color.trim().replace(/^#?/, "#").toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(c)) throw new ValidationError("Color must be a hex value like #a2eeef");
  return c;
}

export function createDefaultLabels(db: DatabaseSync, repoId: number): void {
  const stmt = db.prepare("insert or ignore into labels (repo_id, name, color) values (?, ?, ?)");
  for (const [name, color] of DEFAULT_LABELS) stmt.run(repoId, name, color);
}

export function listLabels(db: DatabaseSync, repoId: number): Label[] {
  return (db.prepare("select * from labels where repo_id = ? order by name").all(repoId) as Row[]).map((r) => ({
    id: r.id,
    repoId: r.repo_id,
    name: r.name,
    color: r.color,
  }));
}

export function labelCounts(db: DatabaseSync, repoId: number): Map<number, number> {
  const rows = db
    .prepare(
      `select il.label_id, count(*) as n from issue_labels il join issues i on i.id = il.issue_id
       where i.repo_id = ? and i.state = 'open' group by il.label_id`,
    )
    .all(repoId) as Row[];
  return new Map(rows.map((r) => [r.label_id, r.n]));
}

export function createLabel(db: DatabaseSync, repoId: number, name: string, color: string): Label {
  const n = name.trim();
  if (!n || n.length > 50) throw new ValidationError("Label name must be 1–50 characters");
  const c = normalizeColor(color);
  if (db.prepare("select 1 from labels where repo_id = ? and name = ?").get(repoId, n)) {
    throw new ValidationError(`Label "${n}" already exists`);
  }
  const res = db.prepare("insert into labels (repo_id, name, color) values (?, ?, ?)").run(repoId, n, c);
  return { id: Number(res.lastInsertRowid), repoId, name: n, color: c };
}

export function deleteLabel(db: DatabaseSync, repoId: number, labelId: number): void {
  db.prepare("delete from labels where id = ? and repo_id = ?").run(labelId, repoId);
}

export function setIssueLabels(db: DatabaseSync, repoId: number, issueId: number, labelIds: number[]): void {
  tx(db, () => {
    db.prepare("delete from issue_labels where issue_id = ?").run(issueId);
    const valid = new Set(listLabels(db, repoId).map((l) => l.id));
    const stmt = db.prepare("insert or ignore into issue_labels (issue_id, label_id) values (?, ?)");
    for (const id of labelIds) if (valid.has(id)) stmt.run(issueId, id);
  });
}

/** Open issues and pull requests across the given repos, most recently updated first. */
export function recentOpenIssues(db: DatabaseSync, repoIds: number[], limit = 20): (Issue & { repoId: number })[] {
  if (!repoIds.length) return [];
  const rows = db
    .prepare(`${ISSUE_SELECT} where i.state = 'open' and i.repo_id in (${repoIds.map(() => "?").join(",")}) order by i.updated_at desc limit ?`)
    .all(...repoIds, limit) as Row[];
  return toIssues(db, rows);
}
