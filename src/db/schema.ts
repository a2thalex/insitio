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
  // Code tab: website and fork link, watches, topics, releases and the per-commit about cache.
  `
  alter table repos add column website text not null default '';
  alter table repos add column forked_from_id integer references repos(id) on delete set null;
  create table watches (
    user_id integer not null references users(id) on delete cascade,
    repo_id integer not null references repos(id) on delete cascade,
    level text not null check (level in ('all', 'ignore')),
    primary key (user_id, repo_id)
  );
  create index watches_repo on watches (repo_id, level);
  create table topics (
    name text primary key
  );
  create table repo_topics (
    repo_id integer not null references repos(id) on delete cascade,
    topic text not null references topics(name) on delete cascade,
    primary key (repo_id, topic)
  );
  create index repo_topics_topic on repo_topics (topic);
  create table releases (
    id integer primary key,
    repo_id integer not null references repos(id) on delete cascade,
    tag text not null default '',
    target text not null default '',
    title text not null,
    body text not null default '',
    draft integer not null default 0,
    prerelease integer not null default 0,
    make_latest text not null default 'legacy' check (make_latest in ('true', 'false', 'legacy')),
    author_id integer not null references users(id),
    created_at integer not null,
    published_at integer
  );
  create index releases_repo on releases (repo_id, published_at);
  create unique index releases_repo_tag on releases (repo_id, tag) where tag <> '';
  create table release_assets (
    id integer primary key,
    release_id integer not null references releases(id) on delete cascade,
    name text not null,
    size integer not null,
    content_type text not null default 'application/octet-stream',
    download_count integer not null default 0,
    created_at integer not null,
    unique (release_id, name)
  );
  create table repo_analyses (
    repo_id integer not null references repos(id) on delete cascade,
    commit_sha text not null,
    languages_json text not null,
    license_id text not null default '',
    license_path text not null default '',
    contributors_json text not null,
    primary key (repo_id, commit_sha)
  );
  `,
  // Issues: assignees, milestones, reactions, templates, lock, pin, close reasons, mentions.
  `
  alter table issues add column close_reason text check (close_reason is null or close_reason in ('completed', 'not_planned'));
  alter table issues add column locked integer not null default 0;
  alter table issues add column pinned_at integer;
  create table milestones (
    id integer primary key,
    repo_id integer not null references repos(id) on delete cascade,
    number integer not null,
    title text not null,
    description text not null default '',
    due_on integer,
    state text not null default 'open' check (state in ('open', 'closed')),
    created_at integer not null,
    closed_at integer,
    unique (repo_id, number)
  );
  alter table issues add column milestone_id integer references milestones(id) on delete set null;
  create table issue_assignees (
    issue_id integer not null references issues(id) on delete cascade,
    user_id integer not null references users(id) on delete cascade,
    primary key (issue_id, user_id)
  );
  create table reactions (
    user_id integer not null references users(id) on delete cascade,
    target_kind text not null check (target_kind in ('issue', 'comment')),
    target_id integer not null,
    emoji text not null check (emoji in ('+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes')),
    created_at integer not null,
    primary key (user_id, target_kind, target_id, emoji)
  );
  create index reactions_target on reactions (target_kind, target_id);
  create table issue_templates (
    id integer primary key,
    repo_id integer not null references repos(id) on delete cascade,
    name text not null,
    about text not null default '',
    title text not null default '',
    body text not null default '',
    position integer not null default 0,
    unique (repo_id, name)
  );
  create table activities (
    id integer primary key,
    issue_id integer not null references issues(id) on delete cascade,
    actor_id integer references users(id) on delete set null,
    kind text not null,
    detail text not null default '',
    created_at integer not null
  );
  create index activities_issue on activities (issue_id);
  create table issue_mentions (
    id integer primary key,
    issue_id integer not null references issues(id) on delete cascade,
    source_kind text not null,
    source_repo_id integer not null,
    source_number integer,
    commit_sha text not null default '',
    actor_id integer references users(id) on delete set null,
    created_at integer not null
  );
  create index issue_mentions_issue on issue_mentions (issue_id);
  `,
  // Pull requests: drafts, reviewers, reviews, line comments, templates, statuses.
  `
  alter table pulls add column draft integer not null default 0;
  alter table pulls add column merge_base_sha text;
  create table pull_reviewers (
    issue_id integer not null references issues(id) on delete cascade,
    user_id integer not null references users(id) on delete cascade,
    primary key (issue_id, user_id)
  );
  create table pull_reviews (
    id integer primary key,
    issue_id integer not null references issues(id) on delete cascade,
    user_id integer not null references users(id),
    state text not null check (state in ('comment', 'approve', 'changes')),
    body text not null default '',
    created_at integer not null
  );
  create index pull_reviews_issue on pull_reviews (issue_id, created_at);
  create table pull_line_comments (
    id integer primary key,
    issue_id integer not null references issues(id) on delete cascade,
    user_id integer not null references users(id),
    path text not null,
    side text not null check (side in ('left', 'right')),
    line integer not null,
    commit_sha text not null default '',
    line_text text not null default '',
    body text not null,
    created_at integer not null
  );
  create index pull_line_comments_issue on pull_line_comments (issue_id);
  create table pull_templates (
    id integer primary key,
    repo_id integer not null references repos(id) on delete cascade,
    name text not null,
    about text not null default '',
    title text not null default '',
    body text not null default '',
    position integer not null default 0,
    unique (repo_id, name)
  );
  create table commit_statuses (
    repo_id integer not null references repos(id) on delete cascade,
    sha text not null,
    context text not null,
    state text not null check (state in ('pending', 'success', 'failure', 'error')),
    description text not null default '',
    creator_id integer references users(id) on delete set null,
    updated_at integer not null,
    primary key (repo_id, sha, context)
  );
  create table required_checks (
    repo_id integer not null references repos(id) on delete cascade,
    context text not null,
    primary key (repo_id, context)
  );
  `,
  // Repository settings: archive, toggles, merge methods, protection, webhooks, deploy keys.
  `
  alter table repos add column archived integer not null default 0;
  alter table repos add column issues_enabled integer not null default 1;
  alter table repos add column pulls_enabled integer not null default 1;
  alter table repos add column allow_merge integer not null default 1;
  alter table repos add column allow_squash integer not null default 1;
  alter table repos add column allow_rebase integer not null default 1;
  create table branch_rules (
    repo_id integer not null references repos(id) on delete cascade,
    branch text not null,
    require_pr integer not null default 0,
    approvals integer not null default 0,
    primary key (repo_id, branch)
  );
  create table webhooks (
    id integer primary key,
    repo_id integer not null references repos(id) on delete cascade,
    url text not null,
    secret text not null default '',
    events text not null,
    active integer not null default 1,
    created_at integer not null
  );
  create table webhook_deliveries (
    id integer primary key,
    webhook_id integer not null references webhooks(id) on delete cascade,
    event text not null,
    response_status integer,
    created_at integer not null
  );
  create table deploy_keys (
    id integer primary key,
    repo_id integer not null references repos(id) on delete cascade,
    title text not null,
    token_hash text not null unique,
    can_write integer not null default 0,
    created_at integer not null
  );
  `,
  // Account: emails, sessions metadata, two-factor, theme, blocks, replies, keys, security log.
  `
  alter table users add column theme text not null default 'dark';
  alter table users add column notify text not null default 'participating';
  alter table users add column totp_secret text;
  alter table users add column totp_pending text;
  alter table sessions add column created_at integer not null default 0;
  alter table sessions add column user_agent text not null default '';
  create table emails (
    id integer primary key,
    user_id integer not null references users(id) on delete cascade,
    email text not null unique collate nocase,
    is_primary integer not null default 0
  );
  insert into emails (user_id, email, is_primary)
    select id, email, 1 from users where email <> '';
  create table recovery_codes (
    user_id integer not null references users(id) on delete cascade,
    code_hash text not null,
    primary key (user_id, code_hash)
  );
  create table ssh_keys (
    id integer primary key,
    user_id integer not null references users(id) on delete cascade,
    title text not null,
    public_key text not null,
    fingerprint text not null,
    created_at integer not null
  );
  create table gpg_keys (
    id integer primary key,
    user_id integer not null references users(id) on delete cascade,
    key_id text not null,
    armored text not null,
    created_at integer not null
  );
  create table blocks (
    user_id integer not null references users(id) on delete cascade,
    blocked_id integer not null references users(id) on delete cascade,
    created_at integer not null,
    primary key (user_id, blocked_id)
  );
  create table saved_replies (
    id integer primary key,
    user_id integer not null references users(id) on delete cascade,
    title text not null,
    body text not null,
    created_at integer not null
  );
  create table security_events (
    id integer primary key,
    user_id integer not null references users(id) on delete cascade,
    kind text not null,
    detail text not null default '',
    created_at integer not null
  );
  create index security_events_user on security_events (user_id, id desc);
  `,
  // Site-wide: organizations, teams, and the notification inbox.
  `
  alter table users add column kind text not null default 'user' check (kind in ('user', 'org'));
  create table org_members (
    org_id integer not null references users(id) on delete cascade,
    user_id integer not null references users(id) on delete cascade,
    role text not null check (role in ('owner', 'member')),
    primary key (org_id, user_id)
  );
  create table teams (
    id integer primary key,
    org_id integer not null references users(id) on delete cascade,
    name text not null,
    slug text not null,
    unique (org_id, slug)
  );
  create table team_members (
    team_id integer not null references teams(id) on delete cascade,
    user_id integer not null references users(id) on delete cascade,
    primary key (team_id, user_id)
  );
  create table team_repos (
    team_id integer not null references teams(id) on delete cascade,
    repo_id integer not null references repos(id) on delete cascade,
    role text not null check (role in ('read', 'write', 'admin')),
    primary key (team_id, repo_id)
  );
  create table notifications (
    id integer primary key,
    user_id integer not null references users(id) on delete cascade,
    repo_id integer not null references repos(id) on delete cascade,
    title text not null,
    url text not null,
    reason text not null,
    read_at integer,
    created_at integer not null
  );
  create index notifications_user on notifications (user_id, id);
  `,
  // Repository tabs: wiki, discussions, projects, advisories, and recorded action runs.
  `
  create table wiki_pages (
    id integer primary key,
    repo_id integer not null references repos(id) on delete cascade,
    slug text not null,
    title text not null,
    body text not null,
    updated_by integer references users(id) on delete set null,
    updated_at integer not null,
    unique (repo_id, slug)
  );
  create table discussions (
    id integer primary key,
    repo_id integer not null references repos(id) on delete cascade,
    number integer not null,
    author_id integer not null references users(id),
    category text not null check (category in ('general', 'ideas', 'q-and-a')),
    title text not null,
    body text not null,
    state text not null default 'open' check (state in ('open', 'closed')),
    created_at integer not null,
    unique (repo_id, number)
  );
  create table discussion_comments (
    id integer primary key,
    discussion_id integer not null references discussions(id) on delete cascade,
    author_id integer not null references users(id),
    body text not null,
    created_at integer not null
  );
  create table projects (
    id integer primary key,
    repo_id integer not null references repos(id) on delete cascade,
    name text not null,
    created_at integer not null
  );
  create table project_columns (
    id integer primary key,
    project_id integer not null references projects(id) on delete cascade,
    name text not null,
    position integer not null
  );
  create table project_cards (
    id integer primary key,
    column_id integer not null references project_columns(id) on delete cascade,
    title text not null,
    issue_number integer,
    position integer not null
  );
  create table advisories (
    id integer primary key,
    repo_id integer not null references repos(id) on delete cascade,
    title text not null,
    severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
    summary text not null,
    published integer not null default 0 check (published in (0, 1)),
    created_by integer references users(id) on delete set null,
    created_at integer not null
  );
  create table action_runs (
    id integer primary key,
    repo_id integer not null references repos(id) on delete cascade,
    name text not null,
    head_sha text not null,
    status text not null check (status in ('queued', 'in_progress', 'completed')),
    conclusion text check (conclusion in ('success', 'failure', 'cancelled')),
    created_at integer not null
  );
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
