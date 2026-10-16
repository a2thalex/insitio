import { Marked, type TokenizerAndRendererExtension } from "marked";
import sanitizeHtml from "sanitize-html";
import { highlightCode } from "./highlight.js";

export type RepoContext = { owner: string; name: string; ref: string; dir: string };

function issueRefs(repo: RepoContext): TokenizerAndRendererExtension {
  return {
    name: "issueRef",
    level: "inline",
    start: (src) => src.match(/(^|[^\w&])#\d/)?.index,
    tokenizer(src) {
      const m = /^#(\d+)\b/.exec(src);
      if (m) return { type: "issueRef", raw: m[0], n: m[1] };
    },
    renderer: (t) => `<a href="/${repo.owner}/${repo.name}/issues/${t.n}">#${t.n}</a>`,
  };
}

const mentions: TokenizerAndRendererExtension = {
  name: "mention",
  level: "inline",
  start: (src) => src.match(/(^|[^\w`])@[a-zA-Z0-9]/)?.index,
  tokenizer(src) {
    const m = /^@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\b/.exec(src);
    if (m) return { type: "mention", raw: m[0], user: m[1] };
  },
  renderer: (t) => `<a href="/${t.user}">@${t.user}</a>`,
};

function resolveRelative(dir: string, href: string): string {
  const parts = dir ? dir.split("/") : [];
  for (const seg of href.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function isRelative(url: string): boolean {
  return !!url && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("#") && !url.startsWith("/") && !url.startsWith("//");
}

/** GitHub-flavored Markdown to sanitized HTML; with a repo, relative links and #refs resolve into it. */
export function renderMarkdown(md: string, opts: { repo?: RepoContext } = {}): string {
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      code({ text, lang }) {
        const language = (lang ?? "").split(/\s/)[0] || null;
        return `<pre><code class="hljs">${highlightCode(text, language)}</code></pre>\n`;
      },
    },
    extensions: opts.repo ? [issueRefs(opts.repo), mentions] : [mentions],
  });
  const raw = marked.parse(md, { async: false }) as string;
  const repo = opts.repo;
  return sanitizeHtml(raw, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2", "del", "input", "details", "summary", "sup", "sub", "kbd"]),
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "title", "width", "height"],
      code: ["class"],
      span: ["class"],
      input: ["type", "checked", "disabled"],
      th: ["align"],
      td: ["align"],
      "*": ["id"],
    },
    allowedClasses: { code: ["hljs", /^language-/], span: [/^hljs-/] },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: (tag, attribs) => {
        if (repo && isRelative(attribs.href ?? "")) {
          attribs.href = `/${repo.owner}/${repo.name}/blob/${repo.ref}/${resolveRelative(repo.dir, attribs.href)}`;
        }
        if (attribs.href && /^https?:/i.test(attribs.href)) attribs.rel = "nofollow noopener";
        return { tagName: tag, attribs };
      },
      img: (tag, attribs) => {
        if (repo && isRelative(attribs.src ?? "")) {
          attribs.src = `/${repo.owner}/${repo.name}/raw/${repo.ref}/${resolveRelative(repo.dir, attribs.src)}`;
        }
        return { tagName: tag, attribs };
      },
      input: (tag, attribs) => ({ tagName: tag, attribs: { ...attribs, disabled: "" } }),
    },
  });
}
