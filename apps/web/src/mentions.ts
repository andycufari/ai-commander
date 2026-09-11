/**
 * Clickable mentions in the chat (§10: "mentions clickable → open_in_panel").
 *
 * Deliberately narrow. Only two things become links:
 *   1. an explicit `@path` the user or brain wrote
 *   2. the path argument of a file tool — read_file, edit_file, write_file
 *
 * Nothing else is linkified: guessing at bare words that look pathish turns prose into
 * a minefield of dead links, and a mention that does not open anything is worse than
 * no mention at all.
 */

export interface Segment {
  text: string;
  /** Set when this segment is a clickable mention; the repo path to open. */
  path?: string;
}

/** Tools whose `path` argument names a file worth opening. */
export const PATH_TOOLS = new Set(["read_file", "edit_file", "write_file", "open_in_panel"]);

/**
 * A mention is `@` followed by a path-shaped run: no whitespace, and it must contain a
 * dot or a slash so `@here` and `@everyone` stay prose. Trailing punctuation is left
 * out of the link, since prose ends sentences.
 */
const MENTION = /@([A-Za-z0-9._~\-/]*[A-Za-z0-9._~\-/])/g;

const looksLikePath = (candidate: string): boolean =>
  (candidate.includes("/") || candidate.includes(".")) && !candidate.endsWith("/");

/** Split prose into plain text and clickable `@path` mentions. */
export function linkifyMentions(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;

  for (const m of text.matchAll(MENTION)) {
    const start = m.index ?? 0;
    let candidate = m[1] ?? "";
    // Trim trailing sentence punctuation: "see @src/main.c." should not link the dot.
    const trimmed = candidate.replace(/[.,;:!?)\]}]+$/, "");
    if (!looksLikePath(trimmed)) continue;
    candidate = trimmed;

    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: `@${candidate}`, path: candidate });
    last = start + 1 + candidate.length;
  }

  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length > 0 ? out : [{ text }];
}

/** The path a tool call is acting on, when it is one worth linking. */
export function toolPath(name: string, args: Record<string, unknown> | string | undefined): string | undefined {
  if (!PATH_TOOLS.has(name)) return undefined;
  if (typeof args === "string") return args.trim() === "" ? undefined : args;
  const path = args?.path;
  return typeof path === "string" && path !== "" ? path : undefined;
}
