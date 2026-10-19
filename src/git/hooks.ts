import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PRE_RECEIVE = `#!/bin/sh
protected=",\${INSITIO_PROTECTED_REFS:-},"
while read -r old new ref; do
  case "$protected" in
    *",$ref,"*)
      if [ "\${INSITIO_PUSH_ADMIN:-0}" != "1" ]; then
        echo "Refusing to update protected branch \${ref#refs/heads/}." >&2
        exit 1
      fi
      ;;
  esac
done
exit 0
`;

/** Installs the branch-protection hook. The protected ref list arrives in the environment. */
export async function installPushHook(repoDirectory: string): Promise<void> {
  const hooks = join(repoDirectory, "hooks");
  await mkdir(hooks, { recursive: true });
  await writeFile(join(hooks, "pre-receive"), PRE_RECEIVE, { mode: 0o755 });
}
