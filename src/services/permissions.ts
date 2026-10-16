import type { DatabaseSync } from "node:sqlite";
import type { User } from "./users.js";

export type Access = "none" | "read" | "write" | "admin";

const RANK: Record<Access, number> = { none: 0, read: 1, write: 2, admin: 3 };

type RepoLike = { id: number; ownerId: number; isPrivate: boolean };

/** The single owner of repository permission rules; pages and git HTTP both use it. */
export function accessLevel(db: DatabaseSync, user: User | null, repo: RepoLike): Access {
  if (user?.isAdmin || user?.id === repo.ownerId) return "admin";
  if (user) {
    const r = db.prepare("select role from collaborators where repo_id = ? and user_id = ?").get(repo.id, user.id) as
      | { role: Access }
      | undefined;
    if (r) return r.role;
  }
  return repo.isPrivate ? "none" : "read";
}

export function can(level: Access, need: Access): boolean {
  return RANK[level] >= RANK[need];
}
