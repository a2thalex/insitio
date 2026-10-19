import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ValidationError } from "./errors.js";
import type { Access } from "./permissions.js";
import { createUser, getUserById, getUserByName, type User } from "./users.js";

type Row = Record<string, any>;

export function createOrg(db: DatabaseSync, owner: User, name: string, displayName = ""): User {
  const org = createUser(db, { username: name, password: randomBytes(24).toString("hex"), email: "", displayName });
  db.prepare("update users set kind = 'org' where id = ?").run(org.id);
  db.prepare("insert into org_members (org_id, user_id, role) values (?, ?, 'owner')").run(org.id, owner.id);
  return getUserById(db, org.id)!;
}

export function listOwnedOrgs(db: DatabaseSync, userId: number): User[] {
  return (
    db
      .prepare(
        `select u.* from users u join org_members m on m.org_id = u.id
         where m.user_id = ? and m.role = 'owner' order by u.username`,
      )
      .all(userId) as Row[]
  ).map((row) => getUserById(db, row.id)!);
}

export function orgRole(db: DatabaseSync, orgId: number, userId: number): "owner" | "member" | null {
  const row = db.prepare("select role from org_members where org_id = ? and user_id = ?").get(orgId, userId) as Row | undefined;
  return row?.role === "owner" || row?.role === "member" ? row.role : null;
}

export function addOrgMember(db: DatabaseSync, org: User, actorId: number, username: string): void {
  if (org.kind !== "org") throw new ValidationError("That account is not an organization.");
  if (orgRole(db, org.id, actorId) !== "owner") throw new ValidationError("Only an owner can add members.");
  const person = getUserByName(db, username.trim());
  if (!person || person.kind === "org") throw new ValidationError(`No user named ${username.trim()}`);
  db.prepare("insert into org_members (org_id, user_id, role) values (?, ?, 'member') on conflict (org_id, user_id) do nothing").run(org.id, person.id);
}

export function listOrgMembers(db: DatabaseSync, orgId: number): { id: number; username: string; role: string }[] {
  return (
    db
      .prepare(
        `select u.id as id, u.username as username, m.role as role from org_members m
         join users u on u.id = m.user_id where m.org_id = ? order by m.role desc, u.username`,
      )
      .all(orgId) as Row[]
  ).map((row) => ({ id: row.id, username: row.username, role: row.role }));
}

function slug(name: string): string {
  const out = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!out || out.length > 50) throw new ValidationError("Team name must contain letters or numbers.");
  return out;
}

export function createTeam(db: DatabaseSync, org: User, actorId: number, name: string): string {
  if (orgRole(db, org.id, actorId) !== "owner") throw new ValidationError("Only an owner can create a team.");
  const teamSlug = slug(name);
  try {
    db.prepare("insert into teams (org_id, name, slug) values (?, ?, ?)").run(org.id, name.trim().slice(0, 80), teamSlug);
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw new ValidationError("A team with that name already exists.");
    throw err;
  }
  return teamSlug;
}

export function listTeams(db: DatabaseSync, orgId: number): { id: number; name: string; slug: string }[] {
  return (db.prepare("select id, name, slug from teams where org_id = ? order by name").all(orgId) as Row[]).map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
  }));
}

export function addTeamMember(db: DatabaseSync, org: User, actorId: number, teamSlug: string, username: string): void {
  if (orgRole(db, org.id, actorId) !== "owner") throw new ValidationError("Only an owner can change a team.");
  const team = db.prepare("select id from teams where org_id = ? and slug = ?").get(org.id, teamSlug) as Row | undefined;
  if (!team) throw new ValidationError("That team does not exist.");
  const person = getUserByName(db, username.trim());
  if (!person || person.kind === "org") throw new ValidationError(`No user named ${username.trim()}`);
  if (!orgRole(db, org.id, person.id)) throw new ValidationError("Add them to the organization first.");
  db.prepare("insert into team_members (team_id, user_id) values (?, ?) on conflict do nothing").run(team.id, person.id);
}

export function grantTeamRepo(db: DatabaseSync, org: User, actorId: number, teamSlug: string, repoId: number, role: Access): void {
  if (role !== "read" && role !== "write" && role !== "admin") throw new ValidationError("Unknown role");
  if (orgRole(db, org.id, actorId) !== "owner") throw new ValidationError("Only an owner can change a team.");
  const team = db.prepare("select id from teams where org_id = ? and slug = ?").get(org.id, teamSlug) as Row | undefined;
  const repo = db.prepare("select owner_id from repos where id = ?").get(repoId) as Row | undefined;
  if (!team || !repo || repo.owner_id !== org.id) throw new ValidationError("That repository is not in this organization.");
  db.prepare(
    "insert into team_repos (team_id, repo_id, role) values (?, ?, ?) on conflict (team_id, repo_id) do update set role = excluded.role",
  ).run(team.id, repoId, role);
}
