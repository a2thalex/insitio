//! Command-line grammar: global flags and every v1 subcommand.
//!
//! The subcommands only declare their flags here. Each later task fills in
//! the body of the commands it owns.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

/// `nsit --version` prints `nsit <version> (<commit>)`.
const VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), " (", env!("NSIT_GIT_SHA"), ")");

/// Insitio from the command line: use it instead of git.
#[derive(Debug, Parser)]
#[command(name = "nsit", bin_name = "nsit", version = VERSION, propagate_version = true)]
pub struct Cli {
    #[command(flatten)]
    pub global: GlobalArgs,

    #[command(subcommand)]
    pub command: Command,
}

/// Flags every command accepts, before or after the subcommand.
#[derive(Debug, Args)]
pub struct GlobalArgs {
    /// Insitio host or URL (default: $NSIT_HOST, then git.iam.bot)
    #[arg(long, global = true, value_name = "HOST")]
    pub host: Option<String>,

    /// Print machine-readable JSON instead of text
    #[arg(long, global = true)]
    pub json: bool,

    /// Filter the JSON output with a jq expression (implies --json); strings print raw, other values as JSON
    #[arg(long, global = true, value_name = "EXPR")]
    pub jq: Option<String>,

    /// Suppress progress and hint messages
    #[arg(short, long, global = true)]
    pub quiet: bool,

    /// Never use color
    #[arg(long, global = true)]
    pub no_color: bool,

    /// Run as if nsit was started in this directory
    #[arg(short = 'C', global = true, value_name = "DIR")]
    pub dir: Option<PathBuf>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Sign in, sign out, or show who you are signed in as
    Auth(AuthArgs),
    /// Start a repository here, or in a new directory, optionally on Insitio
    Init(InitArgs),
    /// Copy a repository from Insitio
    Clone(CloneArgs),
    /// Show staged, unstaged and untracked changes, and ahead/behind
    Status,
    /// Stage files for the next commit
    Add(AddArgs),
    /// Commit changes
    Commit(CommitArgs),
    /// Show the history of the current branch
    Log(LogArgs),
    /// List, create or delete branches
    Branch(BranchArgs),
    /// Switch to another branch
    Switch(SwitchArgs),
    /// Fetch from Insitio, then fast-forward or merge
    Pull(PullArgs),
    /// Send commits to Insitio
    Push(PushArgs),
    /// Write a starter README.md if there is none
    Readme,
    /// Create, list and view repositories on Insitio
    Repo(RepoArgs),
}

#[derive(Debug, Args)]
pub struct AuthArgs {
    #[command(subcommand)]
    pub command: AuthCommand,
}

#[derive(Debug, Subcommand)]
pub enum AuthCommand {
    /// Sign in with a browser approval, or with a token read from stdin
    Login(LoginArgs),
    /// Revoke this machine's token and forget it
    Logout,
    /// Show the signed-in account and where its token is stored
    Status,
}

#[derive(Debug, Args)]
pub struct LoginArgs {
    /// Read an access token from stdin instead of using the browser
    #[arg(long)]
    pub with_token: bool,
}

#[derive(Debug, Args)]
pub struct InitArgs {
    /// Repository name; also creates it on Insitio and sets `origin`
    pub name: Option<String>,

    /// Create the repository on Insitio even without a name
    #[arg(long)]
    pub remote: bool,

    /// Write a starter README.md and make the first commit
    #[arg(long)]
    pub readme: bool,

    /// Make the repository on Insitio public (it is private by default)
    #[arg(long)]
    pub public: bool,
}

#[derive(Debug, Args)]
pub struct CloneArgs {
    /// `name` (yours), `owner/name`, or a full URL
    pub repo: String,

    // Not called `dir`: clap tells arguments apart by name, and the global
    // `-C <DIR>` flag already is `dir`, so a positional of that name would take
    // over its value (a test guards this).
    /// Directory to clone into (default: the repository name)
    #[arg(value_name = "DIR")]
    pub directory: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct AddArgs {
    /// Files or directories to stage
    #[arg(required = true, num_args = 1..)]
    pub paths: Vec<PathBuf>,
}

#[derive(Debug, Args)]
pub struct CommitArgs {
    /// Commit message
    #[arg(short, long, value_name = "MSG")]
    pub message: Option<String>,

    /// Commit only what was staged with `nsit add`
    #[arg(long)]
    pub staged: bool,

    /// Record PATH in .nsit-allow-secrets and commit it despite the secret guard
    #[arg(long, value_name = "PATH")]
    pub allow_secret: Vec<PathBuf>,
}

#[derive(Debug, Args)]
pub struct LogArgs {
    /// Show at most N commits
    #[arg(short = 'n', long = "max-count", value_name = "N")]
    pub max_count: Option<usize>,

    /// One line per commit
    #[arg(long)]
    pub oneline: bool,
}

#[derive(Debug, Args)]
pub struct BranchArgs {
    /// Create a branch with this name; without it, list branches
    #[arg(conflicts_with = "delete")]
    pub name: Option<String>,

    /// Delete the branch with this name
    #[arg(short = 'd', long, value_name = "NAME")]
    pub delete: Option<String>,
}

#[derive(Debug, Args)]
pub struct SwitchArgs {
    /// Branch to switch to
    pub branch: String,

    /// Create the branch first
    #[arg(short = 'c', long)]
    pub create: bool,
}

#[derive(Debug, Args)]
pub struct PullArgs {
    /// Abandon a merge that stopped on conflicts: throws away your conflict resolutions and restores the files as they were before the pull (untracked files stay)
    #[arg(long)]
    pub abort: bool,
}

#[derive(Debug, Args)]
pub struct PushArgs {
    /// Branch to push (default: the current branch)
    pub branch: Option<String>,

    /// Set the branch's upstream even if it has one (the first push of a branch sets it by itself)
    #[arg(short = 'u', long)]
    pub set_upstream: bool,

    /// Overwrite the remote branch, but only if it is where we last saw it
    #[arg(long)]
    pub force_with_lease: bool,
}

#[derive(Debug, Args)]
pub struct RepoArgs {
    #[command(subcommand)]
    pub command: RepoCommand,
}

#[derive(Debug, Subcommand)]
pub enum RepoCommand {
    /// Create a repository on Insitio (private unless --public)
    Create(RepoCreateArgs),
    /// List repositories you can see
    List(RepoListArgs),
    /// Show one repository
    View(RepoViewArgs),
}

#[derive(Debug, Args)]
pub struct RepoCreateArgs {
    /// Repository name
    pub name: String,

    /// One-line description
    #[arg(long)]
    pub description: Option<String>,

    /// Make the repository public
    #[arg(long)]
    pub public: bool,
}

#[derive(Debug, Args)]
pub struct RepoListArgs {
    /// Only repositories owned by this user
    #[arg(long, value_name = "USER")]
    pub owner: Option<String>,
}

#[derive(Debug, Args)]
pub struct RepoViewArgs {
    /// `name` (yours), `owner/name`, or a full URL
    pub repo: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::error::ErrorKind;
    use clap::CommandFactory;

    fn parse(args: &[&str]) -> Result<Cli, clap::Error> {
        Cli::try_parse_from(std::iter::once("nsit").chain(args.iter().copied()))
    }

    #[test]
    fn grammar_is_internally_consistent() {
        Cli::command().debug_assert();
    }

    #[test]
    fn version_string_names_the_commit() {
        assert!(VERSION.starts_with(env!("CARGO_PKG_VERSION")));
        assert!(VERSION.ends_with(')'));
        let sha = VERSION.rsplit_once('(').unwrap().1.trim_end_matches(')');
        assert!(
            sha == "unknown" || (sha.len() == 7 && sha.chars().all(|c| c.is_ascii_hexdigit())),
            "{sha}"
        );
    }

    #[test]
    fn global_flags_work_before_and_after_the_subcommand() {
        let a = parse(&["--json", "--host", "h.example", "-q", "repo", "list"]).unwrap();
        let b = parse(&["repo", "list", "--json", "--host", "h.example", "-q"]).unwrap();
        for cli in [a, b] {
            assert!(cli.global.json && cli.global.quiet);
            assert_eq!(cli.global.host.as_deref(), Some("h.example"));
        }
    }

    /// Where each global flag's value ends up: clap tells arguments apart by
    /// name, so a subcommand's own argument called `dir` would be the same
    /// argument as `-C`, and its value would be read as `-C`'s.
    #[test]
    fn no_subcommand_argument_shares_a_name_with_a_global_flag() {
        fn collisions(
            command: &clap::Command,
            globals: &[String],
            path: &str,
            found: &mut Vec<String>,
        ) {
            for sub in command.get_subcommands() {
                let here = format!("{path} {}", sub.get_name());
                for arg in sub.get_arguments().filter(|a| !a.is_global_set()) {
                    if globals.iter().any(|g| g == arg.get_id().as_str()) {
                        found.push(format!("{here}: {}", arg.get_id()));
                    }
                }
                collisions(sub, globals, &here, found);
            }
        }
        let root = Cli::command();
        let globals: Vec<String> = root
            .get_arguments()
            .filter(|a| a.is_global_set())
            .map(|a| a.get_id().to_string())
            .collect();
        assert!(globals.contains(&"dir".to_string()), "{globals:?}");
        let mut found = Vec::new();
        collisions(&root, &globals, "nsit", &mut found);
        assert!(
            found.is_empty(),
            "shares a name with a global flag: {found:?}"
        );
    }

    #[test]
    fn clone_directory_is_not_the_c_flag() {
        let Command::Clone(plain) = parse(&["clone", "ada/demo", "target"]).unwrap().command else {
            panic!("not clone")
        };
        assert_eq!(plain.repo, "ada/demo");
        assert_eq!(plain.directory, Some(PathBuf::from("target")));

        // Together, in either place, each lands in its own field.
        for args in [
            &["-C", "elsewhere", "clone", "ada/demo", "target"][..],
            &["clone", "ada/demo", "target", "-C", "elsewhere"],
            &["clone", "-C", "elsewhere", "ada/demo", "target"],
        ] {
            let cli = parse(args).unwrap();
            assert_eq!(cli.global.dir, Some(PathBuf::from("elsewhere")), "{args:?}");
            let Command::Clone(clone) = cli.command else {
                panic!("not clone")
            };
            assert_eq!(clone.directory, Some(PathBuf::from("target")), "{args:?}");
        }

        // Without a directory argument, -C is only -C, and the other way round.
        let cli = parse(&["-C", "elsewhere", "clone", "ada/demo"]).unwrap();
        let Command::Clone(clone) = cli.command else {
            panic!("not clone")
        };
        assert_eq!(clone.directory, None);
        assert_eq!(cli.global.dir, Some(PathBuf::from("elsewhere")));
        let cli = parse(&["clone", "ada/demo", "target"]).unwrap();
        assert_eq!(cli.global.dir, None, "a directory to clone into is not -C");
    }

    #[test]
    fn jq_no_color_and_dir_flags() {
        let cli = parse(&["status", "--jq", ".a", "--no-color", "-C", "some dir"]).unwrap();
        assert_eq!(cli.global.jq.as_deref(), Some(".a"));
        assert!(cli.global.no_color);
        assert_eq!(cli.global.dir, Some(PathBuf::from("some dir")));
        assert!(
            !cli.global.json,
            "--jq implies json in Out, not in the parser"
        );
    }

    #[test]
    fn every_v1_command_parses_with_its_flags() {
        let invocations: &[&[&str]] = &[
            &["auth", "login"],
            &["auth", "login", "--with-token"],
            &["auth", "logout"],
            &["auth", "status"],
            &["init"],
            &["init", "demo"],
            &["init", "demo", "--remote", "--readme"],
            &["init", "demo", "--public"],
            &["clone", "ada/demo"],
            &["clone", "demo", "target"],
            &["clone", "https://git.iam.bot/ada/demo.git"],
            &["status"],
            &["add", "a.txt", "dir"],
            &["commit", "-m", "msg"],
            &["commit", "-m", "msg", "--staged", "--allow-secret", ".env"],
            &["commit"],
            &["log"],
            &["log", "-n", "5", "--oneline"],
            &["branch"],
            &["branch", "feature"],
            &["branch", "-d", "feature"],
            &["switch", "main"],
            &["switch", "-c", "feature"],
            &["pull"],
            &["pull", "--abort"],
            &["push"],
            &["push", "-u", "main"],
            &["push", "--force-with-lease"],
            &["readme"],
            &["repo", "create", "tools"],
            &["repo", "create", "tools", "--description", "d", "--public"],
            &["repo", "list"],
            &["repo", "list", "--owner", "ada"],
            &["repo", "view", "ada/tools"],
        ];
        for args in invocations {
            parse(args).unwrap_or_else(|e| panic!("`nsit {}` should parse: {e}", args.join(" ")));
        }
    }

    #[test]
    fn init_flags_land_in_the_right_fields() {
        let Command::Init(i) = parse(&["init", "demo", "--remote", "--readme", "--public"])
            .unwrap()
            .command
        else {
            panic!("not init")
        };
        assert_eq!(i.name.as_deref(), Some("demo"));
        assert!(i.remote && i.readme && i.public);

        let Command::Init(plain) = parse(&["init"]).unwrap().command else {
            panic!("not init")
        };
        assert_eq!(plain.name, None);
        assert!(!plain.remote && !plain.readme && !plain.public);
    }

    #[test]
    fn flags_land_in_the_right_fields() {
        let Command::Push(p) = parse(&["push", "-u", "dev", "--force-with-lease"])
            .unwrap()
            .command
        else {
            panic!("not push")
        };
        assert!(p.set_upstream && p.force_with_lease);
        assert_eq!(p.branch.as_deref(), Some("dev"));

        let Command::Log(l) = parse(&["log", "-n", "3", "--oneline"]).unwrap().command else {
            panic!("not log")
        };
        assert_eq!(l.max_count, Some(3));
        assert!(l.oneline);

        let Command::Branch(b) = parse(&["branch", "-d", "old"]).unwrap().command else {
            panic!("not branch")
        };
        assert_eq!(b.delete.as_deref(), Some("old"));
        assert_eq!(b.name, None);

        let Command::Commit(c) = parse(&[
            "commit",
            "-m",
            "x",
            "--allow-secret",
            "a",
            "--allow-secret",
            "b",
        ])
        .unwrap()
        .command
        else {
            panic!("not commit")
        };
        assert_eq!(c.allow_secret, vec![PathBuf::from("a"), PathBuf::from("b")]);
    }

    #[test]
    fn usage_mistakes_are_clap_errors() {
        for args in [
            &["frobnicate"][..],
            &[],
            &["add"],
            &["switch"],
            &["clone"],
            &["log", "-n", "many"],
            &["branch", "x", "-d", "y"],
            &["repo"],
            &["auth"],
        ] {
            let err = parse(args).unwrap_err();
            assert_ne!(err.kind(), ErrorKind::DisplayHelp, "{args:?}");
            assert_eq!(err.exit_code(), 2, "{args:?}");
        }
    }
}
