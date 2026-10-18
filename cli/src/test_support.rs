//! Test-only helpers shared by the modules that talk to a server or to git:
//! an isolated environment, loopback HTTP servers, and small git fixtures.
//! Nothing here reaches beyond this machine: the servers listen on 127.0.0.1.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use git2::{FetchOptions, Oid, RemoteCallbacks, Repository, RepositoryInitOptions, Signature};

use crate::config::HostConfig;
use crate::credentials::{NO_KEYCHAIN_ENV, TOKEN_ENV};
use crate::error::NsitError;
use crate::git::pull::{fetch_head_of, Theirs};
use crate::output::Out;
use crate::test_env::EnvGuard;

/// File store only, in a throwaway config dir, and no `NSIT_TOKEN`: the real
/// credential store and the real config are never touched.
pub(crate) fn isolated_env(dir: &Path) -> EnvGuard {
    EnvGuard::lock()
        .set("NSIT_CONFIG_DIR", dir)
        .set(NO_KEYCHAIN_ENV, "1")
        .unset(TOKEN_ENV)
        .unset("NSIT_HOST")
}

pub(crate) fn host_entry_for(user: &str, name: Option<&str>, email: Option<&str>) -> HostConfig {
    HostConfig {
        user: user.into(),
        name: name.map(str::to_string),
        email: email.map(str::to_string),
    }
}

pub(crate) fn out_with(tty: bool, quiet: bool) -> Out {
    Out {
        json: false,
        jq: None,
        tty,
        color: false,
        quiet,
    }
}

/// An empty repository in `dir` on branch `main`, whose own config makes a
/// test independent of the machine it runs on.
///
/// libgit2 also reads the system and global git configuration (a developer's
/// `core.autocrlf=true`, a global excludes file that hides `.env`, their
/// identity). `HOME` cannot be changed for that from inside the test process:
/// libgit2 works out those locations once, when it starts. What the local
/// file sets wins over them, so these tests get the same answers everywhere.
pub(crate) fn local_repo(dir: &Path) -> Repository {
    let mut options = RepositoryInitOptions::new();
    options.initial_head("main");
    let repo = Repository::init_opts(dir, &options).unwrap();
    {
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Test").unwrap();
        config.set_str("user.email", "test@example.com").unwrap();
        config.set_str("core.autocrlf", "false").unwrap();
        let no_excludes = repo.path().join("no-global-excludes");
        config
            .set_str("core.excludesfile", no_excludes.to_str().unwrap())
            .unwrap();
    }
    repo
}

/// Write `name`, stage it and commit it on the current branch of `repo`.
pub(crate) fn commit_file(repo: &Repository, name: &str, content: &str) {
    std::fs::write(repo.workdir().unwrap().join(name), content).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(name)).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = Signature::now("Test", "test@example.com").unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, name, &tree, &parents)
        .unwrap();
}

/// Write `rel` (made with its directories) in the working directory of `repo`.
pub(crate) fn write_file(repo: &Repository, rel: &str, content: impl AsRef<[u8]>) {
    let path = repo.workdir().unwrap().join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

/// Point `HEAD` at `branch` and check it out, replacing the working files.
pub(crate) fn checkout_branch(repo: &Repository, branch: &str) {
    repo.set_head(&format!("refs/heads/{branch}")).unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .unwrap();
}

/// A repository on `main` with `a.txt` = "base\n" committed, and a branch
/// `theirs` at that same commit.
pub(crate) fn diverged_repo(dir: &Path) -> Repository {
    let repo = local_repo(dir);
    commit_file(&repo, "a.txt", "base\n");
    {
        let base = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("theirs", &base, false).unwrap();
    }
    repo
}

/// Start merging `branch` into `HEAD`, as `nsit pull` does: `MERGE_HEAD` is
/// written and the index and working files are updated, with conflict markers
/// where the two sides disagree. Nothing is committed.
pub(crate) fn merge_branch(repo: &Repository, branch: &str) {
    let theirs = repo.find_branch(branch, git2::BranchType::Local).unwrap();
    let theirs = repo.reference_to_annotated_commit(theirs.get()).unwrap();
    repo.merge(&[&theirs], None, None).unwrap();
}

/// Stage a file whose name is exactly these bytes (not necessarily text) with
/// this content, in the repository's in-memory index, as if `nsit add` had done
/// it. No file is made in the working directory. `Index::add` takes the bytes as
/// they are, which `Path` cannot on every system.
pub(crate) fn stage_raw(repo: &Repository, path: &[u8], content: &[u8]) {
    let entry = git2::IndexEntry {
        ctime: git2::IndexTime::new(0, 0),
        mtime: git2::IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode: 0o100_644,
        uid: 0,
        gid: 0,
        file_size: content.len() as u32,
        id: repo.blob(content).unwrap(),
        flags: 0,
        flags_extended: 0,
        path: path.to_vec(),
    };
    repo.index().unwrap().add(&entry).unwrap();
}

/// A repository with a few commits, in `dir/source`.
pub(crate) fn source_repo(dir: &Path) -> PathBuf {
    let path = dir.join("source");
    std::fs::create_dir(&path).unwrap();
    let repo = Repository::init(&path).unwrap();
    for i in 0..5 {
        commit_file(
            &repo,
            &format!("file{i}.txt"),
            &format!("contents {i}\n").repeat(50),
        );
    }
    path
}

/// Fetch everything from the repository at `source` into a new one at `dest`.
pub(crate) fn fetch_with(source: &Path, dest: &Path, callbacks: RemoteCallbacks<'_>) {
    let repo = Repository::init(dest).unwrap();
    let mut remote = repo.remote_anonymous(source.to_str().unwrap()).unwrap();
    let mut options = FetchOptions::new();
    options.remote_callbacks(callbacks);
    remote
        .fetch(
            &["+refs/heads/*:refs/remotes/src/*"],
            Some(&mut options),
            None,
        )
        .unwrap();
}

// ---- loopback servers ---------------------------------------------------------------

/// A server that answers one request with `body` (JSON, status 200) and hands
/// back the request it was sent. If nothing connects within 5 s it panics, so
/// a regression fails the test instead of hanging it (the caller's `join`
/// then fails too).
pub(crate) fn serve_once(body: &'static str) -> (String, thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let handle = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                Err(_) => panic!("serve_once: nothing connected within 5 s"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut seen = Vec::new();
        let mut buf = [0u8; 1024];
        while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = stream.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            seen.extend_from_slice(&buf[..n]);
        }
        let reply = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(reply.as_bytes()).unwrap();
        String::from_utf8_lossy(&seen).into_owned()
    });
    (host, handle)
}

/// What a request carried that matters to the tests.
#[derive(Debug, Clone)]
pub(crate) struct Seen {
    pub request_line: String,
    pub authorization: Option<String>,
}

type Reply = dyn Fn(&Seen) -> String + Send + Sync;

/// An HTTP server on 127.0.0.1 that answers every request with whatever
/// `reply` returns (a complete HTTP response), and records the connections
/// made and the requests sent. The accept loop polls, so nothing ever blocks.
pub(crate) struct StubServer {
    port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
    connections: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
}

impl StubServer {
    pub fn start(reply: impl Fn(&Seen) -> String + Send + Sync + 'static) -> StubServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let connections = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let reply: Arc<Reply> = Arc::new(reply);
        let (seen_in, connections_in, stop_in) = (
            Arc::clone(&seen),
            Arc::clone(&connections),
            Arc::clone(&stop),
        );
        thread::spawn(move || {
            while !stop_in.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        connections_in.fetch_add(1, Ordering::Relaxed);
                        let (seen, reply) = (Arc::clone(&seen_in), Arc::clone(&reply));
                        thread::spawn(move || answer_requests(stream, &seen, &*reply));
                    }
                    Err(_) => thread::sleep(Duration::from_millis(10)),
                }
            }
        });
        StubServer {
            port,
            seen,
            connections,
            stop,
        }
    }

    /// Stands in for Insitio's git endpoint with a token it does not accept:
    /// `401 Unauthorized` and a Basic challenge for everything.
    pub fn refusing() -> StubServer {
        StubServer::start(|_| {
            "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"insitio\"\r\nContent-Length: 0\r\n\r\n"
                .to_string()
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// `http://127.0.0.1:<port>`
    pub fn host(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// `127.0.0.1:<port>`, what nsit calls this server.
    pub fn host_key(&self) -> String {
        format!("127.0.0.1:{}", self.port)
    }

    pub fn requests(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    /// How many connections the server has accepted after waiting `wait` for
    /// any that were on their way.
    pub fn connections_after(&self, wait: Duration) -> usize {
        thread::sleep(wait);
        self.connections.load(Ordering::Relaxed)
    }
}

impl Drop for StubServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Answer each request on this connection until the client leaves.
fn answer_requests(mut stream: TcpStream, seen: &Mutex<Vec<Seen>>, reply: &Reply) {
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();
    let mut pending = Vec::new();
    let mut buf = [0u8; 2048];
    loop {
        while let Some(end) = pending.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&pending[..end]).into_owned();
            // These requests are GETs; none has a body to skip.
            pending.drain(..end + 4);
            let mut lines = head.lines();
            let request_line = lines.next().unwrap_or_default().to_string();
            let authorization = lines
                .filter_map(|l| l.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
                .map(|(_, value)| value.trim().to_string());
            let request = Seen {
                request_line,
                authorization,
            };
            seen.lock().unwrap().push(request.clone());
            if stream.write_all(reply(&request).as_bytes()).is_err() {
                return;
            }
        }
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => pending.extend_from_slice(&buf[..n]),
        }
    }
}

/// Standard base64, to compare against Basic auth headers.
pub(crate) fn base64(input: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in input.as_bytes().chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

// ---- clones of one server repository, for `pull`, `abort` and `ORIG_HEAD` ------------------------
//
// The "server" is a bare repository that the clones reach by path, through libgit2's local
// transport: everything below the HTTP step of a pull (the fetch, the analysis, the merge, the
// checkouts, the abort) is the real code.

/// The URL the merge message names in these tests.
pub(crate) const REMOTE_URL: &str = "https://git.iam.bot/ada/demo.git";

/// An empty bare repository: the server.
pub(crate) fn server_at(dir: &Path) -> PathBuf {
    let path = dir.join("server.git");
    Repository::init_bare(&path).unwrap();
    path
}

/// A repository on `main` with no commits, whose `origin` is the server.
pub(crate) fn work_repo(dir: &Path, name: &str, server: &Path) -> Repository {
    let path = dir.join(name);
    std::fs::create_dir(&path).unwrap();
    let repo = local_repo(&path);
    repo.remote("origin", server.to_str().unwrap()).unwrap();
    repo
}

/// Send `main` to the server (replacing its `main`).
pub(crate) fn push_main(repo: &Repository, server: &Path) {
    repo.remote_anonymous(server.to_str().unwrap())
        .unwrap()
        .push(&["+refs/heads/main:refs/heads/main"], None)
        .unwrap();
}

/// What `pull` fetches: the server's `main`, named by `FETCH_HEAD`.
pub(crate) fn fetch_main(repo: &Repository, server: &Path) -> Oid {
    fetch_head_of(repo, server.to_str().unwrap(), "main", FetchOptions::new())
        .unwrap()
        .expect("the server has a main")
}

/// A copy of the server's `main`, checked out.
pub(crate) fn clone_main(dir: &Path, name: &str, server: &Path) -> Repository {
    let repo = work_repo(dir, name, server);
    let tip = fetch_main(&repo, server);
    repo.reference("refs/heads/main", tip, true, "clone")
        .unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .unwrap();
    repo
}

/// A server whose `main` has `a.txt` = "base" and `keep.txt` = "keep", and two clones of it.
pub(crate) fn two_clones(dir: &Path) -> (PathBuf, Repository, Repository) {
    let server = server_at(dir);
    let one = work_repo(dir, "one", &server);
    commit_file(&one, "a.txt", "base\n");
    commit_file(&one, "keep.txt", "keep\n");
    push_main(&one, &server);
    let two = clone_main(dir, "two", &server);
    (server, one, two)
}

/// `one` changed a.txt and pushed; `two` committed keep.txt: histories diverged, no conflict.
pub(crate) fn diverged_without_conflict(dir: &Path) -> (PathBuf, Repository, Repository) {
    let (server, one, two) = two_clones(dir);
    commit_file(&one, "a.txt", "from one\n");
    push_main(&one, &server);
    commit_file(&two, "keep.txt", "from two\n");
    (server, one, two)
}

/// `one` and `two` both edited a.txt, and `one` also added added.txt.
pub(crate) fn diverged_with_conflict(dir: &Path) -> (PathBuf, Repository, Repository) {
    let (server, one, two) = two_clones(dir);
    commit_file(&one, "a.txt", "theirs\n");
    commit_file(&one, "added.txt", "added by them\n");
    push_main(&one, &server);
    commit_file(&two, "a.txt", "ours\n");
    (server, one, two)
}

/// `main`'s `fetch_main` as what a pull brings in.
pub(crate) fn theirs(id: Oid) -> Theirs<'static> {
    Theirs {
        id,
        branch: "main",
        label: "origin/main",
        url: REMOTE_URL,
    }
}

/// Who makes the merge commit.
pub(crate) fn me() -> Result<Signature<'static>, NsitError> {
    Ok(Signature::now("Puller", "puller@example.com").unwrap())
}

/// For a pull that makes no commit: asking who commits is a bug.
pub(crate) fn nobody() -> Result<Signature<'static>, NsitError> {
    panic!("nothing is committed, so nobody needs to say who is committing")
}

pub(crate) fn head(repo: &Repository) -> Oid {
    repo.head().unwrap().target().unwrap()
}

/// Every ref with what it points at, sorted: what a refused command must leave as it was.
pub(crate) fn all_refs(repo: &Repository) -> Vec<(String, String)> {
    let mut refs: Vec<(String, String)> = repo
        .references()
        .unwrap()
        .map(|r| {
            let r = r.unwrap();
            let target = r
                .target()
                .map(|id| id.to_string())
                .or_else(|| r.symbolic_target().ok().flatten().map(str::to_string))
                .unwrap_or_default();
            (r.name().unwrap().to_string(), target)
        })
        .collect();
    refs.sort();
    refs
}

/// Every file of the working directory (`.git` left out) with its text.
pub(crate) fn files(repo: &Repository) -> BTreeMap<String, String> {
    fn walk(root: &Path, dir: &Path, found: &mut BTreeMap<String, String>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.file_name().unwrap() == ".git" {
                continue;
            }
            if path.is_dir() {
                walk(root, &path, found);
            } else {
                let name = path.strip_prefix(root).unwrap().to_string_lossy();
                found.insert(
                    name.replace('\\', "/"),
                    std::fs::read_to_string(&path).unwrap(),
                );
            }
        }
    }
    let root = repo.workdir().unwrap();
    let mut found = BTreeMap::new();
    walk(root, root, &mut found);
    found
}

/// Which of the files a merge in progress leaves in the git directory are there.
pub(crate) fn merge_state(repo: &Repository) -> Vec<&'static str> {
    ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE"]
        .into_iter()
        .filter(|name| repo.path().join(name).exists())
        .collect()
}

/// What `ORIG_HEAD` holds, as text; `None` when there is no such file.
pub(crate) fn orig_head_text(repo: &Repository) -> Option<String> {
    std::fs::read_to_string(repo.path().join("ORIG_HEAD")).ok()
}

/// The index file as libgit2 reads it from disk: every entry with its stage and blob.
pub(crate) fn index_on_disk(repo: &Repository) -> Vec<(String, u16, Oid)> {
    let mut index = repo.index().unwrap();
    index.read(true).unwrap();
    index
        .iter()
        .map(|e| {
            (
                String::from_utf8_lossy(&e.path).into_owned(),
                e.flags & 0x3000,
                e.id,
            )
        })
        .collect()
}

/// Do the index and the working files match `HEAD`? (Untracked files do not count.)
pub(crate) fn no_changes(repo: &Repository) -> bool {
    let mut options = git2::StatusOptions::new();
    options.include_untracked(false);
    repo.statuses(Some(&mut options)).unwrap().is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_known_encoding() {
        assert_eq!(base64("ada:secret"), "YWRhOnNlY3JldA==");
        assert_eq!(base64("ab"), "YWI=");
        assert_eq!(base64("abc"), "YWJj");
    }

    #[test]
    fn the_stub_server_counts_connections_and_records_requests() {
        let server = StubServer::start(|_| "HTTP/1.1 204 No Content\r\n\r\n".to_string());
        assert_eq!(server.connections_after(Duration::from_millis(50)), 0);
        let mut stream = TcpStream::connect(("127.0.0.1", server.port())).unwrap();
        stream
            .write_all(b"GET /x HTTP/1.1\r\nHost: h\r\nAuthorization: Basic abc\r\n\r\n")
            .unwrap();
        let mut reply = [0u8; 64];
        let n = stream.read(&mut reply).unwrap();
        assert!(String::from_utf8_lossy(&reply[..n]).starts_with("HTTP/1.1 204"));
        assert_eq!(server.connections_after(Duration::from_millis(10)), 1);
        let seen = server.requests();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].request_line, "GET /x HTTP/1.1");
        assert_eq!(seen[0].authorization.as_deref(), Some("Basic abc"));
    }
}
