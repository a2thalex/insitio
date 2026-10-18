//! nsit: the Insitio command-line tool for people and agents.
//!
//! `nsit auth` and `nsit repo` are implemented; the other subcommands are still
//! stubs that later tasks fill in, and with them use the git helpers that
//! nothing calls yet.

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
    // Resolve output settings first so a bad `--jq` fails (exit 2) before
    // any command has side effects.
    let g = &cli.global;
    let out = Out::new(g.json, g.jq.clone(), g.quiet, g.no_color)?;

    match &cli.command {
        Command::Auth(args) => commands::auth::run(args, g, &out),
        Command::Repo(args) => commands::repo::run(args, g, &out),
        Command::Init(_)
        | Command::Clone(_)
        | Command::Status
        | Command::Add(_)
        | Command::Commit(_)
        | Command::Log(_)
        | Command::Branch(_)
        | Command::Switch(_)
        | Command::Pull(_)
        | Command::Push(_)
        | Command::Readme => Err(NsitError::Other("not implemented".into())),
    }
}
