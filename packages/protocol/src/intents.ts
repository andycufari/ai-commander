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

/** What the UI did with each path of a `show_files` request, so the brain is told (§5). */
export const FilesShown = intent("files.shown", {
  requestId: z.string(),
  results: z.array(z.object({
    path: z.string(),
    outcome: z.enum(["opened", "already-open", "not-found"]),
    /** How the app chose to display it — the viewer registry's pick. */
    view: z.string().optional(),
  })),
  /** Which panel they landed in, for the tool result's wording. */
  side: z.enum(["left", "right"]).optional(),
});

export const OptionsSet = intent("options.set", {
  scope: OptionsScope,
  sessionId: z.string().optional(),
  patch: PartialConfig,
});

export const FsList = intent("fs.list", { path: z.string() });
/** Every file under the root, for ⌃P fuzzy open (§11). Directories are not included. */
export const FsTree = intent("fs.tree", { limit: z.number().int().positive().default(5000) });
/** §10 open folder: directories the backend can offer, plus recents. */
export const FoldersList = intent("folders.list", { under: z.string().optional() });
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
  PermissionAnswerIntent, AskAnswer, FilesShown, OptionsSet,
  FsList, FsTree, FoldersList, FsRead, FsWrite, FsMkdir, FsRename, FsCopy, FsMove, FsDelete,
  GitStatus, GitLog, GitDiff, GitCommit, GitCheckout,
  WorkspaceSet, WorkspaceGet, ViewerList, ViewerInstall,
]);
export type Intent = z.infer<typeof Intent>;
export type IntentType = Intent["type"];
export type IntentOf<T extends IntentType> = Extract<Intent, { type: T }>;
