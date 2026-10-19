import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Deps } from "../deps.js";
import { clientAddress } from "../clientAddress.js";
import { installPushHook } from "../git/hooks.js";
import { Repo } from "../git/repo.js";
import { GIT_ENV } from "../git/run.js";
import { repoDir, reposRoot } from "../git/storage.js";
import { scanPushedCommits } from "../services/issueExtras.js";
import { accessLevel, can, type Access } from "../services/permissions.js";
import { deployKeyAccess, deliverWebhooks, protectedRefList } from "../services/repoAdmin.js";
import { getRepo, setDefaultBranch, type RepoRow } from "../services/repos.js";
import { userForAccessToken, type User } from "../services/users.js";

export type GitRoute = {
  owner: string;
  repo: string;
  /** Path after the repo, e.g. "info/refs" or "git-upload-pack". */
  rest: string;
  service: "git-upload-pack" | "git-receive-pack";
};

const ROUTE = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Recognizes smart-HTTP git requests; everything else belongs to the web app. */
export function matchGitRoute(url: string): GitRoute | null {
  let u: URL;
  try {
    // Prefix a fixed origin so paths like "//host" can't be read as a different authority.
    u = new URL(`http://localhost${url.startsWith("/") ? "" : "/"}${url}`);
  } catch {
    return null;
  }
  const m = ROUTE.exec(u.pathname);
  if (!m) return null;
  const rest = m[3];
  const service = rest === "info/refs" ? u.searchParams.get("service") : rest;
  if (service !== "git-upload-pack" && service !== "git-receive-pack") return null;
  return { owner: m[1], repo: m[2], rest, service };
}

function send(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(message + "\n");
}

/** Basic auth where the password is a personal access token, as with GitHub. */
function authenticate(deps: Deps, req: IncomingMessage): { user: User | null; invalid: boolean; password: string } {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return { user: null, invalid: false, password: "" };
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i === -1) return { user: null, invalid: true, password: "" };
  const password = decoded.slice(i + 1);
  const user = userForAccessToken(deps.db, decoded.slice(0, i), password);
  return { user, invalid: !user, password };
}

/** After a push into an empty repo, point HEAD at a branch that exists (main, master or the first). */
async function fixHead(deps: Deps, repo: RepoRow) {
  const git = new Repo(repoDir(deps.config.dataDir, repo.owner, repo.name));
  if (await git.resolve(repo.defaultBranch)) return;
  const branches = (await git.branches()).map((b) => b.name);
  const pick = ["main", "master"].find((b) => branches.includes(b)) ?? branches[0];
  if (!pick) return;
  await git.setHead(pick);
  setDefaultBranch(deps.db, repo.id, pick);
}

/**
 * Read the rest of `req` and throw it away, so that a client that is still uploading is not reset before it
 * has read the answer. This is for requests nobody is reading any more, so it is bounded: past `maxBytes`
 * more of body, or `idleMs` with no data, the connection is closed. (The client that goes on sending after an
 * answer has been given is a client that was not going to be told anything new.)
 */
export function drainRequest(req: IncomingMessage, maxBytes: number, idleMs: number): void {
  if (req.readableEnded || req.destroyed) return;
  let drained = 0;
  let idle: NodeJS.Timeout | undefined;
  const stop = () => clearTimeout(idle);
  const giveUp = () => {
    stop();
    req.socket.destroy();
  };
  const wait = () => {
    clearTimeout(idle);
    idle = setTimeout(giveUp, idleMs);
  };
  req.on("data", (chunk: Buffer) => {
    drained += chunk.length;
    if (drained > maxBytes) giveUp();
    else wait();
  });
  req.once("end", stop);
  req.once("close", stop);
  req.once("error", stop);
  wait();
  req.resume();
}

export async function handleGitHttp(req: IncomingMessage, res: ServerResponse, deps: Deps, route: GitRoute): Promise<void> {
  const repo = getRepo(deps.db, route.owner, route.repo);
  const { user, invalid, password } = authenticate(deps, req);
  const challenge = { "www-authenticate": 'Basic realm="Insitio"' };
  if (invalid && !(repo && deployKeyAccess(deps.db, password, repo.id))) {
    return send(res, 401, "Invalid username or token. Use a personal access token as the password.", challenge);
  }
  const keyAccess = repo && !user ? deployKeyAccess(deps.db, password, repo.id) : null;
  const access: Access = keyAccess ?? (repo ? accessLevel(deps.db, user, repo) : "none");
  const need = route.service === "git-receive-pack" ? "write" : "read";
  if (repo?.archived && route.service === "git-receive-pack") {
    if (!user && !keyAccess) return send(res, 401, "Authentication required.", challenge);
    return send(res, 403, "This repository is archived.");
  }
  if (!repo || access === "none") {
    // Ask anonymous clients for credentials first, so private repos never reveal whether they exist.
    if (!user) return send(res, 401, "Authentication required.", challenge);
    return send(res, 404, "Repository not found.");
  }
  if (!can(access, need)) {
    if (!user) return send(res, 401, "Authentication required.", challenge);
    return send(res, 403, `Permission to ${repo.owner}/${repo.name} denied to ${user.username}.`);
  }

  const receiving = route.service === "git-receive-pack" && route.rest === "git-receive-pack";
  const repoDirectory = repoDir(deps.config.dataDir, repo.owner, repo.name);
  if (receiving) await installPushHook(repoDirectory);
  const beforeDefault = receiving ? new Repo(repoDirectory).resolve(repo.defaultBranch) : Promise.resolve(null);
  const url = new URL(req.url ?? "/", "http://localhost");
  const env: Record<string, string> = {
    ...GIT_ENV,
    GIT_PROJECT_ROOT: reposRoot(deps.config.dataDir),
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: `/${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}.git/${route.rest}`,
    REQUEST_METHOD: req.method ?? "GET",
    QUERY_STRING: url.search.replace(/^\?/, ""),
    CONTENT_TYPE: req.headers["content-type"] ?? "",
    REMOTE_USER: user?.username ?? "",
    INSITIO_PUSH_ADMIN: access === "admin" ? "1" : "0",
    INSITIO_PROTECTED_REFS: protectedRefList(deps.db, repo.id),
    REMOTE_ADDR: clientAddress(req.socket.remoteAddress, req.headers["x-forwarded-for"] as string | undefined, deps.config.trustedProxies),
  };
  if (req.headers["content-length"]) env.CONTENT_LENGTH = String(req.headers["content-length"]);
  if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = String(req.headers["content-encoding"]);
  if (req.headers["git-protocol"]) env.GIT_PROTOCOL = String(req.headers["git-protocol"]);

  const child = spawn("git", ["http-backend"], { env: { ...process.env, ...env }, windowsHide: true });
  req.pipe(child.stdin);
  child.stdin.on("error", () => {});
  child.stderr.on("data", (d) => console.error(`[git http-backend] ${String(d).trim()}`));

  // git http-backend speaks CGI: headers, a blank line, then the body. Once the
  // headers are parsed the body is piped, so a slow client applies backpressure.
  let head = Buffer.alloc(0);
  let headersSent = false;
  const onHead = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const sep = head.indexOf("\r\n\r\n") !== -1 ? head.indexOf("\r\n\r\n") : head.indexOf("\n\n");
    if (sep === -1) return;
    const sepLen = head[sep] === 0x0d ? 4 : 2;
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head.subarray(0, sep).toString("latin1").split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i === -1) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k.toLowerCase() === "status") status = parseInt(v, 10) || 200;
      else headers[k] = v;
    }
    res.writeHead(status, headers);
    headersSent = true;
    res.write(head.subarray(sep + sepLen));
    child.stdout.off("data", onHead);
    child.stdout.pipe(res, { end: false });
  };
  child.stdout.on("data", onHead);
  // git can stop reading before the upload is over (a pack above receive.maxInputSize, a fatal error), and
  // git may never start. The client is still sending then, and a connection that nobody reads from gets
  // reset under it, so it reports a broken upload instead of git's answer (for a push: "unpacker error").
  // So what is left of the request is read and dropped, within limits (see `drainRequest`).
  let draining = false;
  const drain = () => {
    if (draining) return;
    draining = true;
    req.unpipe(child.stdin);
    drainRequest(req, deps.config.gitDrainMaxBytes, deps.config.gitDrainIdleMs);
  };
  child.on("error", (err) => {
    console.error("git http-backend failed to start", err);
    send(res, 500, "Git backend unavailable.");
    drain();
  });
  child.on("close", async (code) => {
    drain();
    if (!headersSent) {
      send(res, 500, `Git backend exited with code ${code}.`);
      return;
    }
    if (route.service === "git-receive-pack" && route.rest === "git-receive-pack") {
      try {
        const before = await beforeDefault;
        await fixHead(deps, repo);
        const fresh = getRepo(deps.db, repo.owner, repo.name) ?? repo;
        if (user) await scanPushedCommits(deps, fresh, user, new Repo(repoDir(deps.config.dataDir, fresh.owner, fresh.name)), before);
        await deliverWebhooks(deps, fresh, "push", { ref: `refs/heads/${fresh.defaultBranch}`, pusher: user?.username ?? "deploy-key" });
      } catch (err) {
        console.error("Could not update HEAD after push", err);
      }
    }
    res.end();
  });
  res.on("close", () => {
    if (child.exitCode === null) child.kill();
  });
}
