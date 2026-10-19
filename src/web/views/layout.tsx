import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import octicons from "@primer/octicons";
import type { User } from "../../services/users.js";
import { formatDate, timeAgo } from "../format.js";
import { assetUrl } from "../assets.js";

const FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap";

export type PageProps ={ title: string; user: User | null; csrf: string; children?: Child };

export function Octicon({ name, size = 16, class: cls }: { name: string; size?: number; class?: string }) {
  const icon = octicons[name];
  if (!icon) return null;
  return raw(icon.toSVG({ width: size, height: size, class: `octicon octicon-${name}${cls ? ` ${cls}` : ""}` }));
}

export function Avatar({ name, size = 20, class: cls = "" }: { name: string; size?: number; class?: string }) {
  return (
    <img
      class={`avatar ${size <= 24 ? "avatar-small" : ""} ${cls}`}
      src={`/static/avatars/${encodeURIComponent(name.toLowerCase())}.svg`}
      width={size}
      height={size}
      alt={`@${name}`}
    />
  );
}

export function TimeAgo({ ts }: { ts: number }) {
  return (
    <time datetime={new Date(ts * 1000).toISOString()} title={new Date(ts * 1000).toUTCString()}>
      {timeAgo(ts)}
    </time>
  );
}

export function DateText({ ts }: { ts: number }) {
  return <time datetime={new Date(ts * 1000).toISOString()}>{formatDate(ts)}</time>;
}

export function CsrfField({ csrf }: { csrf: string }) {
  return <input type="hidden" name="_csrf" value={csrf} />;
}

export function Flash({ error, notice }: { error?: string | null; notice?: string | null }) {
  if (error) return <div class="flash flash-error mb-3" role="alert">{error}</div>;
  if (notice) return <div class="flash flash-success mb-3" role="status">{notice}</div>;
  return null;
}

/** Text color that stays readable on a label's background color. */
export function labelTextColor(hex: string): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#1f2328" : "#ffffff";
}

export function LabelChip({ label, href }: { label: { name: string; color: string }; href?: string }) {
  const style = `background-color:${label.color};color:${labelTextColor(label.color)};border-color:transparent`;
  return href ? (
    <a class="IssueLabel" href={href} style={style}>{label.name}</a>
  ) : (
    <span class="IssueLabel" style={style}>{label.name}</span>
  );
}

/** The Insitio mark: a small constellation forming an "i", with an orange spark for the dot. */
export function InsitioMark({ size = 28 }: { size?: number }) {
  return (
    <svg class="insitio-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <line class="edge" x1="16" y1="8" x2="16" y2="25" stroke-width="1.4" />
      <line class="edge" x1="16" y1="15" x2="9" y2="19" stroke-width="1.4" />
      <line class="edge" x1="16" y1="15" x2="23" y2="11" stroke-width="1.4" />
      <circle class="node" cx="16" cy="15" r="2.2" />
      <circle class="node" cx="16" cy="25" r="2.2" />
      <circle class="node" cx="9" cy="19" r="1.6" />
      <circle class="node" cx="23" cy="11" r="1.6" />
      <circle class="spark" cx="16" cy="7.5" r="3" />
    </svg>
  );
}

function Header({ user, csrf }: { user: User | null; csrf: string }) {
  return (
    <header class="Header px-3 px-md-4" role="banner">
      <div class="Header-item">
        <a href="/" class="Header-link d-flex flex-items-center" aria-label="Insitio home">
          <InsitioMark size={28} />
          <span class="ml-2 header-wordmark">Insitio</span>
        </a>
      </div>
      <div class="Header-item Header-item--full min-width-0">
        <form action="/search" method="get" role="search" class="width-full" style="max-width:360px">
          <input
            class="form-control Header-input width-full"
            type="search"
            name="q"
            placeholder="Search repositories…"
            aria-label="Search repositories"
          />
        </form>
      </div>
      {user ? (
        <>
          <div class="Header-item">
            <a href="/new" class="Header-link" aria-label="Create new repository" title="New repository">
              <Octicon name="plus" />
            </a>
          </div>
          <div class="Header-item mr-0">
            <details class="dropdown details-reset details-overlay">
              <summary class="Header-link d-flex flex-items-center" aria-label="Open user menu">
                <Avatar name={user.username} size={20} />
                <span class="dropdown-caret ml-1"></span>
              </summary>
              <div class="dropdown-menu dropdown-menu-sw" style="width:200px">
                <div class="dropdown-header">
                  Signed in as <strong>{user.username}</strong>
                </div>
                <div class="dropdown-divider"></div>
                <a class="dropdown-item" href={`/${user.username}`}>Your profile</a>
                <a class="dropdown-item" href={`/${user.username}?tab=repositories`}>Your repositories</a>
                <a class="dropdown-item" href={`/${user.username}?tab=stars`}>Your stars</a>
                <div class="dropdown-divider"></div>
                <a class="dropdown-item" href="/settings/profile">Settings</a>
                {user.isAdmin && <a class="dropdown-item" href="/site-admin">Site admin</a>}
                <form method="post" action="/logout">
                  <CsrfField csrf={csrf} />
                  <button type="submit" class="dropdown-item btn-link">Sign out</button>
                </form>
              </div>
            </details>
          </div>
        </>
      ) : (
        <div class="Header-item mr-0">
          <a href="/login" class="btn btn-sm">Sign in</a>
        </div>
      )}
    </header>
  );
}

export function Layout({ title, user, csrf, children }: PageProps) {
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en" data-color-mode={user?.theme === "light" ? "light" : user?.theme === "system" ? "auto" : "dark"} data-light-theme="light" data-dark-theme="dark">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="theme-color" content={user?.theme === "light" ? "#f6f4ee" : "#131c21"} />
          <title>{title ? `${title} · Insitio` : "Insitio"}</title>
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
          <link rel="stylesheet" href={FONTS_URL} />
          <link rel="stylesheet" href={assetUrl("primer.css")} />
          <link rel="stylesheet" href={assetUrl("app.css")} />
          <link rel="stylesheet" href={assetUrl("theme.css")} />
          <link rel="icon" href={assetUrl("favicon.svg")} type="image/svg+xml" />
          <script src={assetUrl("app.js")} defer></script>
        </head>
        <body>
          <a class="px-2 py-4 color-bg-accent-emphasis color-fg-on-emphasis show-on-focus" href="#main">Skip to content</a>
          <Header user={user} csrf={csrf} />
          <main id="main">{children}</main>
          <footer class="container-xl p-responsive py-6 mt-6 border-top color-fg-muted f6 d-flex flex-justify-between" role="contentinfo">
            <span>Insitio · self-hosted, invite-only</span>
            <span>Powered by git</span>
          </footer>
        </body>
      </html>
    </>
  );
}

export function ErrorPage(props: Omit<PageProps, "title" | "children"> & { status: number; message: string }) {
  const titles: Record<number, string> = { 400: "Bad request", 403: "Forbidden", 404: "Page not found", 409: "Conflict", 500: "Server error" };
  return (
    <Layout title={titles[props.status] ?? "Error"} user={props.user} csrf={props.csrf}>
      <div class="container-md p-responsive py-6 text-center">
        <h1 class="f00-light color-fg-muted">{props.status}</h1>
        <p class="f3 mb-2">{titles[props.status] ?? "Something went wrong"}</p>
        <p class="color-fg-muted">{props.message}</p>
        <a class="btn mt-3" href="/">Go home</a>
      </div>
    </Layout>
  );
}

export function Pagination({ page, total, perPage, href }: { page: number; total: number; perPage: number; href: (p: number) => string }) {
  const pages = Math.ceil(total / perPage);
  if (pages <= 1) return null;
  return (
    <nav class="paginate-container" aria-label="Pagination">
      <div class="pagination">
        {page > 1 ? <a class="previous_page" href={href(page - 1)}>Previous</a> : <span class="previous_page disabled">Previous</span>}
        <em class="current">{page} / {pages}</em>
        {page < pages ? <a class="next_page" href={href(page + 1)}>Next</a> : <span class="next_page disabled">Next</span>}
      </div>
    </nav>
  );
}
