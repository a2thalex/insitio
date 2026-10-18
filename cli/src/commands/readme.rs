//! `nsit readme`: write a starter `README.md` when the repository has none.
//!
//! The text and the rules (never overwrite, description only from the selected
//! host, never an error for being offline) are `git::readme`. An existing README
//! is exit 1 here.

use std::path::Path;

use serde::Serialize;

use crate::cli::GlobalArgs;
use crate::config::resolve_host;
use crate::error::NsitError;
use crate::git::open_repo;
use crate::git::origin::origin_on;
use crate::git::readme::{description_of, write_readme, Written, README};
use crate::output::Out;

/// `--json` for `nsit readme`.
#[derive(Debug, Serialize)]
struct ReadmeJson {
    path: &'static str,
    description: bool,
}

pub fn run(global: &GlobalArgs, out: &Out, base: &Path) -> Result<(), NsitError> {
    let repo = open_repo(base)?;
    let host = resolve_host(global.host.as_deref());
    let origin = origin_on(&repo, &host);
    let description = origin
        .as_ref()
        .and_then(|target| description_of(&host, target));
    match write_readme(&repo, origin.as_ref(), description.as_deref())? {
        Written::AlreadyThere => Err(NsitError::Other(format!(
            "{README} already exists; nsit does not overwrite it"
        ))),
        Written::Created => out.data(
            &ReadmeJson {
                path: README,
                description: description.is_some(),
            },
            |_| format!("wrote {README}"),
        ),
    }
}
