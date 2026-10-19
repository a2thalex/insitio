/** Encodes each path segment but keeps the slashes, for refs and file paths in URLs. */
export function encPath(p: string): string {
  return p
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

export function repoUrl(owner: string, name: string, ...rest: string[]): string {
  return [`/${owner}/${name}`, ...rest.filter(Boolean)].join("/");
}

export function treeUrl(owner: string, name: string, ref: string, path = ""): string {
  return repoUrl(owner, name, "tree", encPath(ref), path && encPath(path));
}

export function blobUrl(owner: string, name: string, ref: string, path: string): string {
  return repoUrl(owner, name, "blob", encPath(ref), encPath(path));
}

export function rawUrl(owner: string, name: string, ref: string, path: string): string {
  return repoUrl(owner, name, "raw", encPath(ref), encPath(path));
}

export function commitUrl(owner: string, name: string, sha: string): string {
  return repoUrl(owner, name, "commit", sha);
}

export function commitsUrl(owner: string, name: string, ref: string, path = ""): string {
  return repoUrl(owner, name, "commits", encPath(ref)) + (path ? `?path=${encodeURIComponent(path)}` : "");
}

export function blameUrl(owner: string, name: string, ref: string, path: string): string {
  return repoUrl(owner, name, "blame", encPath(ref), encPath(path));
}

export function editUrl(owner: string, name: string, ref: string, path: string): string {
  return repoUrl(owner, name, "edit", encPath(ref), encPath(path));
}

export function newFileUrl(owner: string, name: string, ref: string, dir = ""): string {
  return repoUrl(owner, name, "new", encPath(ref), dir && encPath(dir));
}

export function uploadUrl(owner: string, name: string, ref: string, dir = ""): string {
  return repoUrl(owner, name, "upload", encPath(ref), dir && encPath(dir));
}

export function deleteUrl(owner: string, name: string, ref: string, path: string): string {
  return repoUrl(owner, name, "delete", encPath(ref), encPath(path));
}

/** `heads` and `tags` use GitHub's `/archive/refs/...` shape. A commit uses `/archive/<sha>.zip`. */
export function archiveUrl(owner: string, name: string, kind: "heads" | "tags" | "sha", ref: string, format: "zip" | "tar.gz"): string {
  if (kind === "sha") return repoUrl(owner, name, "archive", `${ref}.${format}`);
  return repoUrl(owner, name, "archive", "refs", kind, `${encPath(ref)}.${format}`);
}
