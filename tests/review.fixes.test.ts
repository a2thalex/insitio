import { describe, it, expect } from "vitest";
import { createRepo, gitFor } from "../src/services/repos.js";
import { matchGitRoute } from "../src/githttp/handler.js";
import { safeNext } from "../src/web/middleware.js";
import { testApp } from "./helpers.js";

// Regressions for findings from the security review.
describe("security review fixes", () => {
  it("does not throw on malformed request URLs", () => {
    for (const url of ["//", "//%", "///", "//evil.com/a/b/info/refs?service=git-upload-pack"]) {
      expect(() => matchGitRoute(url)).not.toThrow();
    }
  });

  it("never redirects off-site from the bare /tree route", async () => {
    const t = testApp();
    const res = await t.get("/%2Fevil.com/x/tree");
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("//")).toBe(false);
    expect(location.startsWith("/\\")).toBe(false);
  });

  it("rejects next parameters with control characters or backslashes", () => {
    expect(safeNext("/\t/evil.com")).toBe("/");
    expect(safeNext("/\\evil.com")).toBe("/");
    expect(safeNext("/ok/path?x=1")).toBe("/ok/path?x=1");
  });

  it("does not let anyone reopen or close a merged pull request", async () => {
    const t = testApp();
    const ada = t.user("ada");
    const adaWho = t.loginAs(ada);
    const repo = await createRepo(t.deps, ada, { name: "hello", description: "", isPrivate: false, initReadme: true });
    await gitFor(t.deps, repo).commitFiles("feature", { "f.txt": "f\n" }, "Feature", { name: "Ada", email: "ada@example.com" }, "main");
    await t.post("/ada/hello/pulls", { base: "main", head: "feature", title: "Feature", body: "" }, adaWho);
    await t.post("/ada/hello/pull/1/merge", {}, adaWho);
    const res = await t.post("/ada/hello/pull/1/comment", { body: "", action: "reopen" }, adaWho);
    expect(res.status).toBe(409);
    expect(await (await t.get("/ada/hello/pull/1")).text()).toContain("State--merged");
    expect(await (await t.get("/ada/hello/pulls")).text()).toContain("There aren&#39;t any open pull requests.");
  });

  it("downloads files with non-Latin-1 names", async () => {
    const t = testApp();
    const ada = t.user("ada");
    const repo = await createRepo(t.deps, ada, { name: "hello", description: "", isPrivate: false, initReadme: true });
    await gitFor(t.deps, repo).commitFiles("main", { "日本語.txt": "こんにちは\n" }, "Unicode name", { name: "Ada", email: "ada@example.com" });
    const res = await t.get(`/ada/hello/raw/main/${encodeURIComponent("日本語.txt")}?download=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''");
  });

  it("rejects oversized request bodies before parsing them", async () => {
    const t = testApp();
    const res = await t.app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(20 * 1024 * 1024) },
      body: "a=".padEnd(20 * 1024 * 1024, "a"),
    });
    expect(res.status).toBe(413);
  });
});
