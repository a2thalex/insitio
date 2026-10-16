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
