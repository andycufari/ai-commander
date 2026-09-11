import { z } from "zod";
import { OptionsScope, PartialConfig } from "./config.js";
import { PermissionAnswer } from "./rules.js";
import { Attachment } from "./session.js";
import { Workspace } from "./workspace.js";

/** §3 client → server. Every message is `{ id, type, ...payload }`;
 *  `id` correlates an `error` event back to the intent that caused it. */

const intent = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ id: z.string(), type: z.literal(type), ...shape });

export const RewindMode = z.enum(["fork", "truncate"]);
export type RewindMode = z.infer<typeof RewindMode>;

export const SessionCreate = intent("session.create", { name: z.string().optional() });
export const SessionOpen = intent("session.open", { sessionId: z.string() });
export const SessionClose = intent("session.close", { sessionId: z.string() });
export const SessionRename = intent("session.rename", { sessionId: z.string(), name: z.string() });
/** Destructive: `confirm` must be the literal "delete" (§3). */
export const SessionDelete = intent("session.delete", {
  sessionId: z.string(),
  confirm: z.literal("delete"),
});
/** Queues if the session is running; injected at the next tool boundary (guard 5). */
export const SessionSend = intent("session.send", {
  sessionId: z.string(),
  text: z.string(),
  attachments: z.array(Attachment).default([]),
});
export const SessionCancel = intent("session.cancel", { sessionId: z.string() });
export const SessionRewind = intent("session.rewind", {
  sessionId: z.string(),
  groupId: z.string(),
  mode: RewindMode,
});
export const SessionDropGroup = intent("session.dropGroup", {
  sessionId: z.string(),
  groupId: z.string(),
});
export const SessionDropToolOutput = intent("session.dropToolOutput", {
  sessionId: z.string(),
  groupId: z.string(),
});
export const SessionCompact = intent("session.compact", { sessionId: z.string() });
export const SessionClear = intent("session.clear", { sessionId: z.string() });

export const PermissionAnswerIntent = intent("permission.answer", {
  requestId: z.string(),
  answer: PermissionAnswer,
  /** Present when the user chose "edit" in the danger modal. */
  editedCommand: z.string().optional(),
});
export const AskAnswer = intent("ask.answer", { requestId: z.string(), choice: z.string() });

/** What the UI did with an `open_in_panel` request, so the brain is told (§5). */
export const PanelOpened = intent("panel.opened", {
  requestId: z.string(),
  outcome: z.enum(["opened", "already-open", "not-found"]),
  /** Which panel it landed in, for the tool result's wording. */
  side: z.enum(["left", "right"]).optional(),
  view: z.string().optional(),
});

export const OptionsSet = intent("options.set", {
  scope: OptionsScope,
  sessionId: z.string().optional(),
  patch: PartialConfig,
});

export const FsList = intent("fs.list", { path: z.string() });
export const FsRead = intent("fs.read", { path: z.string() });
/** `baseHash` is the hash the editor loaded; a mismatch means the file changed underneath. */
export const FsWrite = intent("fs.write", {
  path: z.string(),
  content: z.string(),
  baseHash: z.string().nullable(),
});
export const FsMkdir = intent("fs.mkdir", { path: z.string() });
export const FsRename = intent("fs.rename", { path: z.string(), to: z.string() });
export const FsCopy = intent("fs.copy", { path: z.string(), to: z.string() });
export const FsMove = intent("fs.move", { path: z.string(), to: z.string() });
export const FsDelete = intent("fs.delete", { path: z.string(), confirm: z.literal("delete") });

export const GitStatus = intent("git.status", {});
export const GitLog = intent("git.log", { path: z.string().optional(), n: z.number().int().positive().default(20) });
export const GitDiff = intent("git.diff", { path: z.string().optional() });
export const GitCommit = intent("git.commit", { message: z.string() });
export const GitCheckout = intent("git.checkout", { ref: z.string() });

export const WorkspaceSet = intent("workspace.set", { patch: Workspace.deepPartial() });
export const WorkspaceGet = intent("workspace.get", {});

export const ViewerList = intent("viewer.list", {});
export const ViewerInstall = intent("viewer.install", { name: z.string() });

export const Intent = z.discriminatedUnion("type", [
  SessionCreate, SessionOpen, SessionClose, SessionRename, SessionDelete,
  SessionSend, SessionCancel, SessionRewind, SessionDropGroup, SessionDropToolOutput,
  SessionCompact, SessionClear,
  PermissionAnswerIntent, AskAnswer, PanelOpened, OptionsSet,
  FsList, FsRead, FsWrite, FsMkdir, FsRename, FsCopy, FsMove, FsDelete,
  GitStatus, GitLog, GitDiff, GitCommit, GitCheckout,
  WorkspaceSet, WorkspaceGet, ViewerList, ViewerInstall,
]);
export type Intent = z.infer<typeof Intent>;
export type IntentType = Intent["type"];
export type IntentOf<T extends IntentType> = Extract<Intent, { type: T }>;
