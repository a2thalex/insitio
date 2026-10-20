import { beforeEach, describe, expect, it } from "vitest";
import { createIssue } from "../src/services/issues.js";
import { noForceRefList, protectedRefList, ruleForBranch, saveBranchRule } from "../src/services/repoAdmin.js";
import { createRepo } from "../src/services/repos.js";
import type { User } from "../src/services/users.js";
import { testApp, type Who } from "./helpers.js";

let t: ReturnType<typeof testApp>;
let ada: User;
let adaWho: Who;

beforeEach(() => {
  t = testApp();
  ada = t.user("ada");
  adaWho = t.loginAs(ada);
});

describe("parity", () => {
  it("matches a prefix rule and hides a private repository from explore", async () => {
    const repo = await createRepo(t.deps, ada, { name: "hello", description: "Shown", isPrivate: false, initReadme: true });
    await createRepo(t.deps, ada, { name: "vault", description: "Hidden", isPrivate: true, initReadme: true });
    createIssue(t.deps.db, repo.id, ada.id, { title: "Public bug", body: "" });
    saveBranchRule(t.deps.db, repo.id, { branch: "release/*", requirePr: true, approvals: 1, blockForce: true, blockDelete: true });
    expect(ruleForBranch([{ branch: "release/*", requirePr: true, approvals: 1, blockForce: true, blockDelete: true }], "release/1")?.approvals).toBe(1);
    expect(ruleForBranch([{ branch: "release/*", requirePr: true, approvals: 1, blockForce: true, blockDelete: true }], "main")).toBeNull();
    expect(protectedRefList(t.deps.db, repo.id)).toContain("refs/heads/release/*");
    saveBranchRule(t.deps.db, repo.id, { branch: "topic", requirePr: false, approvals: 0, blockForce: true, blockDelete: false });
    expect(noForceRefList(t.deps.db, repo.id)).toBe("refs/heads/topic");

    const explore = await (await t.get("/explore")).text();
    expect(explore).toContain("ada/hello");
    expect(explore).toContain("Public bug");
    expect(explore).not.toContain("vault");
  });

  it("records a deployment only for a real commit, and counts a page load", async () => {
    const repo = await createRepo(t.deps, ada, { name: "hello", description: "", isPrivate: false, initReadme: true });
    expect((await t.post("/ada/hello/settings/environments", { name: "production", url: "https://example.com" }, adaWho)).status).toBe(302);
    expect((await t.post("/ada/hello/deployments", { environment: "production", sha: "a".repeat(40), description: "nope" }, adaWho)).status).toBe(400);
    const { gitFor } = await import("../src/services/repos.js");
    const tip = await gitFor(t.deps, repo).resolve("main");
    expect((await t.post("/ada/hello/deployments", { environment: "production", sha: tip!, description: "shipped" }, adaWho)).status).toBe(302);
    expect(await (await t.get("/ada/hello/deployments", adaWho)).text()).toContain("shipped");
    expect((await t.get("/ada/hello")).status).toBe(200);
    expect(await (await t.get("/ada/hello/insights")).text()).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
