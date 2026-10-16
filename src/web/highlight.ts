import hljs from "highlight.js";
import { escapeHtml } from "./format.js";

const MAX_HIGHLIGHT_BYTES = 512 * 1024;

const BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  "cmakelists.txt": "cmake",
  gemfile: "ruby",
  rakefile: "ruby",
  ".gitignore": "plaintext",
  ".bashrc": "bash",
  ".zshrc": "bash",
};

export function languageFor(filename: string): string | null {
  const base = filename.split("/").pop()!.toLowerCase();
  if (BY_NAME[base]) return BY_NAME[base];
  const ext = base.includes(".") ? base.split(".").pop()! : "";
  if (ext && hljs.getLanguage(ext)) return ext;
  return null;
}

/** Splits highlighted HTML into lines, closing and reopening spans that cross line breaks. */
function splitLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let cur = "";
  for (const tok of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (!tok) continue;
    if (tok === "\n") {
      lines.push(cur + "</span>".repeat(open.length));
      cur = open.join("");
    } else if (tok.startsWith("<span")) {
      open.push(tok);
      cur += tok;
    } else if (tok === "</span>") {
      open.pop();
      cur += tok;
    } else {
      cur += tok;
    }
  }
  lines.push(cur + "</span>".repeat(open.length));
  return lines;
}

export function highlightCode(code: string, lang: string | null): string {
  if (lang && hljs.getLanguage(lang) && code.length <= MAX_HIGHLIGHT_BYTES) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // fall through to plain text
    }
  }
  return escapeHtml(code);
}

/** Highlighted HTML for each line of a file, or escaped text when the language is unknown. */
export function highlightLines(code: string, filename: string): string[] {
  const text = code.endsWith("\n") ? code.slice(0, -1) : code;
  return splitLines(highlightCode(text, languageFor(filename)));
}
