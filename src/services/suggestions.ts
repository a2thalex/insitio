import { ValidationError } from "./errors.js";

/** The body of the first ```suggestion fence, without a trailing newline. Null when there is none. */
export function suggestionBlock(body: string): string | null {
  const match = /```suggestion\r?\n([\s\S]*?)```/.exec(body);
  if (!match) return null;
  return match[1].replace(/\n$/, "");
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
