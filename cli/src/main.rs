//! nsit: the Insitio command-line tool for people and agents.
//!
//! Every v1 command is implemented: `auth`, `repo`, the local git commands (`init`,
//! `status`, `add`, `commit`, `log`, `branch`, `switch`, `readme`) and the three that
//! talk to a repository on Insitio over git (`clone`, `push`, `pull`).

mod api;
mod cli;
mod commands;
mod config;
mod credentials;
mod error;
mod git;
mod output;
mod repo_ref;
#[cfg(test)]
pub(crate) mod test_env;
#[cfg(test)]
pub(crate) mod test_support;

use std::io::Write;

use clap::Parser;

use cli::{Cli, Command};
use error::NsitError;
use output::Out;

fn main() {
    let cli = Cli::parse();
    if let Err(err) = run(&cli) {
        // A closed stderr must not turn an error into a panic.
        let _ = writeln!(std::io::stderr(), "nsit: {err}");
        std::process::exit(err.exit_code());
    }
}

fn run(cli: &Cli) -> Result<(), NsitError> {
    // Before anything else (a libgit2 setting that must be changed while nothing else is
    // using libgit2): a server that stops answering must not hang a clone, push or pull.
    git::set_network_timeouts()?;
    // Resolve output settings first so a bad `--jq` fails (exit 2) before
    // any command has side effects.
    let g = &cli.global;
    let out = Out::new(g.json, g.jq.clone(), g.quiet, g.no_color)?;
    // `-C <dir>` is resolved against the process directory once, here; the
    // local commands act in the result and never change the process directory.
    let base = || commands::working_dir(g.dir.as_deref());

    match &cli.command {
        Command::Auth(args) => commands::auth::run(args, g, &out),
        Command::Repo(args) => commands::repo::run(args, g, &out),
        Command::Init(args) => commands::init::run(args, g, &out, &base()?),
        Command::Status => commands::status::run(g, &out, &base()?),
        Command::Add(args) => commands::add::run(args, g, &out, &base()?),
        Command::Commit(args) => commands::commit::run(args, g, &out, &base()?),
        Command::Log(args) => commands::log::run(args, g, &out, &base()?),
        Command::Branch(args) => commands::branch::run(args, g, &out, &base()?),
        Command::Switch(args) => commands::switch::run(args, g, &out, &base()?),
        Command::Readme => commands::readme::run(g, &out, &base()?),
        Command::Clone(args) => commands::clone::run(args, g, &out, &base()?),
        Command::Push(args) => commands::push::run(args, g, &out, &base()?),
        Command::Pull(args) => commands::pull::run(args, g, &out, &base()?),
    }
}

#[cfg(test)]
mod tests {
    /// libgit2's socket timeouts are global settings that may only be changed before anything
    /// else uses libgit2, so `run` sets them first, ahead of anything a command can do. Rust has
    /// no way to call `main`, so this reads the source, as `git::auth`'s test of its own entry
    /// point does.
    #[test]
    fn run_sets_libgit2s_timeouts_before_anything_else() {
        let source = include_str!("main.rs");
        let (production, _) = source
            .rsplit_once("\n#[cfg(test)]\nmod tests")
            .expect("the tests module is at the end");
        let call = production
            .find("git::set_network_timeouts()?")
            .expect("run must set the network timeouts");
        let run = production.find("fn run(").expect("run exists");
        let first_work = production.find("Out::new(").expect("run builds its output");
        assert!(
            run < call && call < first_work,
            "the timeouts are set at the start of run, before anything else"
        );
    }
}
