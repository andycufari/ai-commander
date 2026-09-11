import type { PanelSide, PersistedPanel, PersistedTab, Tab, Workspace } from "@aicommander/protocol";
import { tabId } from "./tabs.js";
import { defaultRegistry } from "./viewers.js";

/**
 * workspace.json ⇄ runtime tabs (v2 §4).
 *
 * Persisted tabs are keyed by what they point at, not by a generated id — an id means
 * nothing across a restart. Restoring mints fresh ids and rebuilds the titles.
 */

const titleFor = (tab: PersistedTab): string => {
  if (tab.view === "chat") return "chat";
  if (tab.view === "files") return tab.path && tab.path !== "." ? tab.path.split("/").pop()! : "files";
  return tab.path ? tab.path.split("/").pop()! : tab.view;
};

export function toRuntimeTabs(panel: PersistedPanel): { tabs: Tab[]; activeId: string | null } {
  const tabs: Tab[] = panel.tabs.map((t) => ({
    ...t,
    id: tabId(),
    title: titleFor(t),
    viewer: t.viewer ?? (t.path ? defaultRegistry.resolve(t.path).name : undefined),
    dirty: false,
    conflict: false,
    // Whether the file still exists is checked once the views load it; a restored tab
    // is never dropped for pointing at something missing (that would silently discard
    // a layout the user arranged).
    missing: false,
  }));
  const active = tabs[panel.active]?.id ?? tabs[0]?.id ?? null;
  return { tabs, activeId: active };
}

export function toPersistedTabs(tabs: readonly Tab[], activeId: string | null): PersistedPanel {
  return {
    tabs: tabs.map((t) => ({
      view: t.view,
      ...(t.path !== undefined ? { path: t.path } : {}),
      ...(t.session !== undefined ? { session: t.session } : {}),
      ...(t.cursor !== undefined ? { cursor: t.cursor } : {}),
      ...(t.mode !== undefined ? { mode: t.mode } : {}),
      ...(t.viewer !== undefined ? { viewer: t.viewer } : {}),
    })),
    active: Math.max(0, tabs.findIndex((t) => t.id === activeId)),
  };
}

/** The patch the UI sends after any layout change. */
export function toPatch(input: {
  gutter: number;
  focus: PanelSide;
  collapsed: PanelSide | null;
  left: { tabs: readonly Tab[]; activeId: string | null };
  right: { tabs: readonly Tab[]; activeId: string | null };
  marked: readonly string[];
  promptDraft: string;
}): Partial<Workspace> {
  return {
    gutter: input.gutter,
    focus: input.focus,
    collapsed: input.collapsed,
    panels: {
      left: toPersistedTabs(input.left.tabs, input.left.activeId),
      right: toPersistedTabs(input.right.tabs, input.right.activeId),
    },
    marked: [...input.marked],
    promptDraft: input.promptDraft,
  };
}
