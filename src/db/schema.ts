import type { DatabaseSync } from "node:sqlite";

// Each entry migrates user_version from its index to index + 1.
const MIGRATIONS = [
  `
  create table users (
    id integer primary key,
    username text not null unique collate nocase,
    display_name text not null default '',
    email text not null default '',
    password_hash text not null,
    is_admin integer not null default 0,
    bio text not null default '',
    created_at integer not null
  );
  create table sessions (
    id text primary key,
    user_id integer not null references users(id) on delete cascade,
    csrf_token text not null,
    expires_at integer not null
  );
  create table invites (
    token text primary key,
    created_by integer references users(id) on delete set null,
    used_by integer references users(id) on delete set null,
    expires_at integer not null,
    created_at integer not null
  );
  create table access_tokens (
    id integer primary key,
    user_id integer not null references users(id) on delete cascade,
    name text not null,
    token_hash text not null unique,
    last_used_at integer,
    created_at integer not null
  );
  create table repos (
    id integer primary key,
    owner_id integer not null references users(id) on delete cascade,
    name text not null collate nocase,
    description text not null default '',
    is_private integer not null default 0,
    default_branch text not null default 'main',
    created_at integer not null,
    unique (owner_id, name)
  );
  create table collaborators (
    repo_id integer not null references repos(id) on delete cascade,
    user_id integer not null references users(id) on delete cascade,
    role text not null check (role in ('read', 'write', 'admin')),
    primary key (repo_id, user_id)
  );
  create table stars (
    user_id integer not null references users(id) on delete cascade,
    repo_id integer not null references repos(id) on delete cascade,
    created_at integer not null,
    primary key (user_id, repo_id)
  );
  create table repo_counters (
    repo_id integer primary key references repos(id) on delete cascade,
    next_number integer not null default 1
  );
  create table issues (
    id integer primary key,
    repo_id integer not null references repos(id) on delete cascade,
    number integer not null,
    author_id integer not null references users(id),
    title text not null,
    body text not null default '',
    state text not null default 'open' check (state in ('open', 'closed')),
    is_pull integer not null default 0,
    created_at integer not null,
    updated_at integer not null,
    closed_at integer,
    unique (repo_id, number)
  );
  create table pulls (
    issue_id integer primary key references issues(id) on delete cascade,
    base_ref text not null,
    head_ref text not null,
    merged_at integer,
    merged_by integer references users(id),
    merge_commit text
  );
  create table comments (
    id integer primary key,
    issue_id integer not null references issues(id) on delete cascade,
    author_id integer not null references users(id),
    body text not null,
    created_at integer not null
  );
  create table labels (
    id integer primary key,
    repo_id integer not null references repos(id) on delete cascade,
    name text not null collate nocase,
    color text not null,
    unique (repo_id, name)
  );
  create table issue_labels (
    issue_id integer not null references issues(id) on delete cascade,
    label_id integer not null references labels(id) on delete cascade,
    primary key (issue_id, label_id)
  );
  create index issues_repo_state on issues (repo_id, is_pull, state);
  create index comments_issue on comments (issue_id);
  create index sessions_user on sessions (user_id);
  `,
  `
  create table issue_events (
    id integer primary key,
    issue_id integer not null references issues(id) on delete cascade,
    actor_id integer references users(id) on delete set null,
    kind text not null check (kind in ('closed', 'reopened', 'merged', 'head_deleted')),
    detail text not null default '',
    created_at integer not null
  );
  create index issue_events_issue on issue_events (issue_id);
  `,
  `
  create table device_codes (
    id integer primary key,
    device_code_hash text not null unique,
    user_code_hash text not null unique,
    client_name text not null,
    status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'consumed')),
    user_id integer references users(id) on delete cascade,
    interval integer not null default 5,
    last_poll_at integer,
    expires_at integer not null,
    created_at integer not null
  );
  `,
  // startDevice sweeps old rows (expires_at < x) and counts open ones (expires_at > x) on every call.
  `
  create index device_codes_expires_at on device_codes (expires_at);
  `,
  // The source that asked for a code (an IPv4 address or an IPv6 /48, see addressBucket), so that startDevice
  // can cap the open codes of one source. Null for rows made before this column existed. The sweep removes
  // a row (and with it the address) an hour after it expires.
  `
  alter table device_codes add column bucket text;
  create index device_codes_bucket on device_codes (bucket, expires_at);
  `,
];

export function migrate(db: DatabaseSync): void {
  const row = db.prepare("pragma user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("begin");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`pragma user_version = ${v + 1}`);
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
  }
}
