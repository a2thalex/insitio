import { createHash } from "node:crypto";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Sizes in 1024-based units, matching GitHub's "3.68 KB" for 3768 bytes. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} Bytes`;
  const units = ["KB", "MB", "GB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(2).replace(/\.?0+$/, "")} ${units[i]}`;
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["week", 7 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

/** "2 days ago", "last month", "now" — the phrasing GitHub uses for relative times. */
export function timeAgo(ts: number, nowS = Math.floor(Date.now() / 1000)): string {
  const diff = ts - nowS;
  for (const [unit, secs] of STEPS) {
    if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
  }
  return "now";
}

export function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** A deterministic 5x5 mirrored identicon, so avatars need no external service. */
export function identicon(name: string): string {
  const h = createHash("sha256").update(name.toLowerCase()).digest();
  const hue = Math.round((h[0] / 255) * 360);
  const color = `hsl(${hue} 55% 55%)`;
  const cells: string[] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if ((h[1 + y * 3 + x] & 1) === 0) continue;
      for (const cx of x === 2 ? [2] : [x, 4 - x]) {
        cells.push(`<rect x="${cx * 14 + 5}" y="${y * 14 + 5}" width="14" height="14"/>`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="#f0f0f0"/><g fill="${color}">${cells.join("")}</g></svg>`;
}
