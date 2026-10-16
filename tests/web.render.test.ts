import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/web/markdown.js";
import { highlightLines } from "../src/web/highlight.js";
import { formatBytes, identicon, timeAgo } from "../src/web/format.js";

describe("renderMarkdown", () => {
  it("renders GFM and strips scripts and event handlers", () => {
    const html = renderMarkdown("<script>alert(1)</script>\n\n**bold** <img src=x onerror=alert(1)>\n\n| a |\n|---|\n| b |");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<table>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });

  it("rewrites relative links and images against the repo", () => {
    const html = renderMarkdown("[docs](docs/guide.md) ![logo](./img/logo.png) [ext](https://example.com) [anchor](#top)", {
      repo: { owner: "ada", name: "hello", ref: "main", dir: "" },
    });
    expect(html).toContain('href="/ada/hello/blob/main/docs/guide.md"');
    expect(html).toContain('src="/ada/hello/raw/main/img/logo.png"');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="#top"');
  });

  it("links issue references and mentions in repo context", () => {
    const html = renderMarkdown("Fixes #12, thanks @bob", { repo: { owner: "ada", name: "hello", ref: "main", dir: "" } });
    expect(html).toContain('<a href="/ada/hello/issues/12">#12</a>');
    expect(html).toContain('<a href="/bob">@bob</a>');
    expect(renderMarkdown("`#12`", { repo: { owner: "ada", name: "hello", ref: "main", dir: "" } })).toContain("<code>#12</code>");
  });

  it("highlights fenced code blocks", () => {
    expect(renderMarkdown("```js\nconst a = 1;\n```")).toContain('class="hljs-keyword"');
  });
});

describe("highlightLines", () => {
  it("returns one balanced HTML line per source line", () => {
    const lines = highlightLines("/* one\ntwo */\nconst x = 1;", "a.js");
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect((l.match(/<span/g) ?? []).length).toBe((l.match(/<\/span>/g) ?? []).length);
    }
    expect(lines[1]).toContain("two */");
  });

  it("escapes unknown file types", () => {
    expect(highlightLines("<b>x</b>", "notes.unknownext")).toEqual(["&lt;b&gt;x&lt;/b&gt;"]);
  });
});

describe("format", () => {
  it("formats sizes, times and identicons", () => {
    expect(formatBytes(3768)).toBe("3.68 KB");
    expect(formatBytes(12)).toBe("12 Bytes");
    const nowS = Math.floor(Date.now() / 1000);
    expect(timeAgo(nowS - 2 * 86400, nowS)).toBe("2 days ago");
    expect(timeAgo(nowS - 30, nowS)).toBe("now");
    expect(identicon("ada")).toBe(identicon("ada"));
    expect(identicon("ada")).toContain("<svg");
  });
});
