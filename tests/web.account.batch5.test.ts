import { beforeEach, describe, expect, it } from "vitest";
import { totp } from "../src/auth/totp.js";
import { beginTotp, confirmTotp, listSessions, revokeSession } from "../src/services/account.js";
import { createRepo } from "../src/services/repos.js";
import { createSession, getSession, type User } from "../src/services/users.js";
import { testApp, type Who } from "./helpers.js";

let t: ReturnType<typeof testApp>;
let ada: User;
let adaWho: Who;

beforeEach(async () => {
  t = testApp();
  ada = t.user("ada");
  adaWho = t.loginAs(ada);
});

describe("account settings", () => {
  it("adds an email, makes it primary, and rejects a duplicate", async () => {
    expect((await t.post("/settings/emails", { email: "ada@other.test" }, adaWho)).status).toBe(302);
    expect((await t.post("/settings/emails", { email: "ada@other.test" }, adaWho)).status).toBe(400);
    const id = (t.deps.db.prepare("select id from emails where email = ?").get("ada@other.test") as { id: number }).id;
    expect((await t.post(`/settings/emails/${id}/primary`, {}, adaWho)).status).toBe(302);
    const user = t.deps.db.prepare("select email from users where id = ?").get(ada.id) as { email: string };
    expect(user.email).toBe("ada@other.test");
  });

  it("lists sessions and revokes one without dropping the current login", async () => {
    const extra = createSession(t.deps.db, ada.id, "other-client");
    const page = await (await t.get("/settings/sessions", adaWho)).text();
    expect(page).toContain("This session");
    expect(page).toContain("other-client");
    const other = listSessions(t.deps.db, ada.id, adaWho.cookie.split("=")[1]).find((row) => !row.current)!;
    revokeSession(t.deps.db, ada.id, other.id);
    expect(getSession(t.deps.db, extra.id)).toBeNull();
    expect((await t.get("/settings/sessions", adaWho)).status).toBe(200);
  });

  it("requires a TOTP code after the password", async () => {
    const started = beginTotp(t.deps.db, ada.id, ada.username);
    const code = totp(started.secret);
    expect(confirmTotp(t.deps.db, ada.id, code)).toHaveLength(8);
    const missing = await t.post("/login", { username: "ada", password: "longenough" });
    expect(missing.status).toBe(200);
    expect(await missing.text()).toContain("Authentication code");
    const bad = await t.post("/login", { username: "ada", password: "longenough", code: "000000" });
    expect(bad.status).toBe(401);
    const ok = await t.post("/login", { username: "ada", password: "longenough", code });
    expect(ok.status).toBe(302);
  });

  it("stops a blocked person from opening an issue and fills a saved reply", async () => {
    await createRepo(t.deps, ada, { name: "hello", description: "", isPrivate: false, initReadme: true });
    const bob = t.user("bob");
    const bobWho = t.loginAs(bob);
    expect((await t.post("/settings/blocks", { username: "bob" }, adaWho)).status).toBe(302);
    expect((await t.post("/ada/hello/issues", { title: "Hi", body: "" }, bobWho)).status).toBe(403);
    expect((await t.get("/ada/hello")).status).toBe(200);

    expect((await t.post("/settings/replies", { title: "Thanks", body: "Thanks for the report" }, adaWho)).status).toBe(302);
    const issue = await t.post("/ada/hello/issues", { title: "Bug", body: "Broken" }, adaWho);
    expect(issue.status).toBe(302);
    const replyId = (t.deps.db.prepare("select id from saved_replies").get() as { id: number }).id;
    expect((await t.post("/ada/hello/issues/1/comment", { action: "comment", body: "", reply: String(replyId) }, adaWho)).status).toBe(302);
    expect(await (await t.get("/ada/hello/issues/1")).text()).toContain("Thanks for the report");
  });

  it("stores a theme, an SSH key, and a sign-in in the security log", async () => {
    expect((await t.post("/settings/appearance", { theme: "light", notify: "all" }, adaWho)).status).toBe(302);
    expect(await (await t.get("/settings/appearance", adaWho)).text()).toContain('data-color-mode="light"');
    const key = `ssh-ed25519 ${Buffer.from("0123456789abcdef").toString("base64")} ada`;
    expect((await t.post("/settings/keys/ssh", { title: "laptop", key }, adaWho)).status).toBe(302);
    expect(await (await t.get("/settings/keys", adaWho)).text()).toContain("SHA256:");
    expect((await t.post("/settings/keys/gpg", { key: "not a key" }, adaWho)).status).toBe(400);
    const signedIn = await t.post("/login", { username: "ada", password: "longenough" });
    expect(signedIn.status).toBe(302);
    expect(await (await t.get("/settings/security", adaWho)).text()).toContain("login");
  });
});
