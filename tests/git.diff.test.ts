import { describe, it, expect } from "vitest";
import { parseUnifiedDiff } from "../src/git/diff.js";

const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,4 +10,5 @@ function main() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 return a;
\\ No newline at end of file
diff --git a/old name.txt b/new name.txt
similarity index 100%
rename from old name.txt
rename to new name.txt
diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..3333333
Binary files /dev/null and b/logo.png differ
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 4444444..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

describe("parseUnifiedDiff", () => {
  const files = parseUnifiedDiff(DIFF);

  it("parses modified files with line numbers", () => {
    const f = files[0];
    expect(f).toMatchObject({ oldPath: "src/app.ts", newPath: "src/app.ts", status: "modified", additions: 2, deletions: 1 });
    expect(f.hunks).toHaveLength(1);
    expect(f.hunks[0].header).toBe("@@ -10,4 +10,5 @@ function main() {");
    expect(f.hunks[0].lines.map((l) => [l.type, l.oldNo, l.newNo, l.text])).toEqual([
      ["ctx", 10, 10, "const a = 1;"],
      ["del", 11, null, "const b = 2;"],
      ["add", null, 11, "const b = 3;"],
      ["add", null, 12, "const c = 4;"],
      ["ctx", 12, 13, "return a;"],
    ]);
  });

  it("parses renames, binaries and deletions", () => {
    expect(files[1]).toMatchObject({ oldPath: "old name.txt", newPath: "new name.txt", status: "renamed", hunks: [] });
    expect(files[2]).toMatchObject({ newPath: "logo.png", status: "added", binary: true });
    expect(files[3]).toMatchObject({ oldPath: "gone.txt", status: "deleted", deletions: 1 });
  });
});
