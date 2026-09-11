import { useCallback, useRef, useState } from "react";
import type { PanelSide, Tab, ViewKind } from "@aicommander/protocol";

/** §10: a panel is a tabbed view host. ⌃T new, ⌃W close, ⌃⇥ cycle. */

let seq = 0;
export const tabId = (): string => `t${(seq += 1)}${Math.random().toString(36).slice(2, 6)}`;

export interface PanelTabs {
  tabs: Tab[];
  activeId: string | null;
  active: Tab | undefined;
  open: (tab: Omit<Tab, "id" | "dirty"> & { id?: string; dirty?: boolean }) => string;
  close: (id: string) => void;
  select: (id: string) => void;
  cycle: (dir?: 1 | -1) => void;
  setDirty: (id: string, dirty: boolean) => void;
  /** Change a tab in place — the files view navigating to another directory. */
  update: (id: string, patch: Partial<Omit<Tab, "id">>) => void;
  replaceAll: (tabs: Tab[], activeId: string | null) => void;
}

export function usePanelTabs(initial: Tab[] = [], initialActive: string | null = null): PanelTabs {
  const [tabs, setTabs] = useState<Tab[]>(initial);
  const [activeId, setActiveId] = useState<string | null>(initialActive ?? initial[0]?.id ?? null);

  // The current tabs, readable synchronously. State updaters may be deferred or (in
  // StrictMode) run twice, so deciding "existing or new" inside one is not safe.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const open: PanelTabs["open"] = useCallback((tab) => {
    // Opening the same file twice focuses the existing tab instead of duplicating it.
    const existing = tab.path
      ? tabsRef.current.find((t) => t.path === tab.path && t.view === tab.view)
      : undefined;
    if (existing) {
      setActiveId(existing.id);
      return existing.id;
    }
    const id = tab.id ?? tabId();
    const next: Tab = { dirty: false, ...tab, id };
    tabsRef.current = [...tabsRef.current, next];
    setTabs(tabsRef.current);
    setActiveId(id);
    return id;
  }, []);

  const close = useCallback((id: string) => {
    const prev = tabsRef.current;
    const i = prev.findIndex((t) => t.id === id);
    if (i === -1) return;
    const next = prev.filter((t) => t.id !== id);
    tabsRef.current = next;
    setTabs(next);
    // Focus the neighbour on the left, or whatever is now first.
    setActiveId((cur) => (cur === id ? next[Math.max(0, i - 1)]?.id ?? null : cur));
  }, []);

  const cycle = useCallback((dir: 1 | -1 = 1) => {
    const prev = tabsRef.current;
    if (prev.length === 0) return;
    setActiveId((cur) => {
      const i = prev.findIndex((t) => t.id === cur);
      return prev[(i + dir + prev.length) % prev.length]!.id;
    });
  }, []);

  const setDirty = useCallback((id: string, dirty: boolean) => {
    tabsRef.current = tabsRef.current.map((t) => (t.id === id ? { ...t, dirty } : t));
    setTabs(tabsRef.current);
  }, []);

  const update = useCallback((id: string, patch: Partial<Omit<Tab, "id">>) => {
    tabsRef.current = tabsRef.current.map((t) => (t.id === id ? { ...t, ...patch } : t));
    setTabs(tabsRef.current);
  }, []);

  const replaceAll = useCallback((next: Tab[], nextActive: string | null) => {
    tabsRef.current = next;
    setTabs(next);
    setActiveId(nextActive ?? next[0]?.id ?? null);
  }, []);

  return {
    tabs,
    activeId,
    active: tabs.find((t) => t.id === activeId),
    open, close, select: setActiveId, cycle, setDirty, update, replaceAll,
  };
}

/** §11: the F-bar shows what the keys do *here* — keyed by the focused view. */
export type FKeySet = readonly (readonly [string, string, boolean])[];

const CHAT_KEYS: FKeySet = [
  ["F1", "help", false], ["F2", "+ attach", false], ["F3", "sessions", false],
  ["F4", "system", false], ["F5", "options", false], ["F6", "compact", false],
  ["F7", "rewind", false], ["F8", "clear", false], ["F9", "open ▸", false],
  ["F10", "quit", false],
];

const FILES_KEYS: FKeySet = [
  ["F1", "help", false], ["F2", "menu", false], ["F3", "view", false],
  ["F4", "edit", false], ["F5", "copy", false], ["F6", "move", false],
  ["F7", "mkdir", false], ["F8", "delete", false], ["F9", "upload", false],
  ["F10", "quit", false],
];

const EDITOR_KEYS: FKeySet = [
  ["F1", "help", false], ["F2", "save", false], ["F3", "view", false],
  ["F4", "edit ⇄ view", false], ["F5", "options", false], ["F6", "", false],
  ["F7", "", false], ["F8", "", false], ["F9", "open ▸", false],
  ["F10", "quit", false],
];

const VIEWER_KEYS: FKeySet = [
  ["F1", "help", false], ["F2", "mention", false], ["F3", "close", false],
  ["F4", "edit", false], ["F5", "options", false], ["F6", "", false],
  ["F7", "", false], ["F8", "", false], ["F9", "open ▸", false],
  ["F10", "quit", false],
];

export function keysFor(view: ViewKind | undefined): FKeySet {
  switch (view) {
    case "files": return FILES_KEYS;
    case "editor": return EDITOR_KEYS;
    case "viewer": return VIEWER_KEYS;
    case "chat":
    default: return CHAT_KEYS;
  }
}

export const titleFor = (tab: Tab | undefined, fallback = "panel"): string => {
  if (!tab) return fallback;
  return tab.title;
};

export type { PanelSide, Tab, ViewKind };
