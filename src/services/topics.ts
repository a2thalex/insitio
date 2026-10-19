import type { DatabaseSync } from "node:sqlite";
import { tx } from "../db/db.js";
import { ValidationError } from "./errors.js";

const TOPIC_RE = /^[a-z0-9-]{1,50}$/;
export const MAX_TOPICS = 20;

export function parseTopics(input: string): string[] {
  const unique = [...new Set(input.split(/[\s,]+/).map((part) => part.replace(/^#/, "").toLowerCase()).filter(Boolean))];
  if (unique.length > MAX_TOPICS) throw new ValidationError(`A repository can have at most ${MAX_TOPICS} topics.`);
  for (const topic of unique) {
    if (!TOPIC_RE.test(topic)) {
      throw new ValidationError("Topics may only contain lowercase letters, numbers and hyphens, and are at most 50 characters.");
    }
  }
  return unique;
}

export function listTopics(db: DatabaseSync, repoId: number): string[] {
  return (db.prepare("select topic from repo_topics where repo_id = ? order by topic").all(repoId) as { topic: string }[]).map((row) => row.topic);
}

export function setTopics(db: DatabaseSync, repoId: number, topics: string[]): void {
  tx(db, () => {
    db.prepare("delete from repo_topics where repo_id = ?").run(repoId);
    const ensure = db.prepare("insert or ignore into topics (name) values (?)");
    const link = db.prepare("insert or ignore into repo_topics (repo_id, topic) values (?, ?)");
    for (const topic of topics) {
      ensure.run(topic);
      link.run(repoId, topic);
    }
  });
}
