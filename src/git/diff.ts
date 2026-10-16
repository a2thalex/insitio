export type DiffLine = { type: "add" | "del" | "ctx"; oldNo: number | null; newNo: number | null; text: string };
export type Hunk = { header: string; lines: DiffLine[] };
export type DiffFile = {
  oldPath: string;
  newPath: string;
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: Hunk[];
};

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function unquote(p: string): string {
  if (!p.startsWith('"')) return p;
  try {
    return JSON.parse(p);
  } catch {
    return p.slice(1, -1);
  }
}

function stripPrefix(p: string): string {
  const u = unquote(p);
  return u.replace(/^[ab]\//, "");
}

/** Parses `git diff` / `git diff-tree -p` output into files, hunks and numbered lines. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git (.+?) (b\/.+|"b\/.+")$/.exec(line);
      const a = m ? stripPrefix(m[1]) : "";
      const b = m ? stripPrefix(m[2]) : "";
      file = { oldPath: a, newPath: b, status: "modified", binary: false, additions: 0, deletions: 0, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (hunk) {
      const c = line[0];
      if (c === "+") {
        hunk.lines.push({ type: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
        file.additions++;
        continue;
      }
      if (c === "-") {
        hunk.lines.push({ type: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
        file.deletions++;
        continue;
      }
      if (c === " ") {
        hunk.lines.push({ type: "ctx", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
        continue;
      }
      if (c === "\\") continue;
    }
    const h = HUNK.exec(line);
    if (h) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      continue;
    }
    hunk = null;
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.oldPath = unquote(line.slice(12));
      file.status = "renamed";
    } else if (line.startsWith("rename to ")) file.newPath = unquote(line.slice(10));
    else if (line.startsWith("--- ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") file.oldPath = stripPrefix(p);
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") file.newPath = stripPrefix(p);
    } else if (line.startsWith("Binary files ")) file.binary = true;
  }
  return files;
}
