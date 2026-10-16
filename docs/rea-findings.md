# REA findings: how github.com's core pages are built

Date: 2026-10-16. Tool: REA (`rea-agents` 6.5.0, same version as the
`morluto/rea` clone at `../rea`), run under Node 24.22.0 because REA's engine
range excludes Node 25.

## Method

- Chrome 155 started with a dedicated profile and
  `--remote-debugging-port=9222`, signed out, on public pages of
  `sharkdp/bat`.
- Per page: `rea inspect-web-page --include-accessibility-text`
  (DOM, accessibility tree, network) and `rea capture-web-screenshot`.
- `rea analyze-web-bundle` on the repo home with
  `--allowed-origins https://github.com --allowed-origins https://github.githubassets.com`
  (GitHub serves its JS from the assets origin; with only `github.com`
  allowed REA admits 0 scripts). 134 scripts parsed, 183 chunk edges.
- One live SPA navigation (folder click on the tree page) observed with
  `inspect-web-page --observation-ms 9000 --include-json-body-shapes`.
- Raw evidence lives in `docs/rea-evidence/` (gitignored: large, and the
  screenshots are GitHub's UI). Accessibility outlines were produced from it.

Pages: repo home, `tree/master/src`, `blob/master/Cargo.toml`,
`commits/master`, `commit/master`, `issues`, `pulls`, `pulls?q=is:pr is:merged`,
`pull/4064`, `pull/4064/files`, user profile `sharkdp`.

Confidence labels follow REA: **observed** = in a capture; **inferred** =
reasoning from observations.

## 1. Routes (observed, from bundle analysis)

The client router declares these patterns (`property:path` detector):

```
/:owner/:repo
/:owner/:repo/tree/:branch/*
/:owner/:repo/blob/:branch/*
/:owner/:repo/blame/:branch/*
/:owner/:repo/edit/:branch/*
/:owner/:repo/new/:branch/*
/:owner/:repo/delete/:branch/*
/:owner/:repo/tree/delete/:branch/*
```

Server-rendered pages observed directly: `/:owner/:repo/commits/:ref`,
`/:owner/:repo/commit/:sha-or-ref`, `/:owner/:repo/issues`,
`/:owner/:repo/pulls`, `/:owner/:repo/pull/:n`, `/:owner/:repo/pull/:n/files`,
`/:owner`.

**GitFkd adopts** this URL scheme verbatim for tree/blob/commits/commit/issues/
pulls/pull/files and the profile.

## 2. How code-view data loads (observed, live network capture)

Clicking a folder in the tree view does not reload the page. It issues four
same-origin JSON requests (value-free shapes recorded by REA, full list in
`docs/rea-evidence/spa-json-shapes.txt`):

| Request | Purpose (inferred from shape) | Key fields |
|---|---|---|
| `GET /:owner/:repo/tree/:ref/:path` (JSON) | Directory listing | `payload.codeViewTreeRoute.tree.items[] {name, path, contentType}`, `tree.totalCount`, `tree.readme`, `refInfo {name, refType, currentOid, canEdit}` |
| `POST /:owner/:repo/_file_tree` body `{branch, start, stop}` | Left file-tree panel, per folder | `payload.fileTree.fileTree[<path>].items[]`, `foldersToFetch[]` |
| `GET /:owner/:repo/latest-commit/:ref/:path` | Latest-commit bar above the listing | `oid, date, shortMessageHtmlLink, bodyMessageHtml, author{login, avatarUrl}, status` |
| `GET /:owner/:repo/tree-commit-info/:ref/:path` | Last commit for **each entry** | `entries[<name>] {oid, date, shortMessageHtmlLink, url}` |

Finding: the directory listing and the per-file "last commit message / date"
columns come from **separate requests**. The listing is cheap (`ls-tree`);
per-entry last-commit lookup is the expensive part and is deferred.

**GitFkd adopts** the same split: tree pages render the listing server-side
immediately; a small script fetches `/:owner/:repo/tree-commit-info/:ref/*path`
and fills the last-commit columns. The listing works without JavaScript.

## 3. Page anatomy (observed, accessibility tree + screenshots)

### Global chrome
- `banner`: logo link, global `navigation`, a search button
  ("Search or jump to, type / to search"), sign in / sign up, appearance toggle.
- `main`, then `contentinfo` footer with a footer `navigation`.
- Color: the capture profile rendered GitHub's dark theme (system preference).

### Repository header (all repo pages)
- `navigation "Breadcrumbs"`: `owner / repo`.
- `navigation "Repository"`: tabs Code, Issues (count), Pull requests (count),
  then Discussions, Actions, Security, Insights. Active tab has an underline.
- Title row: repo name, visibility label (`Public`), right-aligned actions:
  Notifications, Fork (count), Star (count).

### Code tab (repo home)
- Toolbar: branch selector button (`master branch`), `N Branches`, `N Tags`,
  `Go to file` combobox, green `Code` button (clone URL dropdown).
- Latest-commit box: author, message (PR refs linked), status check,
  short SHA, relative time, `N Commits` history link.
- `table "Folders and files"` with column headers **Name / Last commit
  message / Last commit date**; folders first, then files, each name cell
  suffixed `(Directory)` / `(File)` for screen readers.
- README rendered below the table.
- Right sidebar "About": description, topics, Readme, license, stars,
  watching, forks; then Releases, Contributors.

### Tree and blob views
- Left `Files` panel: branch selector, search button, `Go to file`, and
  `navigation "File Tree Navigation"` (collapsible).
- Breadcrumb path with `Copy path`.
- File latest-commit bar with `History` link.
- Blob: `Code | Blame` toggle, metadata line ("133 lines (121 loc) · 3.68 KB"),
  `Raw`, copy, download; content region with line numbers.

### Commits list
- Filters: branch selector, user selector, date picker.
- `Commit history` grouped by day: heading "Commits on Oct 14, 2026" then a
  list of commits: message heading, author, time, `Copy full SHA`,
  `Browse repository at this point`.

### Single commit
- Heading "Commit 62b439d", `Browse files`, author, parents (linked SHAs).
- Left file tree with filter; per-file `region` with a diff `grid` whose
  columns are **Original file line number / Diff line number / Diff line
  change**, hunk header rows (`@@ -355,13 +355,13 @@ …`) and expand up/down.

### Issues list
- `complementary` sidebar: filter shortcuts (Assigned to me, Created by me,
  Mentioned), Milestones, Labels.
- `New issue` button, search `combobox` with query syntax.
- `Open (331) / Closed (1,311)` state toggle; filter buttons author, labels,
  projects, milestones, assignees; sort.
- `list "Issues"`: each item has a title heading link, label buttons,
  author, linked-PR count.

### Pull request
- Title + `#number`, state badge (purple **Merged**; open is green, closed
  red), "keith-hall merged 3 commits into `sharkdp:master` from
  `ump45nose:branch`", copy branch name.
- `navigation "Pull request navigation"`: Conversation (n), Commits (n),
  Checks (n), Files changed (n), and a diffstat (+3 −3).
- Conversation: timeline of comments, commits, reviews, and events
  (merged, auto-merge, mentions).
- Right sidebar: Reviewers, Assignees, Labels, Projects, Milestone,
  Development (linked issues), participants.
- Files changed: same diff grid as the commit page.
- PRs and issues share one number sequence: **inferred** (issue and PR links
  on these pages draw from one `#n` space, e.g. PR #4064 and issue
  references like #3577 in commit messages; the captures do not prove it).

### User profile
- `navigation "User profile"`: Overview, Repositories (n), Projects,
  Packages, Stars (n).
- Left column: name, login, bio; pinned repos; contribution graph; activity.

## 4. Decisions for GitFkd

1. Same URL scheme as section 1; refs containing `/` resolved by longest
   matching branch name.
2. Lazy per-entry last-commit info via `/tree-commit-info/` JSON (section 2).
3. Repo header with breadcrumbs, tabs with counts, star button + count.
4. Code tab: branch selector, branch count, clone box, latest-commit bar,
   three-column file table, README, About sidebar.
5. Blob view: line numbers, metadata line, Raw link; Blame is out of scope
   for v1.
6. Commits grouped by day; commit and PR diffs share one diff-table component
   with old/new line-number columns and hunk headers.
7. Issues/PRs share numbering; PR states Open/Merged/Closed with
   green/purple/red badges; PR tabs Conversation/Commits/Files changed with
   counts and a diffstat.
8. Issues list: Open/Closed toggle with counts, label filter, search box.
9. Profile: Overview/Repositories/Stars tabs.
10. Light and dark themes following the system preference (Primer color
    modes).
11. Not adopted: Discussions, Actions, Security, Insights, Projects,
    Milestones, Checks, reviews/approvals, Codespaces, Copilot,
    sponsors, releases (outside v1 scope in the spec).
