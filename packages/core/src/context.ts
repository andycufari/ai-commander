import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Attachment, Config, LogEntry } from "@aicommander/protocol";
import type { BrainMessage, ContentPart } from "./brain.js";
import { loadBoot, readSkills, skillIndex } from "./boot.js";
import { projectDir } from "./config.js";
import { git, gitState } from "./intents.js";
import { resolveInRoot } from "./paths.js";
import { SessionStore } from "./sessions.js";

/**
 * §7 context assembly — built fresh every turn, each layer a separate block.
 *
 * The order is the point: the harness manual explains how the app works before the
 * project explains itself, so project rules can override the manual rather than
 * fighting it. Everything below is derived from the log, so what the model sees can
 * always be reconstructed from what is on disk.
 */

export const hashContent = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

/** What a layer cost, for the context inspector (§12 M3). */
export interface Layer {
  name: string;
  chars: number;
  /** A one-line description of what is in it. */
  detail?: string;
}

export interface AssembleInput {
  root: string;
  config: Config;
  sessions: SessionStore;
  sessionId: string;
  /** Attachments on the turn about to be sent, which is not in the log yet. */
  pending?: readonly Attachment[];
  /** Whether the endpoint takes image content; images are described instead if not. */
  vision?: boolean;
}

export interface Assembled {
  messages: BrainMessage[];
  layers: Layer[];
}

export async function assembleContext(input: AssembleInput): Promise<Assembled> {
  const { root, config, sessions, sessionId } = input;
  const messages: BrainMessage[] = [];
  const layers: Layer[] = [];

  /**
   * §7 describes each layer as its own block, and they are still assembled and
   * reported separately — but they are sent as one system message. Many local chat
   * templates raise "System message must be at the beginning" on the second one, and
   * a context layout that only works on some endpoints is not a context layout.
   */
  const systemBlocks: string[] = [];
  const push = (name: string, content: string, detail?: string): void => {
    if (!content.trim()) return;
    systemBlocks.push(content);
    layers.push({ name, chars: content.length, detail });
  };

  // 1. harness manual — the brain's UX contract.
  const manual = await readFile(join(projectDir(root), "system.md"), "utf8").catch(() => "");
  push("harness manual", manual, ".aicommander/system.md");

  // 2. project boot — AGENTS/CLAUDE, BOOT, SOUL, rules/.
  const boot = await loadBoot(root, config.boot);
  if (boot.length > 0) {
    push(
      "project boot",
      boot.map((f) => `# ${f.path}\n\n${f.content}`).join("\n\n"),
      boot.map((f) => f.path).join(", "),
    );
  }

  // 3. skills index — one line each; full content only when mentioned.
  const { skills } = await readSkills(root);
  if (skills.length > 0) {
    push(
      "skills index",
      `Skills available in this project. Read one with read_skill when it is relevant.\n\n${skillIndex(skills)}`,
      `${skills.length} skill${skills.length === 1 ? "" : "s"}`,
    );
  }

  // 5. git state — branch, dirty count, last three commits. Always reported: "not a
  // git repo" is itself worth knowing when reading the inspector.
  const gitText = await describeGit(root);
  if (gitText.trim()) push("git state", gitText);
  else layers.push({ name: "git state", chars: 1, detail: "not a git repository" });

  // Everything above becomes the single leading system message.
  if (systemBlocks.length > 0) {
    messages.push({ role: "system", content: systemBlocks.join("\n\n---\n\n") });
  }

  // 6. session — messages, with attachments as blocks above the turn that used them.
  const entries = await sessions.read(sessionId);
  const session = await renderSession(input, entries);
  messages.push(...session.messages);
  // The session layer is always reported, even when empty: the inspector should show
  // that the session costs nothing yet rather than omitting the row.
  layers.push({
    name: "session",
    chars: Math.max(1, session.messages.reduce((n, m) => n + contentLength(m.content), 0)),
    detail: session.turns === 0 ? "no turns yet" : `${session.turns} turns`,
  });

  return { messages, layers };
}

const contentLength = (content: BrainMessage["content"]): number =>
  typeof content === "string"
    ? content.length
    : content.reduce((n, part) => n + (part.type === "text" ? part.text.length : 0), 0);

async function describeGit(root: string): Promise<string> {
  const state = await gitState(root).catch(() => undefined);
  if (!state) return "";
  const log = await git(root, ["log", "-n3", "--oneline", "--no-color"]).catch(() => "");
  return [
    `Branch ${state.branch}${state.dirty > 0 ? `, ${state.dirty} files changed` : ", clean"}` +
      `${state.ahead > 0 ? `, ${state.ahead} ahead` : ""}.`,
    log.trim() ? `Recent commits:\n${log.trim()}` : "",
  ].filter(Boolean).join("\n");
}

interface RenderedSession {
  messages: BrainMessage[];
  turns: number;
}

/**
 * Replay the log into API messages.
 *
 * A file attached again with the same hash becomes a one-line reference rather than its
 * content — the model has already read it, and paying for it twice is how a context
 * window fills up with things it already knows.
 */
async function renderSession(input: AssembleInput, entries: LogEntry[]): Promise<RenderedSession> {
  const { root } = input;
  const messages: BrainMessage[] = [];
  /** path or skill name → the hash whose content was already sent. */
  const sent = new Map<string, string>();
  let turns = 0;

  // A compact entry replaces everything up to the group it names.
  const lastCompact = [...entries].reverse().find((e) => e.t === "compact");
  let skipUntil: string | undefined;
  if (lastCompact && lastCompact.t === "compact") {
    const summary = await readFile(join(root, lastCompact.summaryPath), "utf8").catch(() => undefined);
    if (summary) {
      // As a user turn, not a system message: it sits in the middle of the
      // conversation, where a second system message breaks strict chat templates.
      messages.push({
        role: "user",
        content: `Earlier in this session, summarised:\n\n${summary.trim()}`,
      });
      skipUntil = lastCompact.upTo;
    }
  }

  let skipping = skipUntil !== undefined;
  for (const entry of entries) {
    if (skipping) {
      // Everything through the compacted group is replaced by the summary above.
      if ((entry.t === "user" || entry.t === "brain" || entry.t === "tool") && entry.id === skipUntil) {
        continue;
      }
      if (entry.t === "compact") {
        skipping = false;
        continue;
      }
      if (entry.t === "user" || entry.t === "brain" || entry.t === "tool") continue;
      continue;
    }

    if (entry.t === "user") {
      turns += 1;
      const blocks = await renderAttachments(input, entry.attachments, sent);
      for (const block of blocks) messages.push(block);
      messages.push({ role: "user", content: entry.text });
    } else if (entry.t === "brain" && entry.text) {
      messages.push({ role: "assistant", content: entry.text });
    }
  }

  // The turn being sent now is not in the log yet.
  if (input.pending?.length) {
    for (const block of await renderAttachments(input, input.pending, sent)) {
      messages.push(block);
    }
  }

  return { messages, turns };
}

/** §7: attachments become blocks above the user turn that mentioned them. */
async function renderAttachments(
  input: AssembleInput,
  attachments: readonly Attachment[],
  sent: Map<string, string>,
): Promise<BrainMessage[]> {
  const { root } = input;
  const out: BrainMessage[] = [];

  for (const attachment of attachments) {
    if (attachment.kind === "file") {
      const key = `file:${attachment.path}`;
      if (sent.get(key) === attachment.hash && attachment.hash !== "") {
        out.push({
          role: "user",
          content: `<file path="${attachment.path}" unchanged/>`,
        });
        continue;
      }
      const content = await readFile(await resolveInRoot(root, attachment.path), "utf8")
        .catch(() => undefined);
      if (content === undefined) {
        out.push({
          role: "user",
          content: `<file path="${attachment.path}"/> — this file is no longer in the repo.`,
        });
        continue;
      }
      sent.set(key, attachment.hash || hashContent(content));
      out.push({
        role: "user",
        content: `<file path="${attachment.path}" hash="${attachment.hash || hashContent(content)}">\n${content}\n</file>`,
      });
      continue;
    }

    if (attachment.kind === "skill") {
      const key = `skill:${attachment.name}`;
      if (sent.has(key)) {
        out.push({ role: "user", content: `<skill name="${attachment.name}" unchanged/>` });
        continue;
      }
      const body = await readFile(join(root, "skills", attachment.name, "SKILL.md"), "utf8")
        .catch(() => undefined);
      if (body === undefined) {
        out.push({ role: "user", content: `<skill name="${attachment.name}"/> — not found.` });
        continue;
      }
      sent.set(key, "1");
      out.push({ role: "user", content: `<skill name="${attachment.name}">\n${body}\n</skill>` });
      continue;
    }

    if (attachment.kind === "image") {
      out.push(await renderImage(input, attachment.file));
      continue;
    }

    if (attachment.kind === "tool") {
      out.push({ role: "user", content: `<tool name="${attachment.name}" enabled/>` });
    }
  }
  return out;
}

/**
 * An image goes as vision content when the endpoint takes it, and as a note when it
 * does not — the file is still attached and still openable, so the turn is never lost
 * just because the model cannot see pictures.
 */
async function renderImage(input: AssembleInput, file: string): Promise<BrainMessage> {
  const name = file.split("/").pop() ?? file;
  if (input.vision === false) {
    return {
      role: "user",
      content: `<image file="${name}"/> — attached; this model can't see images.`,
    };
  }
  const absolute = join(projectDir(input.root), "sessions", input.sessionId, file);
  const bytes = await readFile(absolute).catch(() => undefined);
  if (!bytes) {
    return { role: "user", content: `<image file="${name}"/> — the file is missing.` };
  }
  const mime = name.toLowerCase().endsWith(".png") ? "image/png"
    : name.toLowerCase().endsWith(".gif") ? "image/gif"
    : name.toLowerCase().endsWith(".webp") ? "image/webp"
    : "image/jpeg";
  const parts: ContentPart[] = [
    { type: "text", text: `<image file="${name}"/>` },
    { type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } },
  ];
  return { role: "user", content: parts };
}
