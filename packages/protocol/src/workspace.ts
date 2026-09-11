import { z } from "zod";

/**
 * §10 / v2 §4 workspace.json — restore exactly where you were.
 *
 * The shape follows the v2 mockup literally: `panels.{left,right}` each with a tab list
 * and an `active` index, marks and the prompt draft at the top level. Tabs are keyed by
 * what they point at (`path`, `session`) rather than by a generated id, because an id
 * means nothing across a restart.
 */

export const ViewKind = z.enum(["chat", "files", "editor", "viewer", "log", "sql"]);
export type ViewKind = z.infer<typeof ViewKind>;

export const PanelSide = z.enum(["left", "right"]);
export type PanelSide = z.infer<typeof PanelSide>;

/** Where `show_files` puts a file: "other" = the panel that is not focused. */
export const PanelTarget = z.enum(["other", "left", "right"]);
export type PanelTarget = z.infer<typeof PanelTarget>;

/** Line and column, as the v2 mockup writes it: `"cursor": [12, 0]`. */
export const CursorPos = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);
export type CursorPos = z.infer<typeof CursorPos>;

export const PersistedTab = z.object({
  view: ViewKind,
  /** files: the directory; editor/viewer: the file. */
  path: z.string().optional(),
  /** chat tabs name their session. */
  session: z.string().optional(),
  /** editor tabs remember where the caret was. */
  cursor: CursorPos.optional(),
  /** editor: "view" renders markdown, "edit" shows the buffer. */
  mode: z.enum(["view", "edit"]).optional(),
  /** viewer tabs may name a specific viewer (M4 plugins). */
  viewer: z.string().optional(),
});
export type PersistedTab = z.infer<typeof PersistedTab>;

export const PersistedPanel = z.object({
  tabs: z.array(PersistedTab).default([]),
  /** Index into `tabs`; -1 or out of range means nothing is active. */
  active: z.number().int().default(0),
  /** The files view's current directory, when this panel has one. */
  cwd: z.string().optional(),
});
export type PersistedPanel = z.infer<typeof PersistedPanel>;

export const Workspace = z.object({
  /** Reserved for layout presets (v2 §4); only "commander" exists today. */
  layout: z.string().default("commander"),
  /** Left panel's share of the row, moved in 5% steps (§10). */
  gutter: z.number().min(0.1).max(0.9).default(0.5),
  focus: PanelSide.default("left"),
  /** Set when ⌃B collapsed a panel; restores to `gutter` on toggle. */
  collapsed: PanelSide.nullable().default(null),
  panels: z.object({
    left: PersistedPanel.default({}),
    right: PersistedPanel.default({}),
  }).default({}),
  /** Marked files in the files view, repo-relative. */
  marked: z.array(z.string()).default([]),
  /** Closing the window mid-thought loses nothing (v2 §4). */
  promptDraft: z.string().default(""),
});
export type Workspace = z.infer<typeof Workspace>;

export const DEFAULT_WORKSPACE: Workspace = Workspace.parse({});

/** A tab as the UI holds it: the persisted fields plus its runtime id and state. */
export const Tab = PersistedTab.extend({
  id: z.string(),
  title: z.string(),
  sessionId: z.string().optional(),
  jobId: z.string().optional(),
  dirty: z.boolean().default(false),
  /** Set when a save was refused because the file changed on disk (§10). */
  conflict: z.boolean().default(false),
  /** Set when a restored tab points at a file that is no longer there. */
  missing: z.boolean().default(false),
});
export type Tab = z.infer<typeof Tab>;

export const Panel = z.object({
  tabs: z.array(Tab).default([]),
  activeTabId: z.string().nullable().default(null),
  cwd: z.string().optional(),
  marked: z.array(z.string()).default([]),
});
export type Panel = z.infer<typeof Panel>;
