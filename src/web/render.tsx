import type { Context } from "hono";
import type { Child } from "hono/jsx";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "./env.js";
import { ErrorPage, Layout } from "./views/layout.js";

export function render(c: Context<Env>, title: string, body: Child, status: ContentfulStatusCode = 200) {
  return c.html(
    <Layout title={title} user={c.get("user")} csrf={c.get("csrf")}>
      {body}
    </Layout>,
    status,
  );
}

export function renderError(c: Context<Env>, status: ContentfulStatusCode, message: string) {
  return c.html(<ErrorPage status={status} message={message} user={c.get("user")} csrf={c.get("csrf")} />, status);
}

export const notFound = (c: Context<Env>, what = "This page") =>
  renderError(c, 404, `${what} doesn't exist, or you don't have permission to see it.`);
