import type { ChildProcess } from "node:child_process";
import type { Hono } from "hono";
import { archiveContentType, startArchive, type ArchiveFormat } from "../../git/archive.js";
import { archivePrefix } from "../../git/paths.js";
import { GitError } from "../../git/run.js";
import type { Deps } from "../../deps.js";
import type { Env } from "../env.js";
import { attachmentDisposition } from "../download.js";
import { notFound } from "../render.js";
import { withRepo } from "./code.js";

function splitArchive(rest: string): { name: string; format: ArchiveFormat } | null {
  if (rest.endsWith(".tar.gz")) return { name: rest.slice(0, -".tar.gz".length), format: "tar.gz" };
  if (rest.endsWith(".zip")) return { name: rest.slice(0, -".zip".length), format: "zip" };
  return null;
}

function streamChild(child: ChildProcess): ReadableStream<Uint8Array> {
  const stdout = child.stdout;
  if (!stdout) throw new Error("git archive produced no output");
  return new ReadableStream({
    start(controller) {
      stdout.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      stdout.on("end", () => controller.close());
      stdout.on("error", (err) => controller.error(err));
      child.on("error", (err) => controller.error(err));
    },
    cancel() {
      child.kill();
    },
  });
}

export function archiveRoutes(deps: Deps, app: Hono<Env>) {
  const R = "/:owner/:repo";

  async function send(c: Parameters<typeof notFound>[0], ctx: Parameters<ReturnType<typeof withRepo>>[0] extends never ? never : any, ref: string, label: string, format: ArchiveFormat) {
    let sha: string | null;
    try {
      sha = await ctx.git.resolve(ref);
    } catch (err) {
      if (err instanceof GitError) return notFound(c);
      throw err;
    }
    if (!sha) return notFound(c);
    const filename = `${archivePrefix(ctx.repo.name, label).replace(/\/$/, "")}.${format}`;
    const child = startArchive(ctx.git.dir, sha, ctx.repo.name, label, format);
    c.header("content-type", archiveContentType(format));
    c.header("content-disposition", attachmentDisposition(filename));
    c.header("x-content-type-options", "nosniff");
    c.header("cache-control", "private, max-age=60");
    return c.body(streamChild(child));
  }

  app.get(`${R}/archive/refs/heads/:rest{.+}`, withRepo(deps, "read", async (c, ctx) => {
    const split = splitArchive(c.req.param("rest") ?? "");
    if (!split) return notFound(c);
    try {
      if (!(await ctx.git.hasRef("heads", split.name))) return notFound(c);
    } catch (err) {
      if (err instanceof GitError) return notFound(c);
      throw err;
    }
    return send(c, ctx, split.name, split.name, split.format);
  }));

  app.get(`${R}/archive/refs/tags/:rest{.+}`, withRepo(deps, "read", async (c, ctx) => {
    const split = splitArchive(c.req.param("rest") ?? "");
    if (!split) return notFound(c);
    try {
      if (!(await ctx.git.hasRef("tags", split.name))) return notFound(c);
    } catch (err) {
      if (err instanceof GitError) return notFound(c);
      throw err;
    }
    return send(c, ctx, split.name, split.name, split.format);
  }));

  app.get(`${R}/archive/:file`, withRepo(deps, "read", async (c, ctx) => {
    const split = splitArchive(c.req.param("file") ?? "");
    if (!split || !/^[0-9a-f]{7,40}$/i.test(split.name)) return notFound(c);
    const sha = await ctx.git.resolve(split.name);
    if (!sha) return notFound(c);
    return send(c, ctx, sha, sha.slice(0, 7), split.format);
  }));
}
