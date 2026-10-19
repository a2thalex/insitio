import type { DatabaseSync } from "node:sqlite";
import { ValidationError } from "./errors.js";

type Row = Record<string, any>;

export type SubIssue = { number: number; title: string; state: "open" | "closed" };

export function parentIssue(db: DatabaseSync, issueId: number): SubIssue | null {
  const row = db
    .prepare(
      `select i.number, i.title, i.state from issue_children c
       join issues i on i.id = c.parent_id where c.child_id = ?`,
    )
    .get(issueId) as Row | undefined;
  return row ? { number: row.number, title: row.title, state: row.state } : null;
}

export function childIssues(db: DatabaseSync, issueId: number): SubIssue[] {
  return (
    db
      .prepare(
        `select i.number, i.title, i.state from issue_children c
         join issues i on i.id = c.child_id where c.parent_id = ? order by i.number`,
      )
      .all(issueId) as Row[]
  ).map((row) => ({ number: row.number, title: row.title, state: row.state }));
}

export function addSubIssue(db: DatabaseSync, repoId: number, parentId: number, childNumber: number): void {
  const child = db.prepare("select id, is_pull from issues where repo_id = ? and number = ?").get(repoId, childNumber) as Row | undefined;
  if (!child || child.is_pull) throw new ValidationError("That issue is not in this repository.");
  if (child.id === parentId) throw new ValidationError("An issue cannot be a sub-issue of itself.");
  if (reaches(db, parentId, child.id)) throw new ValidationError("That would make a cycle.");
  const count = (db.prepare("select count(*) as n from issue_children where parent_id = ?").get(parentId) as Row).n as number;
  if (count >= 50) throw new ValidationError("An issue can have at most 50 sub-issues.");
  db.prepare("insert into issue_children (parent_id, child_id) values (?, ?) on conflict (child_id) do update set parent_id = excluded.parent_id").run(
    parentId,
    child.id,
  );
}

export function removeSubIssue(db: DatabaseSync, parentId: number, childNumber: number, repoId: number): void {
  const child = db.prepare("select id from issues where repo_id = ? and number = ?").get(repoId, childNumber) as Row | undefined;
  if (!child) return;
  db.prepare("delete from issue_children where parent_id = ? and child_id = ?").run(parentId, child.id);
}

/** True when walking parents from `start` reaches `target`. */
function reaches(db: DatabaseSync, start: number, target: number): boolean {
  let current = start;
  for (let hop = 0; hop < 50; hop++) {
    const row = db.prepare("select parent_id from issue_children where child_id = ?").get(current) as Row | undefined;
    if (!row) return false;
    if (row.parent_id === target) return true;
    current = row.parent_id;
  }
  return true;
}
