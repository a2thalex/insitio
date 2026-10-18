//! nsit: the Insitio command-line tool for people and agents.
//!
//! `auth`, `repo`, `clone` and the local git commands (`init`, `status`, `add`,
//! `commit`, `log`, `branch`, `switch`, `readme`) are implemented; `pull` and
//! `push` are still stubs that later tasks fill in, and with them use the
//! network helpers that only `clone` calls so far.

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
        Command::Pull(_) | Command::Push(_) => Err(NsitError::Other("not implemented".into())),
    }
}
