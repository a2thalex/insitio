export type LanguageShare = { name: string; bytes: number; color: string; percent: number };

/** Linguist colors for the languages the bar knows about. */
const LANGUAGES: Record<string, { color: string; extensions?: string[]; filenames?: string[] }> = {
  TypeScript: { color: "#3178c6", extensions: ["ts", "tsx", "mts", "cts"] },
  JavaScript: { color: "#f1e05a", extensions: ["js", "jsx", "mjs", "cjs"] },
  Python: { color: "#3572A5", extensions: ["py", "pyi"] },
  Go: { color: "#00ADD8", extensions: ["go"] },
  Rust: { color: "#dea584", extensions: ["rs"] },
  Java: { color: "#b07219", extensions: ["java"] },
  Kotlin: { color: "#A97BFF", extensions: ["kt", "kts"] },
  C: { color: "#555555", extensions: ["c", "h"] },
  "C++": { color: "#f34b7d", extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx"] },
  "C#": { color: "#178600", extensions: ["cs"] },
  Ruby: { color: "#701516", extensions: ["rb"], filenames: ["gemfile", "rakefile"] },
  PHP: { color: "#4F5D95", extensions: ["php"] },
  Swift: { color: "#F05138", extensions: ["swift"] },
  HTML: { color: "#e34c26", extensions: ["html", "htm"] },
  CSS: { color: "#663399", extensions: ["css"] },
  SCSS: { color: "#c6538c", extensions: ["scss"] },
  Shell: { color: "#89e051", extensions: ["sh", "bash", "zsh"] },
  PowerShell: { color: "#012456", extensions: ["ps1", "psm1"] },
  Markdown: { color: "#083fa1", extensions: ["md", "markdown", "mdown"] },
  Vue: { color: "#41b883", extensions: ["vue"] },
  Svelte: { color: "#ff3e00", extensions: ["svelte"] },
  Dart: { color: "#00B4AB", extensions: ["dart"] },
  Lua: { color: "#000080", extensions: ["lua"] },
  Haskell: { color: "#5e5086", extensions: ["hs"] },
  Elixir: { color: "#6e4a7e", extensions: ["ex", "exs"] },
  Erlang: { color: "#B83998", extensions: ["erl", "hrl"] },
  Scala: { color: "#c22d40", extensions: ["scala"] },
  R: { color: "#198CE7", extensions: ["r"] },
  Perl: { color: "#0298c3", extensions: ["pl", "pm"] },
  "Objective-C": { color: "#438eff", extensions: ["m"] },
  Dockerfile: { color: "#384d54", filenames: ["dockerfile"] },
  HCL: { color: "#844FBA", extensions: ["hcl", "tf"] },
  Zig: { color: "#ec915c", extensions: ["zig"] },
  Nix: { color: "#7e7eff", extensions: ["nix"] },
  Clojure: { color: "#db5855", extensions: ["clj", "cljs"] },
  OCaml: { color: "#ef7a08", extensions: ["ml", "mli"] },
  Julia: { color: "#a270ba", extensions: ["jl"] },
  Solidity: { color: "#AA6746", extensions: ["sol"] },
  Makefile: { color: "#427819", filenames: ["makefile"] },
  CMake: { color: "#DA3434", filenames: ["cmakelists.txt"] },
  Assembly: { color: "#6E4C13", extensions: ["s", "asm"] },
};

const BY_EXT = new Map<string, string>();
const BY_NAME = new Map<string, string>();
for (const [name, lang] of Object.entries(LANGUAGES)) {
  for (const ext of lang.extensions ?? []) BY_EXT.set(ext, name);
  for (const file of lang.filenames ?? []) BY_NAME.set(file, name);
}

const IGNORE_DIRS = new Set(["node_modules", "vendor", "dist", "build"]);
const MAX_FILE = 1024 * 1024;

function ignored(path: string): boolean {
  const base = path.split("/").pop()!.toLowerCase();
  if (base.endsWith(".min.js") || base.endsWith(".lock")) return true;
  return path.split("/").some((seg) => IGNORE_DIRS.has(seg));
}

/** Programming languages plus Markdown. Images, data and other prose are left out. */
export function languageOf(path: string): string | null {
  if (ignored(path)) return null;
  const base = path.split("/").pop()!.toLowerCase();
  if (BY_NAME.has(base)) return BY_NAME.get(base)!;
  const ext = base.includes(".") ? base.split(".").pop()! : "";
  return BY_EXT.get(ext) ?? null;
}

export function languageShares(files: { path: string; size: number }[]): LanguageShare[] {
  const totals = new Map<string, number>();
  for (const file of files) {
    if (file.size > MAX_FILE || file.size < 0) continue;
    const name = languageOf(file.path);
    if (!name) continue;
    totals.set(name, (totals.get(name) ?? 0) + file.size);
  }
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  if (sum === 0) return [];
  return [...totals.entries()]
    .map(([name, bytes]) => ({ name, bytes, color: LANGUAGES[name].color, percent: (bytes / sum) * 100 }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}
