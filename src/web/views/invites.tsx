import type { Invite } from "../../services/users.js";
import { CsrfField, TimeAgo } from "./layout.js";

export function InviteTable({ invites, baseUrl, csrf, revokePath }: { invites: Invite[]; baseUrl: string; csrf: string; revokePath: (token: string) => string }) {
  const nowS = Math.floor(Date.now() / 1000);
  return (
    <div class="Box">
      <div class="Box-header"><h3 class="Box-title">Invite links</h3></div>
      {invites.length === 0 ? (
        <div class="Box-row color-fg-muted">No invites yet.</div>
      ) : (
        invites.map((i) => {
          const state = i.usedBy ? "used" : i.expiresAt < nowS ? "expired" : "pending";
          return (
            <div class="Box-row d-flex flex-items-center">
              <div class="flex-auto min-width-0">
                <code class="f6 css-truncate css-truncate-target" style="max-width:420px">{`${baseUrl}/join/${i.token}`}</code>
                <div class="f6 color-fg-muted">
                  {i.createdBy ? `By ${i.createdBy} · ` : ""}created <TimeAgo ts={i.createdAt} />
                  {state === "used" && <> · used by <a href={`/${i.usedBy}`}>{i.usedBy}</a></>}
                  {state === "expired" && " · expired"}
                  {state === "pending" && <> · expires <TimeAgo ts={i.expiresAt} /></>}
                </div>
              </div>
              <span class={`Label mr-2 ${state === "pending" ? "Label--success" : "Label--secondary"}`}>{state}</span>
              {state === "pending" && (
                <form method="post" action={revokePath(i.token)}>
                  <CsrfField csrf={csrf} />
                  <button class="btn btn-sm btn-danger" type="submit">Revoke</button>
                </form>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
