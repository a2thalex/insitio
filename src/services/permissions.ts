import type { DatabaseSync } from "node:sqlite";
import type { User } from "./users.js";

export type Access = "none" | "read" | "write" | "admin";

const RANK: Record<Access, number> = { none: 0, read: 1, write: 2, admin: 3 };

type RepoLike = { id: number; ownerId: number; isPrivate: boolean };

function higher(a: Access, b: Access): Access {
  return RANK[a] >= RANK[b] ? a : b;
}

/** The single owner of repository permission rules; pages and git HTTP both use it. */
export function accessLevel(db: DatabaseSync, user: User | null, repo: RepoLike): Access {
  if (user?.isAdmin || user?.id === repo.ownerId) return "admin";
  if (user) {
    const org = db.prepare("select role from org_members where org_id = ? and user_id = ?").get(repo.ownerId, user.id) as
      | { role: string }
      | undefined;
    if (org?.role === "owner") return "admin";
    let level: Access = "none";
    const collab = db.prepare("select role from collaborators where repo_id = ? and user_id = ?").get(repo.id, user.id) as
      | { role: Access }
      | undefined;
    if (collab) level = collab.role;
    const teams = db
      .prepare(
        `select tr.role as role from team_repos tr
         join team_members tm on tm.team_id = tr.team_id
         join teams t on t.id = tr.team_id
         where tr.repo_id = ? and tm.user_id = ? and t.org_id = ?`,
      )
      .all(repo.id, user.id, repo.ownerId) as { role: Access }[];
    for (const team of teams) level = higher(level, team.role);
    if (level !== "none") return level;
  }
  return repo.isPrivate ? "none" : "read";
}

export function can(level: Access, need: Access): boolean {
  return RANK[level] >= RANK[need];
}
