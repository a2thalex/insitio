import { beforeEach, describe, expect, it } from "vitest";
import { createRepo } from "../src/services/repos.js";
import { testApp } from "./helpers.js";

let t: ReturnType<typeof testApp>;

beforeEach(() => {
  t = testApp();
});

describe("public home", () => {
  it("lists public repositories beside a sign-in, without the old poster", async () => {
    const ada = t.user("ada");
    await createRepo(t.deps, ada, { name: "ledger", description: "The books", isPrivate: false, initReadme: false });
    await createRepo(t.deps, ada, { name: "vault", description: "Hidden", isPrivate: true, initReadme: false });
    const html = await (await t.get("/")).text();
    expect(html).toContain("Public repositories");
    expect(html).toContain("Public issues");
    expect(html).toContain("Gists");
    expect(html).toContain("Invite only");
    expect(html).toContain('href="/explore"');
    expect(html).toContain('href="/ada/ledger"');
    expect(html).toContain("The books");
    expect(html).not.toContain('href="/ada/vault"');
    expect(html).toContain('href="/login"');
    expect(html).toContain("irm http://localhost:3000/install.ps1 | iex");
    expect(html).toContain("curl -fsSL http://localhost:3000/install.sh | sh");
    expect(html).toContain("nsit auth login");
    expect(html).toContain("nsit clone owner/name");
    expect(html).toContain("git clone http://localhost:3000/owner/name.git");
    expect(html).not.toContain("In situ.");
    expect(html).not.toContain("Code that stays where it belongs.");
  });

  it("keeps the signed-in dashboard", async () => {
    const ada = t.user("ada");
    const html = await (await t.get("/", t.loginAs(ada))).text();
    expect(html).toContain("Top repositories");
    expect(html).not.toContain("Public repositories");
  });
});
