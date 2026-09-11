import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, Group, LogEntry } from "@aicommander/protocol";
import { BrainClient } from "./brain.js";
import { projectDir } from "./config.js";
import { SessionStore, groupOf } from "./sessions.js";

/**
 * §6 compact — summarise the older turns so the context window keeps working.
 *
 * The summary is written by the brain from a fixed prompt (templates/compact.md), so
 * the wording does not drift with whatever the session happened to be about. The list
 * of files written or edited is never summarised: it is carried through verbatim,
 * because "which files did we change" is the one question a paraphrase reliably ruins.
 */

const templatePath = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "compact.md");

export interface CompactPlan {
  /** Groups that will be summarised away. */
  older: Group[];
  /** Groups that stay verbatim. */
  kept: Group[];
  /** Tokens the older groups account for. */
  before: number;
  /** Rough size of what replaces them. */
  after: number;
  /** Files written or edited in the compacted range, in order. */
  files: string[];
}

/** What compacting would do, for the warning modal's before/after estimate. */
export function planCompact(groups: readonly Group[], entries: readonly LogEntry[], keepLast: number): CompactPlan {
  const older = groups.slice(0, Math.max(0, groups.length - keepLast));
  const kept = groups.slice(Math.max(0, groups.length - keepLast));
  const olderIds = new Set(older.map((g) => g.id));

  const files: string[] = [];
  for (const e of entries) {
    if (e.t !== "tool" || !e.ok) continue;
    if (!olderIds.has(e.id)) continue;
    if (e.name !== "write_file" && e.name !== "edit_file") continue;
    const path = (e.args as { path?: unknown }).path;
    if (typeof path === "string" && path && !files.includes(path)) files.push(path);
  }

  const before = older.reduce((sum, g) => sum + g.tokens, 0);
  return {
    older, kept, before,
    // A summary lands around 500 words; the file list adds a little.
    after: 700 + files.length * 8,
    files,
  };
}

/** The next compact-N.md, so earlier summaries are never overwritten. */
export async function nextSummaryPath(root: string): Promise<string> {
  const dir = join(projectDir(root), "out");
  await mkdir(dir, { recursive: true });
  const existing = await readdir(dir).catch(() => []);
  const numbers = existing
    .map((f) => /^compact-(\d+)\.md$/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  const next = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  return join(dir, `compact-${next}.md`);
}

/** Render the groups being compacted as the transcript the summariser reads. */
export function transcriptOf(groups: readonly Group[]): string {
  return groups
    .map((g) => {
      const parts = [`## turn`, g.userText && `user: ${g.userText}`, g.brainText && `assistant: ${g.brainText}`];
      if (g.toolCount > 0) parts.push(`(${g.toolCount} tool calls)`);
      return parts.filter(Boolean).join("\n");
    })
    .join("\n\n");
}

export interface CompactResult {
  summaryPath: string;
  before: number;
  after: number;
  upTo: string;
}

/**
 * Do the compaction: one brain call, write the summary, log it.
 *
 * The log itself is not rewritten — the compact entry records what was summarised, and
 * the context assembler reads that to decide what to send. Keeping the full log means
 * a rewind still works across a compaction.
 */
export async function compactSession(
  root: string,
  config: Config,
  sessions: SessionStore,
  sessionId: string,
): Promise<CompactResult | undefined> {
  const entries = await sessions.read(sessionId);
  const groups = SessionStore.toGroups(sessionId, entries);
  const plan = planCompact(groups, entries, config.context.keepLastGroups);
  if (plan.older.length === 0) return undefined;

  const template = await readFile(templatePath(), "utf8").catch(
    () => "Summarise the following working session.",
  );
  const brain = new BrainClient(config.brain);
  const turn = await brain.complete(
    [
      { role: "system", content: template },
      { role: "user", content: transcriptOf(plan.older) },
    ],
    [],
  );

  const fileBlock = plan.files.length
    ? `\n\n## files changed\n\n${plan.files.map((f) => `- ${f}`).join("\n")}\n`
    : "";
  const body = `${turn.text.trim()}${fileBlock}`;

  const summaryPath = await nextSummaryPath(root);
  await writeFile(summaryPath, `${body}\n`);

  const relative = summaryPath.slice(root.length + 1);
  const upTo = plan.older[plan.older.length - 1]!.id;
  await sessions.append(sessionId, {
    t: "compact", ts: Date.now(), upTo, summaryPath: relative,
    before: plan.before, after: plan.after,
  });

  return { summaryPath: relative, before: plan.before, after: plan.after, upTo };
}

export { groupOf };
