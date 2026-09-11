import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown.js";

describe("renderMarkdown", () => {
  it("renders headings at their level", () => {
    expect(renderMarkdown("# Title")).toContain("<h1>Title</h1>");
    expect(renderMarkdown("### Deep")).toContain("<h3>Deep</h3>");
  });

  it("renders bullet and numbered lists", () => {
    expect(renderMarkdown("- a\n- b")).toContain("<ul>\n<li>a</li>\n<li>b</li>\n</ul>");
    expect(renderMarkdown("1. a\n2. b")).toContain("<ol>");
  });

  it("closes a list when the block ends", () => {
    const html = renderMarkdown("- a\n\nafter");
    expect(html).toContain("</ul>");
    expect(html.indexOf("</ul>")).toBeLessThan(html.indexOf("after"));
  });

  it("renders fenced code without treating its contents as markup", () => {
    const html = renderMarkdown("```js\nconst a = *x*;\n```");
    expect(html).toContain('<pre><code class="lang-js">');
    expect(html).toContain("const a = *x*;");
    expect(html).not.toContain("<em>");
  });

  it("renders inline code, bold and italic", () => {
    expect(renderMarkdown("`x`")).toContain("<code>x</code>");
    expect(renderMarkdown("**b**")).toContain("<strong>b</strong>");
    expect(renderMarkdown("an *i* word")).toContain("<em>i</em>");
  });

  it("renders a thematic break", () => {
    expect(renderMarkdown("---")).toContain("<hr>");
    expect(renderMarkdown("***")).toContain("<hr>");
    // Not a break: too few, or mixed
    expect(renderMarkdown("--")).not.toContain("<hr>");
  });

  it("renders blockquotes", () => {
    expect(renderMarkdown("> quoted")).toContain("<blockquote>quoted</blockquote>");
  });

  it("escapes HTML in the source so a file cannot inject markup", () => {
    const html = renderMarkdown('<script>alert("x")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes HTML inside code fences too", () => {
    expect(renderMarkdown("```\n<img onerror=1>\n```")).not.toContain("<img");
  });

  it("renders safe links and strips unsafe schemes", () => {
    expect(renderMarkdown("[a](https://x.com)")).toContain('href="https://x.com"');
    expect(renderMarkdown("[a](/local)")).toContain('href="/local"');
    const bad = renderMarkdown("[a](javascript:alert(1))");
    expect(bad).not.toContain("href");
    expect(bad).toContain("a");
  });

  it("leaves an empty document empty", () => {
    expect(renderMarkdown("").trim()).toBe("");
  });
});
