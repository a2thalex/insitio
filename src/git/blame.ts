export type BlameHunk = {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  /** Author date, unix seconds. */
  date: number;
  summary: string;
  /** 1-based line number of the first line in this hunk. */
  startLine: number;
  lines: string[];
};

/**
 * Groups `git blame --line-porcelain` output into hunks of consecutive lines
 * from the same commit, the way the GitHub blame view does.
 */
export function parseBlame(porcelain: string): BlameHunk[] {
  const hunks: BlameHunk[] = [];
  for (const rec of porcelain.split(/\n(?=[0-9a-f]{40} )/)) {
    if (!/^[0-9a-f]{40} /.test(rec)) continue;
    const rows = rec.split("\n");
    const head = rows[0].split(" ");
    const sha = head[0];
    const finalLine = Number(head[2]);
    if (!Number.isInteger(finalLine) || finalLine < 1) continue;
    let authorName = "";
    let authorEmail = "";
    let date = 0;
    let summary = "";
    let text = "";
    for (const row of rows.slice(1)) {
      if (row.startsWith("\t")) text = row.slice(1);
      else if (row.startsWith("author ")) authorName = row.slice("author ".length);
      else if (row.startsWith("author-mail ")) authorEmail = row.slice("author-mail ".length).replace(/^<|>$/g, "");
      else if (row.startsWith("author-time ")) date = Number(row.slice("author-time ".length));
      else if (row.startsWith("summary ")) summary = row.slice("summary ".length);
    }
    const prev = hunks.at(-1);
    if (prev && prev.sha === sha && prev.startLine + prev.lines.length === finalLine) prev.lines.push(text);
    else hunks.push({ sha, shortSha: sha.slice(0, 7), authorName, authorEmail, date, summary, startLine: finalLine, lines: [text] });
  }
  return hunks;
}

/** `git shortlog -sne` lines: `    12\tName <email>`. */
export function parseShortlog(text: string): { name: string; email: string; commits: number }[] {
  const out: { name: string; email: string; commits: number }[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\t(.*) <(.*)>\s*$/.exec(line);
    if (m) out.push({ commits: Number(m[1]), name: m[2], email: m[3] });
  }
  return out;
}
