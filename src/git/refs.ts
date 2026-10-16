/**
 * Splits a URL remainder like "feature/x/src/a.ts" into a ref and a path.
 * The longest matching branch or tag wins, as on GitHub; a leading hex segment
 * is taken as a commit id.
 */
export function splitRefAndPath(segments: string, refs: string[]): { ref: string; path: string } | null {
  const s = segments.replace(/^\/+|\/+$/g, "");
  const match = [...refs]
    .sort((a, b) => b.length - a.length)
    .find((r) => s === r || s.startsWith(r + "/"));
  if (match) return { ref: match, path: s.slice(match.length + 1) };
  const [first, ...rest] = s.split("/");
  if (/^[0-9a-f]{7,40}$/i.test(first)) return { ref: first, path: rest.join("/") };
  return null;
}
