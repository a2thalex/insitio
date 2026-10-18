//! Embeds the commit that built the binary so `nsit --version` can print it.
//!
//! CI passes the commit in `GITHUB_SHA`; local builds report `unknown`.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    println!("cargo:rustc-env=NSIT_GIT_SHA={}", short_sha());
}

fn short_sha() -> String {
    let sha: String = std::env::var("GITHUB_SHA")
        .unwrap_or_default()
        .trim()
        .chars()
        .take(7)
        .collect();
    // Only hex digits may reach the `cargo:` directive above.
    if !sha.is_empty() && sha.chars().all(|c| c.is_ascii_hexdigit()) {
        sha
    } else {
        "unknown".to_string()
    }
}
