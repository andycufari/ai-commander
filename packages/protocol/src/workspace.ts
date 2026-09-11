import { z } from "zod";

/** §10 workspace.json — panels, tabs, gutter, focus, marked files, prompt draft. */

export const ViewKind = z.enum(["chat", "files", "editor", "viewer", "log", "sql"]);
export type ViewKind = z.infer<typeof ViewKind>;

export const PanelSide = z.enum(["left", "right"]);
export type PanelSide = z.infer<typeof PanelSide>;

/** Where `open_in_panel` puts a file: "other" = the panel that is not focused. */
export const PanelTarget = z.enum(["other", "left", "right"]);
export type PanelTarget = z.infer<typeof PanelTarget>;

export const Tab = z.object({
  id: z.string(),
  view: ViewKind,
  title: z.string(),
  /** chat tabs carry a sessionId; file-backed views carry a path. */
  sessionId: z.string().optional(),
  path: z.string().optional(),
  viewer: z.string().optional(),
  jobId: z.string().optional(),
  dirty: z.boolean().default(false),
});
export type Tab = z.infer<typeof Tab>;

export const Panel = z.object({
  tabs: z.array(Tab).default([]),
  activeTabId: z.string().nullable().default(null),
  /** files view state, kept per panel so a reload restores the cursor. */
  cwd: z.string().optional(),
  marked: z.array(z.string()).default([]),
});
export type Panel = z.infer<typeof Panel>;

export const Workspace = z.object({
  left: Panel.default({}),
  right: Panel.default({}),
  /** Left panel width as a fraction of the shell, moved in 5% steps (§10). */
  gutter: z.number().min(0.1).max(0.9).default(0.5),
  focus: PanelSide.default("left"),
  /** Set when ⌃B collapsed a panel; restores to `gutter` on toggle. */
  collapsed: PanelSide.nullable().default(null),
  promptDraft: z.string().default(""),
});
export type Workspace = z.infer<typeof Workspace>;

export const DEFAULT_WORKSPACE: Workspace = Workspace.parse({});
