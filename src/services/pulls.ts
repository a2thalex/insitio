import type { DatabaseSync } from "node:sqlite";
import { now, tx } from "../db/db.js";
import { ValidationError } from "./errors.js";
import { PER_PAGE, addEvent, insertIssue, toIssues, type Issue } from "./issues.js";

export type Pull = Issue & {
  baseRef: string;
  headRef: string;
  draft: boolean;
  mergedAt: number | null;
  mergedBy: string | null;
  mergeCommit: string | null;
};

type Row = Record<string, any>;

const PULL_SELECT = `select i.*, u.username as author,
  (select count(*) from comments c where c.issue_id = i.id) as comment_count,
  p.base_ref, p.head_ref, p.draft, p.merged_at, p.merge_commit, mu.username as merged_by_name
  from issues i join users u on u.id = i.author_id
  join pulls p on p.issue_id = i.id left join users mu on mu.id = p.merged_by`;

function toPulls(db: DatabaseSync, rows: Row[]): Pull[] {
  const issues = toIssues(db, rows);
  return issues.map((i, n) => ({
    ...i,
    baseRef: rows[n].base_ref,
    headRef: rows[n].head_ref,
    draft: !!rows[n].draft,
    mergedAt: rows[n].merged_at,
    mergedBy: rows[n].merged_by_name,
    mergeCommit: rows[n].merge_commit,
  }));
}

export function createPull(
  db: DatabaseSync,
  repoId: number,
  authorId: number,
  p: { title: string; body: string; baseRef: string; headRef: string; draft?: boolean },
): Pull {
  if (p.baseRef === p.headRef) throw new ValidationError("Choose different branches to compare");
  const id = tx(db, () => {
    const dup = db
      .prepare(
        `select i.number from issues i join pulls p on p.issue_id = i.id
         where i.repo_id = ? and i.state = 'open' and p.base_ref = ? and p.head_ref = ?`,
      )
      .get(repoId, p.baseRef, p.headRef) as Row | undefined;
    if (dup) throw new ValidationError(`A pull request for these branches already exists (#${dup.number})`);
    const issueId = insertIssue(db, repoId, authorId, { title: p.title, body: p.body, isPull: true });
    db.prepare("insert into pulls (issue_id, base_ref, head_ref, draft) values (?, ?, ?, ?)").run(issueId, p.baseRef, p.headRef, p.draft ? 1 : 0);
    return issueId;
  });
  return toPulls(db, [db.prepare(`${PULL_SELECT} where i.id = ?`).get(id) as Row])[0];
}

export function getPull(db: DatabaseSync, repoId: number, number: number): Pull | null {
  const r = db.prepare(`${PULL_SELECT} where i.repo_id = ? and i.number = ?`).get(repoId, number) as Row | undefined;
  return r ? toPulls(db, [r])[0] : null;
}

export function listPulls(
  db: DatabaseSync,
  repoId: number,
  f: { state: "open" | "closed" | "merged" | "all"; page: number },
): { items: Pull[]; total: number } {
  const where = ["i.repo_id = ?"];
  if (f.state === "open") where.push("i.state = 'open'");
  if (f.state === "closed") where.push("i.state = 'closed'");
  if (f.state === "merged") where.push("p.merged_at is not null");
  const clause = where.join(" and ");
  const total = (
    db.prepare(`select count(*) as n from issues i join pulls p on p.issue_id = i.id where ${clause}`).get(repoId) as Row
  ).n;
  const rows = db
    .prepare(`${PULL_SELECT} where ${clause} order by i.number desc limit ? offset ?`)
    .all(repoId, PER_PAGE, (Math.max(1, f.page) - 1) * PER_PAGE) as Row[];
  return { items: toPulls(db, rows), total };
}

export function setPullDraft(db: DatabaseSync, issueId: number, draft: boolean): void {
  db.prepare("update pulls set draft = ? where issue_id = ?").run(draft ? 1 : 0, issueId);
}

export function markMerged(db: DatabaseSync, issueId: number, userId: number, sha: string): void {
  tx(db, () => {
    const t = now();
    db.prepare("update pulls set merged_at = ?, merged_by = ?, merge_commit = ? where issue_id = ?").run(t, userId, sha, issueId);
    db.prepare("update issues set state = 'closed', closed_at = ?, updated_at = ? where id = ?").run(t, t, issueId);
    addEvent(db, issueId, userId, "merged", sha);
  });
}
