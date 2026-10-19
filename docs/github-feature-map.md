# GitHub feature map vs Insitio

Mapped 2026-10-17 in Chrome from github.com (signed in as a2thalex, repo a2thalex/gitfkd):
repository tabs, repository settings, user settings and Insights navigation.
✓ = Insitio has it, ◐ = partial, ✗ = missing.

## Repository: Code
| GitHub | Insitio |
|---|---|
| File tree, file view, raw, history, commit diffs | ✓ |
| Branch/tag switcher, branches page | ✓ |
| Code search in repo | ✓ (default branch, text only) |
| Blame view | ✓ |
| Edit, create, upload, delete files in the browser | ✓ |
| Create/delete branches in the UI | ✓ |
| Releases and tags pages, release assets | ✓ |
| Download ZIP / tarball | ✓ |
| Fork, Watch | ✓ |
| Topics, language bar, license detection, contributors list | ✓ |
| Line-range permalinks (#L10-L20) | ✓ |

## Repository: Issues
| GitHub | Insitio |
|---|---|
| Open/close/reopen, comments, labels, filters, search | ✓ |
| Assignees, milestones | ✓ |
| Edit/delete comments, reactions | ✓ |
| Issue templates, close reasons, lock, pin, sub-issues | ◐ (sub-issues still missing) |
| Cross-references and "Fixes #n" auto-close | ✓ |

## Repository: Pull requests
| GitHub | Insitio |
|---|---|
| Compare, open, conversation, commits, files, merge commit | ✓ |
| Reviewers, approve / request changes | ✓ |
| Line-level review comments, suggestions | ✓ (suggestions are shown, not applied) |
| Draft PRs, squash and rebase merge, delete branch after merge | ✓ |
| Update branch, PR templates, required checks | ✓ |

## Repository: other tabs
| GitHub tab | Insitio |
|---|---|
| Actions (CI workflows, runners, logs, status checks) | ✗ |
| Projects (boards) | ✗ |
| Wiki, Discussions | ✗ |
| Security and quality (advisories, secret scanning, Dependabot) | ✗ |
| Insights (pulse, contributors, traffic, commit activity, network, forks) | ✗ |
| Agents (Copilot coding agent) | ✗ |

## Repository settings
| GitHub section | Insitio |
|---|---|
| General: description, visibility, default branch, delete | ✓ |
| General: rename, transfer, archive, feature toggles, merge-button options | ✓ |
| Collaborators | ✓ (read/write/admin) |
| Branches / rulesets (protection) | ◐ (exact branch, require a pull request, approving reviews) |
| Webhooks | ✓ |
| Deploy keys | ✓ (repo-scoped git HTTP tokens, not SSH) |
| Environments, Pages, Codespaces, Actions/Agents settings, GitHub Apps | ✗ |

## Account (user settings)
| GitHub section | Insitio |
|---|---|
| Public profile, password, personal access tokens | ✓ |
| Emails, SSH and GPG keys, sessions, two-factor auth | ✓ (keys are stored; SSH git is still later) |
| Notifications preferences, appearance/theme | ✓ (preference is saved; no mail is sent) |
| Organizations, teams, blocked users, saved replies | ◐ (blocks and saved replies; organizations are later) |
| Applications, security log, developer settings | ◐ (security log; tokens already existed) |

## Site-wide
| GitHub | Insitio |
|---|---|
| Dashboard with your repos and open work | ✓ |
| Repository search | ✓ |
| Notifications inbox | ✗ |
| Activity feed, explore/trending | ◐ (recent repos only) |
| Global code/issue/user search | ✗ |
| Organizations and teams | ✗ |
| Gists, packages, sponsors, marketplace, Codespaces, Pages | ✗ |
| SSH git transport, Git LFS | ✗ |
| Email notifications | ✗ |
