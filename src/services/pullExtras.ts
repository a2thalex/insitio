import type { DatabaseSync } from "node:sqlite";
import { now, tx } from "../db/db.js";
import { ValidationError } from "./errors.js";
import { accessLevel, can } from "./permissions.js";
import type { RepoRow } from "./repos.js";
import { getUserByName, type User } from "./users.js";

const MAX_REVIEWERS = 10;
const MAX_TEMPLATES = 10;
const MAX_CHECKS = 10;

type Row = Record<string, any>;

export function setReviewers(db: DatabaseSync, repo: RepoRow, issueId: number, usernames: string[]): void {
  const unique = [...new Set(usernames.map((name) => name.trim()).filter(Boolean))];
  if (unique.length > MAX_REVIEWERS) throw new ValidationError(`A pull request can have at most ${MAX_REVIEWERS} reviewers.`);
  const users: User[] = [];
  for (const name of unique) {
    const user = getUserByName(db, name);
    if (!user || !can(accessLevel(db, user, repo), "read")) throw new ValidationError(`${name} can't review this repository.`);
    users.push(user);
  }
  tx(db, () => {
    db.prepare("delete from pull_reviewers where issue_id = ?").run(issueId);
    const insert = db.prepare("insert into pull_reviewers (issue_id, user_id) values (?, ?)");
    for (const user of users) insert.run(issueId, user.id);
  });
}

export function listReviewers(db: DatabaseSync, issueId: number): { id: number; username: string }[] {
  return (
    db
      .prepare(
        `select u.id as id, u.username as username from pull_reviewers r
         join users u on u.id = r.user_id where r.issue_id = ? order by u.username`,
      )
      .all(issueId) as Row[]
  ).map((row) => ({ id: row.id, username: row.username }));
}

export type ReviewState = "comment" | "approve" | "changes";
export type Review = { id: number; userId: number; username: string; state: ReviewState; body: string; createdAt: number };

export function addReview(db: DatabaseSync, issueId: number, userId: number, state: ReviewState, body: string): void {
  db.prepare("insert into pull_reviews (issue_id, user_id, state, body, created_at) values (?, ?, ?, ?, ?)").run(
    issueId,
    userId,
    state,
    body.slice(0, 10_000),
    now(),
  );
}

export function listReviews(db: DatabaseSync, issueId: number): Review[] {
  return (
    db
      .prepare(
        `select r.*, u.username as username from pull_reviews r join users u on u.id = r.user_id
         where r.issue_id = ? order by r.created_at, r.id`,
      )
      .all(issueId) as Row[]
  ).map((row) => ({
    id: row.id,
    userId: row.user_id,
    username: row.username,
    state: row.state,
    body: row.body,
    createdAt: row.created_at,
  }));
}

/** The latest review from each user. */
export function currentReviews(reviews: Review[]): Review[] {
  const byUser = new Map<number, Review>();
  for (const review of reviews) byUser.set(review.userId, review);
  return [...byUser.values()];
}

export type LineComment = {
  id: number;
  userId: number;
  username: string;
  path: string;
  side: "left" | "right";
  line: number;
  body: string;
  createdAt: number;
};

export function addLineComment(
  db: DatabaseSync,
  issueId: number,
  userId: number,
  input: { path: string; side: "left" | "right"; line: number; body: string },
): void {
  const text = input.body.trim();
  if (!text) throw new ValidationError("Comment can't be blank");
  db.prepare(
    "insert into pull_line_comments (issue_id, user_id, path, side, line, body, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run(issueId, userId, input.path, input.side, input.line, text.slice(0, 10_000), now());
}

export function listLineComments(db: DatabaseSync, issueId: number): LineComment[] {
  return (
    db
      .prepare(
        `select c.*, u.username as username from pull_line_comments c join users u on u.id = c.user_id
         where c.issue_id = ? order by c.created_at, c.id`,
      )
      .all(issueId) as Row[]
  ).map((row) => ({
    id: row.id,
    userId: row.user_id,
    username: row.username,
    path: row.path,
    side: row.side,
    line: row.line,
    body: row.body,
    createdAt: row.created_at,
  }));
}

export function getLineComment(db: DatabaseSync, issueId: number, id: number): LineComment | null {
  return listLineComments(db, issueId).find((comment) => comment.id === id) ?? null;
}

export function updateLineComment(db: DatabaseSync, id: number, body: string): void {
  const text = body.trim();
  if (!text) throw new ValidationError("Comment can't be blank");
  db.prepare("update pull_line_comments set body = ? where id = ?").run(text.slice(0, 10_000), id);
}

export function deleteLineComment(db: DatabaseSync, id: number): void {
  db.prepare("delete from pull_line_comments where id = ?").run(id);
}

export type PullTemplate = { id: number; name: string; about: string; title: string; body: string };

export function listPullTemplates(db: DatabaseSync, repoId: number): PullTemplate[] {
  return (db.prepare("select * from pull_templates where repo_id = ? order by position, id").all(repoId) as Row[]).map((row) => ({
    id: row.id,
    name: row.name,
    about: row.about,
    title: row.title,
    body: row.body,
  }));
}

export function savePullTemplate(db: DatabaseSync, repoId: number, input: { name: string; about: string; title: string; body: string }): void {
  const name = input.name.trim();
  if (!name) throw new ValidationError("Template name can't be blank.");
  if (name.length > 60) throw new ValidationError("Template name is too long.");
  const count = (db.prepare("select count(*) as n from pull_templates where repo_id = ?").get(repoId) as Row).n;
  if (count >= MAX_TEMPLATES) throw new ValidationError(`A repository can have at most ${MAX_TEMPLATES} pull request templates.`);
  db.prepare("insert into pull_templates (repo_id, name, about, title, body, position) values (?, ?, ?, ?, ?, ?)").run(
    repoId,
    name,
    input.about.trim().slice(0, 120),
    input.title.trim().slice(0, 256),
    input.body.slice(0, 10_000),
    count,
  );
}

export function deletePullTemplate(db: DatabaseSync, repoId: number, id: number): void {
  db.prepare("delete from pull_templates where id = ? and repo_id = ?").run(id, repoId);
}

export type StatusState = "pending" | "success" | "failure" | "error";
export type CommitStatus = { context: string; state: StatusState; description: string };

const STATUS_STATES = new Set<StatusState>(["pending", "success", "failure", "error"]);

export function setStatus(
  db: DatabaseSync,
  repoId: number,
  sha: string,
  input: { context: string; state: string; description: string },
  creatorId: number,
): CommitStatus {
  const context = input.context.trim();
  if (!context || context.length > 40 || /[\0\r\n]/.test(context)) throw new ValidationError("context must be 1–40 characters");
  if (!STATUS_STATES.has(input.state as StatusState)) throw new ValidationError("state must be pending, success, failure, or error");
  const description = input.description.slice(0, 140);
  const state = input.state as StatusState;
  db.prepare(
    `insert into commit_statuses (repo_id, sha, context, state, description, creator_id, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)
     on conflict (repo_id, sha, context) do update set
       state = excluded.state, description = excluded.description, creator_id = excluded.creator_id, updated_at = excluded.updated_at`,
  ).run(repoId, sha, context, state, description, creatorId, now());
  return { context, state, description };
}

export function listStatuses(db: DatabaseSync, repoId: number, sha: string): CommitStatus[] {
  return (db.prepare("select context, state, description from commit_statuses where repo_id = ? and sha = ? order by context").all(repoId, sha) as Row[]).map(
    (row) => ({ context: row.context, state: row.state, description: row.description }),
  );
}

export function listRequiredChecks(db: DatabaseSync, repoId: number): string[] {
  return (db.prepare("select context from required_checks where repo_id = ? order by context").all(repoId) as Row[]).map((row) => row.context);
}

export function setRequiredChecks(db: DatabaseSync, repoId: number, contexts: string[]): void {
  const unique = [...new Set(contexts.map((context) => context.trim()).filter(Boolean))];
  if (unique.length > MAX_CHECKS) throw new ValidationError(`A repository can require at most ${MAX_CHECKS} checks.`);
  for (const context of unique) {
    if (context.length > 40 || /[\0\r\n]/.test(context)) throw new ValidationError("A check context must be 1–40 characters.");
  }
  tx(db, () => {
    db.prepare("delete from required_checks where repo_id = ?").run(repoId);
    const insert = db.prepare("insert into required_checks (repo_id, context) values (?, ?)");
    for (const context of unique) insert.run(repoId, context);
  });
}

/** Required contexts that are missing or not success on `sha`. */
export function unmetChecks(db: DatabaseSync, repoId: number, sha: string): string[] {
  const required = listRequiredChecks(db, repoId);
  if (!required.length) return [];
  const byContext = new Map(listStatuses(db, repoId, sha).map((status) => [status.context, status.state]));
  return required.filter((context) => byContext.get(context) !== "success");
}
