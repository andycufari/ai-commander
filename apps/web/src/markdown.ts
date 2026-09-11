/**
 * Minimal markdown → HTML for the ⌃E preview.
 *
 * Deliberately small rather than a library: the preview renders inside a terminal-styled
 * panel, so it needs headings, lists, code, links, emphasis and rules — not the full
 * CommonMark surface. Everything is escaped before any tag is emitted, so file content
 * can never inject markup.
 */

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline spans. Input must already be HTML-escaped — callers escape at emit time. */
function inline(text: string): string {
  return text
    // `code` first, so its contents are not treated as emphasis
    .replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|\W)_([^_\n]+)_/g, "$1<em>$2</em>")
    // [label](href) — href is escaped and limited to safe schemes
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) =>
      /^(https?:|mailto:|#|\/|\.)/i.test(href)
        ? `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`
        : label);
}

export function renderMarkdown(src: string): string {
  // Block structure is read from the raw text — escaping first would turn a `>` quote
  // marker into `&gt;` and hide it. Each line's *content* is escaped as it is emitted.
  const lines = src.split("\n");
  const out: string[] = [];
  let inCode = false;
  let listType: "ul" | "ol" | null = null;

  const closeList = (): void => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const raw of lines) {
    const line = raw;

    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      closeList();
      if (inCode) {
        out.push("</code></pre>");
        inCode = false;
      } else {
        out.push(`<pre><code class="lang-${escapeHtml(fence[1] ?? "")}">`);
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(line));
      continue;
    }

    if (/^\s*$/.test(line)) {
      closeList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(escapeHtml(heading[2]!))}</h${level}>`);
      continue;
    }

    // A thematic break: three or more of the same -, * or _, spaces allowed between.
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      closeList();
      out.push("<hr>");
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${inline(escapeHtml(bullet[1]!))}</li>`);
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${inline(escapeHtml(numbered[1]!))}</li>`);
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      out.push(`<blockquote>${inline(escapeHtml(quote[1]!))}</blockquote>`);
      continue;
    }

    closeList();
    out.push(`<p>${inline(escapeHtml(line))}</p>`);
  }

  closeList();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}
