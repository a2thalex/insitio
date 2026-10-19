import { ValidationError } from "./errors.js";

/** The body of the first suggestion fence. A closing fence is a line that is only ```. Null when there is none. */
export function suggestionBlock(body: string): string | null {
  const lines = body.split(/\r?\n/).map((line) => line.replace(/\r$/, ""));
  const start = lines.findIndex((line) => line.trim() === "```suggestion");
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.trim() === "```");
  if (end < 0) return null;
  return lines.slice(start + 1, end).join("\n");
}

/**
 * Replaces one line. `line` is 1-based and must still equal `lineText`.
 * An empty suggestion deletes the line. The result keeps a trailing newline when the file had one.
 */
export function applySuggestionToFile(content: string, line: number, lineText: string, suggestion: string): string {
  const trailing = content.endsWith("\n");
  const lines = content.split("\n");
  if (trailing) lines.pop();
  if (line < 1 || line > lines.length || lines[line - 1] !== lineText) {
    throw new ValidationError("The line changed, so the suggestion was not applied.");
  }
  const replacement = suggestion === "" ? [] : suggestion.split("\n");
  lines.splice(line - 1, 1, ...replacement);
  if (lines.length === 0) return "";
  return lines.join("\n") + (trailing ? "\n" : "");
}
