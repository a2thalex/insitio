import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PRE_RECEIVE = `#!/bin/sh
# Lists are comma-separated ref patterns. A trailing * is a prefix.
hits() {
  list=",$1,"
  case "$list" in
    *,"$2",*) return 0 ;;
  esac
  oldifs=$IFS
  IFS=,
  for pat in $1; do
    case "$pat" in
      *\\*)
        prefix=\${pat%\\*}
        case "$2" in
          "$prefix"*) return 0 ;;
        esac
        ;;
    esac
  done
  IFS=$oldifs
  return 1
}
zero=0000000000000000000000000000000000000000
while read -r old new ref; do
  admin="\${INSITIO_PUSH_ADMIN:-0}"
  if hits "\${INSITIO_PROTECTED_REFS:-}" "$ref" && [ "$admin" != "1" ]; then
    echo "Refusing to update protected branch \${ref#refs/heads/}." >&2
    exit 1
  fi
  if [ "$new" = "$zero" ]; then
    if hits "\${INSITIO_NO_DELETE:-}" "$ref" && [ "$admin" != "1" ]; then
      echo "Refusing to delete protected branch \${ref#refs/heads/}." >&2
      exit 1
    fi
    continue
  fi
  if hits "\${INSITIO_NO_FORCE:-}" "$ref" && [ "$admin" != "1" ] && [ "$old" != "$zero" ]; then
    if ! git merge-base --is-ancestor "$old" "$new"; then
      echo "Refusing to force-push protected branch \${ref#refs/heads/}." >&2
      exit 1
    fi
  fi
done
exit 0
`;

/** Installs the branch-protection hook. The protected ref list arrives in the environment. */
export async function installPushHook(repoDirectory: string): Promise<void> {
  const hooks = join(repoDirectory, "hooks");
  await mkdir(hooks, { recursive: true });
  await writeFile(join(hooks, "pre-receive"), PRE_RECEIVE, { mode: 0o755 });
}
