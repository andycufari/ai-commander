import { z } from "zod";
import { Mode, PartialConfig } from "./config.js";
import { ToolCall } from "./tools.js";

/** §7 attachments: inserted as blocks above the user turn that mentioned them. */

export const FileAttachment = z.object({
  kind: z.literal("file"),
  path: z.string(),
  /** Content hash — a file attached again with the same hash becomes `<file unchanged/>`. */
  hash: z.string(),
});
export const SkillAttachment = z.object({ kind: z.literal("skill"), name: z.string() });
export const ImageAttachment = z.object({
  kind: z.literal("image"),
  /** Path under the session's `img/` directory. */
  file: z.string(),
});
export const ToolAttachment = z.object({ kind: z.literal("tool"), name: z.string() });

export const Attachment = z.discriminatedUnion("kind", [
  FileAttachment,
  SkillAttachment,
  ImageAttachment,
  ToolAttachment,
]);
export type Attachment = z.infer<typeof Attachment>;

export const SessionStatus = z.enum(["idle", "running", "paused", "cancelled"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** §4 meta.json */
export const SessionSnapshot = z.object({ groupId: z.string(), gitRef: z.string() });
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;

export const SessionMeta = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string(),
  created: z.number().int(),
  forkedFrom: z.string().optional(),
  snapshots: z.array(SessionSnapshot).default([]),
  /** Session-scope overrides, shown as "session" in the options modal. */
  options: PartialConfig.optional(),
  /** Special tools enabled for this session via `#`. */
  specialTools: z.array(z.string()).default([]),
  mode: Mode.optional(),
});
export type SessionMeta = z.infer<typeof SessionMeta>;

/** §4 session.jsonl — one event per line, replayable to rebuild UI and context. */

const base = { ts: z.number().int() };

export const LogUser = z.object({
  t: z.literal("user"),
  id: z.string(),
  ...base,
  text: z.string(),
  attachments: z.array(Attachment).default([]),
});
export const LogSnapshotEntry = z.object({
  t: z.literal("snapshot"),
  ...base,
  group: z.string(),
  ref: z.string(),
});
export const LogBrain = z.object({
  t: z.literal("brain"),
  id: z.string(),
  ...base,
  text: z.string(),
  toolCalls: z.array(ToolCall).default([]),
});
export const LogTool = z.object({
  t: z.literal("tool"),
  id: z.string(),
  ...base,
  callId: z.string(),
  name: z.string(),
  args: z.record(z.unknown()),
  ok: z.boolean(),
  summary: z.string(),
  outputPath: z.string().nullable().default(null),
  tokens: z.number().int().nonnegative().default(0),
});
export const LogPermission = z.object({
  t: z.literal("permission"),
  ...base,
  callId: z.string(),
  rule: z.string(),
  answer: z.enum(["once", "session", "deny"]),
});
export const LogCancel = z.object({ t: z.literal("cancel"), ...base, group: z.string() });
export const LogCompact = z.object({
  t: z.literal("compact"),
  ...base,
  upTo: z.string(),
  summaryPath: z.string(),
  before: z.number().int(),
  after: z.number().int(),
});

export const LogEntry = z.discriminatedUnion("t", [
  LogUser,
  LogSnapshotEntry,
  LogBrain,
  LogTool,
  LogPermission,
  LogCancel,
  LogCompact,
]);
export type LogEntry = z.infer<typeof LogEntry>;

/** A group is one user turn plus everything it caused — the unit for rewind,
 *  delete, drop-tool-output and token accounting (§4). */
export const Group = z.object({
  id: z.string(),
  sessionId: z.string(),
  ts: z.number().int(),
  userText: z.string(),
  brainText: z.string(),
  tokens: z.number().int().nonnegative(),
  toolCount: z.number().int().nonnegative(),
  cancelled: z.boolean().default(false),
});
export type Group = z.infer<typeof Group>;
