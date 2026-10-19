import type { DatabaseSync } from "node:sqlite";
import { now, tx } from "../db/db.js";
import type { Deps } from "../deps.js";
import type { Repo } from "../git/repo.js";
import { ForbiddenError, ValidationError } from "./errors.js";
import { addComment, addEvent, getIssue, setIssueState, type Issue } from "./issues.js";
import { accessLevel, can } from "./permissions.js";
import { getRepo, type RepoRow } from "./repos.js";
import { notify } from "./notifications.js";
import { getUserById, getUserByName, type User } from "./users.js";

export const REACTIONS = ["+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes"] as const;
export type ReactionEmoji = (typeof REACTIONS)[number];
export const REACTION_GLYPH: Record<ReactionEmoji, string> = {
  "+1": "👍",
  "-1": "👎",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
};

export type CloseReason = "completed" | "not_planned";
export type Assignee = { id: number; username: string };
export type Milestone = {
  id: number;
  repoId: number;
  number: number;
  title: string;
  description: string;
  dueOn: number | null;
  state: "open" | "closed";
  openCount: number;
  closedCount: number;
};

type Row = Record<string, any>;
const MAX_ASSIGNEES = 10;
const MAX_PINNED = 3;
const MAX_TEMPLATES = 10;

export function assigneesFor(db: DatabaseSync, issueIds: number[]): Map<number, Assignee[]> {
  const map = new Map<number, Assignee[]>();
  if (!issueIds.length) return map;
  const rows = db
    .prepare(
      `select a.issue_id, u.id as id, u.username as username from issue_assignees a
       join users u on u.id = a.user_id where a.issue_id in (${issueIds.map(() => "?").join(",")}) order by u.username`,
    )
    .all(...issueIds) as Row[];
  for (const row of rows) {
    const list = map.get(row.issue_id) ?? [];
    list.push({ id: row.id, username: row.username });
    map.set(row.issue_id, list);
  }
  return map;
}

/** Users who may be assigned, or a validation error before any row is written. */
export function resolveAssignees(db: DatabaseSync, repo: RepoRow, usernames: string[]): User[] {
  const names = usernames.map((name) => name.trim()).filter(Boolean);
  const users: User[] = [];
  const seen = new Set<number>();
  for (const name of names) {
    const user = getUserByName(db, name);
    if (!user || !can(accessLevel(db, user, repo), "read")) throw new ValidationError(`${name} can't be assigned on this repository.`);
    if (seen.has(user.id)) continue;
    seen.add(user.id);
    users.push(user);
  }
  if (users.length > MAX_ASSIGNEES) throw new ValidationError(`An issue can have at most ${MAX_ASSIGNEES} assignees.`);
  return users;
}

export function setAssignees(db: DatabaseSync, repo: RepoRow, issueId: number, usernames: string[], actorId: number): void {
  const users = resolveAssignees(db, repo, usernames);
  const added: User[] = [];
  tx(db, () => {
    const current = new Set((assigneesFor(db, [issueId]).get(issueId) ?? []).map((a) => a.id));
    const next = new Set(users.map((u) => u.id));
    db.prepare("delete from issue_assignees where issue_id = ?").run(issueId);
    const insert = db.prepare("insert into issue_assignees (issue_id, user_id) values (?, ?)");
    for (const user of users) insert.run(issueId, user.id);
    for (const user of users) if (!current.has(user.id)) {
      addEvent(db, issueId, actorId, "assigned", user.username);
      added.push(user);
    }
    for (const id of current) if (!next.has(id)) addEvent(db, issueId, actorId, "unassigned", getUserById(db, id)?.username ?? "");
  });
  const issue = db.prepare("select number, is_pull from issues where id = ?").get(issueId) as
    | { number: number; is_pull: number }
    | undefined;
  if (!issue) return;
  for (const user of added) {
    notify(db, user.id, actorId, {
      title: `You were assigned to ${repo.owner}/${repo.name}#${issue.number}`,
      url: `/${repo.owner}/${repo.name}/${issue.is_pull ? "pull" : "issues"}/${issue.number}`,
      reason: "assign",
      repoId: repo.id,
    });
  }
}

export function listMilestones(db: DatabaseSync, repoId: number, state: "open" | "closed" | "all" = "open"): Milestone[] {
  const where = state === "all" ? "" : "and m.state = ?";
  const rows = db
    .prepare(
      `select m.*,
        (select count(*) from issues i where i.milestone_id = m.id and i.state = 'open' and i.is_pull = 0) as open_count,
        (select count(*) from issues i where i.milestone_id = m.id and i.state = 'closed' and i.is_pull = 0) as closed_count
       from milestones m where m.repo_id = ? ${where} order by m.number desc`,
    )
    .all(...(state === "all" ? [repoId] : [repoId, state])) as Row[];
  return rows.map(toMilestone);
}

function toMilestone(row: Row): Milestone {
  return {
    id: row.id,
    repoId: row.repo_id,
    number: row.number,
    title: row.title,
    description: row.description,
    dueOn: row.due_on,
    state: row.state,
    openCount: row.open_count ?? 0,
    closedCount: row.closed_count ?? 0,
  };
}

export function getMilestone(db: DatabaseSync, repoId: number, number: number): Milestone | null {
  const row = db
    .prepare(
      `select m.*,
        (select count(*) from issues i where i.milestone_id = m.id and i.state = 'open' and i.is_pull = 0) as open_count,
        (select count(*) from issues i where i.milestone_id = m.id and i.state = 'closed' and i.is_pull = 0) as closed_count
       from milestones m where m.repo_id = ? and m.number = ?`,
    )
    .get(repoId, number) as Row | undefined;
  return row ? toMilestone(row) : null;
}

export function getMilestoneById(db: DatabaseSync, id: number): Milestone | null {
  const row = db.prepare("select *, 0 as open_count, 0 as closed_count from milestones where id = ?").get(id) as Row | undefined;
  return row ? toMilestone(row) : null;
}

function nextMilestoneNumber(db: DatabaseSync, repoId: number): number {
  const row = db.prepare("select coalesce(max(number), 0) + 1 as n from milestones where repo_id = ?").get(repoId) as Row;
  return row.n;
}

export function createMilestone(db: DatabaseSync, repoId: number, input: { title: string; description: string; dueOn: number | null }): Milestone {
  const title = cleanTitle(input.title, 120, "Milestone title");
  const res = db
    .prepare("insert into milestones (repo_id, number, title, description, due_on, created_at) values (?, ?, ?, ?, ?, ?)")
    .run(repoId, nextMilestoneNumber(db, repoId), title, input.description.slice(0, 10_000), input.dueOn, now());
  return getMilestoneById(db, Number(res.lastInsertRowid))!;
}

export function updateMilestone(db: DatabaseSync, milestone: Milestone, input: { title: string; description: string; dueOn: number | null; state: "open" | "closed" }): void {
  const title = cleanTitle(input.title, 120, "Milestone title");
  const closedAt = input.state === "closed" ? (milestone.state === "closed" ? undefined : now()) : null;
  db.prepare("update milestones set title = ?, description = ?, due_on = ?, state = ?, closed_at = ? where id = ?").run(
    title,
    input.description.slice(0, 10_000),
    input.dueOn,
    input.state,
    input.state === "closed" ? (closedAt ?? now()) : null,
    milestone.id,
  );
}

export function deleteMilestone(db: DatabaseSync, repoId: number, id: number): void {
  db.prepare("delete from milestones where id = ? and repo_id = ?").run(id, repoId);
}

export function setMilestone(db: DatabaseSync, issueId: number, milestoneId: number | null, actorId: number): void {
  const current = db.prepare("select milestone_id from issues where id = ?").get(issueId) as Row | undefined;
  if (!current || current.milestone_id === milestoneId) return;
  db.prepare("update issues set milestone_id = ?, updated_at = ? where id = ?").run(milestoneId, now(), issueId);
  if (milestoneId) {
    const milestone = getMilestoneById(db, milestoneId);
    addEvent(db, issueId, actorId, "milestoned", milestone?.title ?? "");
  } else addEvent(db, issueId, actorId, "demilestoned", "");
}

export function parseDue(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ValidationError("Due date must be YYYY-MM-DD.");
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new ValidationError("Due date must be YYYY-MM-DD.");
  return Math.floor(date.getTime() / 1000);
}

function cleanTitle(title: string, max: number, label: string): string {
  const text = title.trim();
  if (!text) throw new ValidationError(`${label} can't be blank.`);
  if (text.length > max) throw new ValidationError(`${label} is too long.`);
  return text;
}

export type ReactionCount = { emoji: ReactionEmoji; count: number; mine: boolean };

export function reactionSummary(db: DatabaseSync, kind: "issue" | "comment", targetId: number, userId: number | null): ReactionCount[] {
  const rows = db
    .prepare("select emoji, count(*) as n, sum(case when user_id = ? then 1 else 0 end) as mine from reactions where target_kind = ? and target_id = ? group by emoji")
    .all(userId ?? 0, kind, targetId) as Row[];
  const byEmoji = new Map(rows.map((row) => [row.emoji, row]));
  return REACTIONS.map((emoji) => {
    const row = byEmoji.get(emoji);
    return { emoji, count: row?.n ?? 0, mine: !!row?.mine };
  });
}

export function toggleReaction(db: DatabaseSync, userId: number, kind: "issue" | "comment", targetId: number, emoji: string): void {
  if (!REACTIONS.includes(emoji as ReactionEmoji)) throw new ValidationError("That reaction is not available.");
  const existing = db
    .prepare("select 1 from reactions where user_id = ? and target_kind = ? and target_id = ? and emoji = ?")
    .get(userId, kind, targetId, emoji);
  if (existing) db.prepare("delete from reactions where user_id = ? and target_kind = ? and target_id = ? and emoji = ?").run(userId, kind, targetId, emoji);
  else db.prepare("insert into reactions (user_id, target_kind, target_id, emoji, created_at) values (?, ?, ?, ?, ?)").run(userId, kind, targetId, emoji, now());
}

export function setLocked(db: DatabaseSync, issueId: number, locked: boolean, actorId: number): void {
  db.prepare("update issues set locked = ?, updated_at = ? where id = ?").run(locked ? 1 : 0, now(), issueId);
  addEvent(db, issueId, actorId, locked ? "locked" : "unlocked");
}

export function setPinned(db: DatabaseSync, repoId: number, issueId: number, pinned: boolean, actorId: number): void {
  if (pinned) {
    const count = (db.prepare("select count(*) as n from issues where repo_id = ? and pinned_at is not null and id != ?").get(repoId, issueId) as Row).n;
    if (count >= MAX_PINNED) throw new ValidationError(`Only ${MAX_PINNED} issues can be pinned.`);
    db.prepare("update issues set pinned_at = ?, updated_at = ? where id = ?").run(now(), now(), issueId);
  } else db.prepare("update issues set pinned_at = null, updated_at = ? where id = ?").run(now(), issueId);
  addEvent(db, issueId, actorId, pinned ? "pinned" : "unpinned");
}

export type IssueTemplate = { id: number; name: string; about: string; title: string; body: string };

export function listTemplates(db: DatabaseSync, repoId: number): IssueTemplate[] {
  return (db.prepare("select * from issue_templates where repo_id = ? order by position, id").all(repoId) as Row[]).map(toTemplate);
}

function toTemplate(row: Row): IssueTemplate {
  return { id: row.id, name: row.name, about: row.about, title: row.title, body: row.body };
}

export function saveTemplate(db: DatabaseSync, repoId: number, input: { id?: number; name: string; about: string; title: string; body: string }): void {
  const name = cleanTitle(input.name, 60, "Template name");
  const about = input.about.trim().slice(0, 120);
  const title = input.title.trim().slice(0, 256);
  const body = input.body.slice(0, 10_000);
  if (input.id) {
    db.prepare("update issue_templates set name = ?, about = ?, title = ?, body = ? where id = ? and repo_id = ?").run(name, about, title, body, input.id, repoId);
    return;
  }
  const taken = db.prepare("select 1 from issue_templates where repo_id = ? and name = ?").get(repoId, name);
  if (taken) throw new ValidationError("A template with that name already exists.");
  const count = (db.prepare("select count(*) as n from issue_templates where repo_id = ?").get(repoId) as Row).n;
  if (count >= MAX_TEMPLATES) throw new ValidationError(`A repository can have at most ${MAX_TEMPLATES} issue templates.`);
  db.prepare("insert into issue_templates (repo_id, name, about, title, body, position) values (?, ?, ?, ?, ?, ?)").run(repoId, name, about, title, body, count);
}

export function deleteTemplate(db: DatabaseSync, repoId: number, id: number): void {
  db.prepare("delete from issue_templates where id = ? and repo_id = ?").run(id, repoId);
}

export function assertCanTalk(issue: Issue, level: ReturnType<typeof accessLevel>): void {
  if (issue.locked && !can(level, "write")) throw new ForbiddenError("This conversation has been locked.");
}

const CLOSING = /\b(fix(?:es|ed)?|clos(?:e|es|ed)|resolv(?:e|es|ed))\s+(?:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+))?#(\d+)\b/gi;
const MENTION = /(?:^|[^\w/])(?:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+))?#(\d+)\b/g;

export function closingReferences(text: string): { owner?: string; repo?: string; number: number }[] {
  const found: { owner?: string; repo?: string; number: number }[] = [];
  for (const line of text.split("\n")) {
    for (const match of line.matchAll(CLOSING)) {
      found.push({ owner: match[2], repo: match[3], number: Number(match[4]) });
    }
  }
  return found;
}

export function mentionReferences(text: string): { owner?: string; repo?: string; number: number }[] {
  const found: { owner?: string; repo?: string; number: number }[] = [];
  for (const match of text.matchAll(MENTION)) found.push({ owner: match[1], repo: match[2], number: Number(match[3]) });
  return found;
}

/** Closes open issues named by Fixes/Closes/Resolves, when the actor can write to them. */
export function applyClosingReferences(db: DatabaseSync, actor: User, defaultRepo: RepoRow, text: string, via: string): void {
  for (const ref of closingReferences(text)) {
    const repo = ref.owner && ref.repo ? getRepo(db, ref.owner, ref.repo) : defaultRepo;
    if (!repo || !can(accessLevel(db, actor, repo), "write")) continue;
    const issue = getIssue(db, repo.id, ref.number);
    if (!issue || issue.isPull || issue.state !== "open") continue;
    setIssueState(db, issue.id, "closed", actor.id, "completed");
    addComment(db, issue.id, actor.id, `Closed by ${via}.`);
  }
}

export function recordMentions(db: DatabaseSync, actor: User, sourceRepo: RepoRow, text: string, source: { kind: string; number?: number; sha?: string }): void {
  for (const ref of mentionReferences(text)) {
    const repo = ref.owner && ref.repo ? getRepo(db, ref.owner, ref.repo) : sourceRepo;
    if (!repo) continue;
    const issue = getIssue(db, repo.id, ref.number);
    if (!issue || !can(accessLevel(db, actor, repo), "read")) continue;
    const detail = source.sha ? `commit:${source.sha}` : `${source.kind}:${source.number ?? ""}`;
    const exists = db
      .prepare("select 1 from issue_mentions where issue_id = ? and source_kind = ? and source_repo_id = ? and ifnull(source_number, -1) = ? and commit_sha = ?")
      .get(issue.id, source.kind, sourceRepo.id, source.number ?? -1, source.sha ?? "");
    if (exists) continue;
    db.prepare(
      "insert into issue_mentions (issue_id, source_kind, source_repo_id, source_number, commit_sha, actor_id, created_at) values (?, ?, ?, ?, ?, ?, ?)",
    ).run(issue.id, source.kind, sourceRepo.id, source.number ?? null, source.sha ?? "", actor.id, now());
    addEvent(db, issue.id, actor.id, "mentioned", detail);
  }
}

/** Commit messages that arrived on the default branch since `before`, at most 100. */
export async function scanPushedCommits(deps: Deps, repo: RepoRow, actor: User, git: Repo, before: string | null): Promise<void> {
  const after = await git.resolve(repo.defaultBranch);
  if (!after || after === before) return;
  const commits = await git.commitMessages(before, after);
  for (const commit of commits) {
    const message = `${commit.subject}\n${commit.body}`;
    applyClosingReferences(deps.db, actor, repo, message, commit.sha.slice(0, 7));
    recordMentions(deps.db, actor, repo, message, { kind: "commit", sha: commit.sha });
  }
}
