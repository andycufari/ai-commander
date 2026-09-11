import { z } from "zod";
import { Config } from "./config.js";
import { RuleLevel } from "./rules.js";
import { Group, SessionMeta, SessionStatus } from "./session.js";
import { GitAction, ToolResult } from "./tools.js";
import { PanelTarget, Workspace } from "./workspace.js";

/** §3 server → client. `{ id, type, ...payload }`; `id` is unique per event. */

const event = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ id: z.string(), type: z.literal(type), ...shape });

export const SessionStateEvent = event("session.state", {
  sessionId: z.string(),
  status: SessionStatus,
  ctxUsed: z.number().int().nonnegative(),
  ctxMax: z.number().int().positive(),
  toolCount: z.number().int().nonnegative(),
  elapsed: z.number().nonnegative(),
  /** Set while a message is waiting for the next tool boundary (guard 5). */
  queued: z.string().optional(),
});

export const TurnStart = event("turn.start", {
  sessionId: z.string(),
  groupId: z.string(),
  role: z.enum(["user", "brain"]),
});
/** Streaming brain text. */
export const Token = event("token", {
  sessionId: z.string(),
  groupId: z.string(),
  delta: z.string(),
});

export const ToolStart = event("tool.start", {
  sessionId: z.string(),
  groupId: z.string(),
  callId: z.string(),
  name: z.string(),
  args: z.record(z.unknown()),
});
/** Streaming shell output, keyed by callId alone. */
export const ToolOutput = event("tool.output", { callId: z.string(), delta: z.string() });
export const ToolEnd = event("tool.end", {
  callId: z.string(),
  ok: z.boolean(),
  summary: z.string(),
  outputPath: z.string().optional(),
  truncated: z.boolean().default(false),
});

export const PermissionRequest = event("permission.request", {
  requestId: z.string(),
  sessionId: z.string(),
  tool: z.string(),
  command: z.string(),
  rule: z.string(),
  reason: z.string(),
  level: RuleLevel.default("danger"),
});
export const AskRequest = event("ask.request", {
  requestId: z.string(),
  sessionId: z.string(),
  question: z.string(),
  options: z.array(z.string()).min(1),
});

/** Background shell jobs (guard 4). */
export const JobStart = event("job.start", { jobId: z.string(), sessionId: z.string(), cmd: z.string() });
export const JobOutput = event("job.output", { jobId: z.string(), delta: z.string() });
export const JobEnd = event("job.end", { jobId: z.string(), code: z.number().int().nullable(), killed: z.boolean().default(false) });

/** §5 show_files: the app routes each path through the viewer registry itself. */
export const ShowFiles = event("show_files", {
  paths: z.array(z.string()).min(1),
  target: PanelTarget.default("other"),
  /** The UI answers with files.shown so the tool result says what actually happened. */
  requestId: z.string().optional(),
});
/** Viewer or files view pushing text into the prompt. */
export const MentionAdd = event("mention.add", { text: z.string() });

export const FsChanged = event("fs.changed", { paths: z.array(z.string()) });
export const GitChanged = event("git.changed", {
  branch: z.string(),
  dirty: z.number().int().nonnegative(),
  ahead: z.number().int().nonnegative(),
});

export const Toast = event("toast", { level: z.enum(["info", "warning"]), text: z.string() });
export const CompactDone = event("compact.done", {
  sessionId: z.string(),
  before: z.number().int(),
  after: z.number().int(),
  summaryPath: z.string(),
});
export const WorkspaceEvent = event("workspace", { workspace: Workspace });
export const ErrorEvent = event("error", { intentId: z.string().optional(), message: z.string() });

/** Replies the UI needs for its own intents — the spec's §3 list covers the loop;
 *  these carry the data an intent asked for. */
export const FsEntry = z.object({
  name: z.string(),
  path: z.string(),
  dir: z.boolean(),
  size: z.number().int().nonnegative(),
  mtime: z.number().int(),
});
export type FsEntry = z.infer<typeof FsEntry>;

export const FsListed = event("fs.listed", { intentId: z.string(), path: z.string(), entries: z.array(FsEntry) });
export const FsContent = event("fs.content", {
  intentId: z.string(),
  path: z.string(),
  content: z.string(),
  hash: z.string(),
});
/** Reply to fs.write: confirms the write and returns the hash of what is now on disk,
 *  so an editor can re-base its buffer without a second round trip. */
/** Reply to fs.tree: repo-relative file paths, already sorted. */
export const FsTreeListed = event("fs.tree", {
  intentId: z.string(),
  paths: z.array(z.string()),
  truncated: z.boolean().default(false),
});
export const FsWrote = event("fs.wrote", {
  intentId: z.string(),
  path: z.string(),
  hash: z.string(),
});
export const GitResult = event("git.result", {
  intentId: z.string(),
  action: GitAction,
  text: z.string(),
});
/** Full session list + replayed log, sent on open and on reconnect. */
export const SessionList = event("session.list", { sessions: z.array(SessionMeta) });
export const TouchedFile = z.object({
  path: z.string(),
  kind: z.enum(["written", "read", "mentioned"]),
  ts: z.number().int(),
});
export type TouchedFile = z.infer<typeof TouchedFile>;

export const SessionEvents = event("session.events", {
  sessionId: z.string(),
  meta: SessionMeta,
  groups: z.array(Group),
  /** Files this session has touched, for the ⌃⇧P modal (§11). Writes first. */
  touched: z.array(TouchedFile).default([]),
});
/** Sent on connect: the merged config plus what the shell's top line needs (§10). */
export const ConfigEvent = event("config", {
  config: Config,
  /** Absolute repo root; the top line shows it with $HOME collapsed to ~. */
  root: z.string(),
});

export const Event = z.discriminatedUnion("type", [
  SessionStateEvent, TurnStart, Token,
  ToolStart, ToolOutput, ToolEnd,
  PermissionRequest, AskRequest,
  JobStart, JobOutput, JobEnd,
  ShowFiles, MentionAdd, FsChanged, GitChanged,
  Toast, CompactDone, WorkspaceEvent, ErrorEvent,
  FsListed, FsTreeListed, FsContent, FsWrote, GitResult, SessionList, SessionEvents, ConfigEvent,
]);
export type Event = z.infer<typeof Event>;
export type EventType = Event["type"];
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;

export type { ToolResult };
