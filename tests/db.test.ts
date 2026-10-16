import { describe, it, expect } from "vitest";
import { openDb } from "../src/db/db.js";
import { migrate } from "../src/db/schema.js";

describe("schema", () => {
  it("creates all tables and is idempotent", () => {
    const db = openDb(":memory:");
    migrate(db);
    migrate(db);
    const names = db
      .prepare("select name from sqlite_master where type='table' order by name")
      .all()
      .map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "users", "sessions", "invites", "access_tokens", "repos", "collaborators",
        "stars", "issues", "pulls", "comments", "labels", "issue_labels", "repo_counters",
      ]),
    );
  });

  it("enforces foreign keys", () => {
    const db = openDb(":memory:");
    migrate(db);
    expect(() =>
      db.prepare("insert into repos (owner_id, name, created_at) values (999, 'x', 0)").run(),
    ).toThrow();
  });
});
