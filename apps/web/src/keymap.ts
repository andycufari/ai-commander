import type { ViewKind } from "@aicommander/protocol";

/**
 * §11 — the single source for every binding.
 *
 * One table, one id per action. Chords, slash commands, the key bar, the help overlay
 * and the generated BUILDME section all read from here, so a binding cannot exist in
 * one place and be missing from another — which is how ⌘⇧M ended up bound to nothing
 * the user could find, and how `attach` ended up sharing a case label with `rewind`.
 *
 * Browser reality: ⌘W, ⌘N, ⌘T and ⌘Q belong to the tab and cannot be taken. Actions
 * that would want them hang off a ⌘K leader instead. Tauri can add the direct forms
 * later without anything being relearned.
 */

export interface Chord {
  key: string;
  /** The platform command modifier: ⌘ on macOS, Ctrl elsewhere. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface Binding {
  id: string;
  /** What the bar and the help overlay call it. */
  label: string;
  /** One line for the help overlay: what pressing it does. */
  describe: string;
  /** The direct chord, if it has one. */
  chord?: Chord;
  /** The second key of a ⌘K chord. */
  leader?: string;
  /** The slash command that does the same thing, without the slash. */
  command?: string;
  /** Which views show it on the key bar, in this order. */
  bar?: ViewKind[];
  /** Grouping in the help overlay. */
  group: "panels" | "open" | "session" | "loop";
}

const ALL_VIEWS: ViewKind[] = ["chat", "files", "editor", "viewer", "log", "sql", "inspector"];

export const BINDINGS: Binding[] = [
  // — panels —
  {
    id: "focusLeft", label: "left panel", group: "panels",
    describe: "focus the left panel",
    chord: { key: "1", mod: true },
  },
  {
    id: "focusRight", label: "right panel", group: "panels",
    describe: "focus the right panel",
    chord: { key: "2", mod: true },
  },
  {
    id: "swapFocus", label: "swap panels", group: "panels",
    describe: "move focus to the other panel",
    chord: { key: "Tab" },
  },
  {
    id: "collapse", label: "collapse", group: "panels",
    describe: "hide the other panel, or bring it back",
    chord: { key: "b", mod: true }, bar: ALL_VIEWS,
  },
  {
    id: "maximize", label: "maximize", group: "panels",
    describe: "widen this panel to 80%, or restore it",
    chord: { key: "Enter", mod: true, shift: true }, bar: ALL_VIEWS,
  },
  {
    id: "even", label: "even split", group: "panels",
    describe: "put the gutter back in the middle",
    chord: { key: "0", mod: true },
  },
  {
    id: "widen", label: "widen", group: "panels",
    describe: "move the gutter right by 5%",
    chord: { key: "ArrowRight", mod: true },
  },
  {
    id: "narrow", label: "narrow", group: "panels",
    describe: "move the gutter left by 5%",
    chord: { key: "ArrowLeft", mod: true },
  },
  {
    id: "cycleTab", label: "next tab", group: "panels",
    describe: "cycle tabs in the focused panel",
    chord: { key: "Tab", mod: true },
  },
  {
    id: "newTab", label: "new tab", group: "panels",
    describe: "open a file manager tab here",
    leader: "t", bar: ["chat"],
  },
  {
    id: "closeTab", label: "close tab", group: "panels",
    describe: "close the active tab",
    leader: "w", bar: ALL_VIEWS,
  },

  // — open —
  {
    id: "help", label: "help", group: "open",
    describe: "every key, and what it does",
    chord: { key: "/", mod: true }, command: "help", bar: ALL_VIEWS,
  },
  {
    id: "menu", label: "menu", group: "open",
    describe: "sessions, files, and everything else",
    chord: { key: "k", mod: true }, bar: ALL_VIEWS,
  },
  {
    id: "attach", label: "attach", group: "open",
    describe: "the + picker: files, skills, tools, images",
    chord: { key: "a", mod: true, shift: true }, command: "attach", bar: ["chat", "files"],
  },
  {
    id: "file", label: "file", group: "open",
    describe: "fuzzy-find a file; ⏎ here, ⌘⏎ the other panel",
    chord: { key: "p", mod: true }, command: "files", bar: ALL_VIEWS,
  },
  {
    id: "touched", label: "touched", group: "open",
    describe: "files this session has read or changed",
    chord: { key: "p", mod: true, shift: true }, command: "touched", bar: ["chat"],
  },
  {
    id: "files", label: "file manager", group: "open",
    describe: "focus the file manager",
    command: "browse",
  },
  {
    id: "openFolder", label: "open folder", group: "open",
    describe: "another repo",
    chord: { key: "o", mod: true },
  },
  {
    id: "system", label: "system", group: "open",
    describe: "edit what the brain is told about the harness",
    chord: { key: "m", mod: true, shift: true }, command: "system", bar: ["chat", "files"],
  },
  {
    id: "context", label: "context", group: "open",
    describe: "what the last turn actually sent, layer by layer",
    chord: { key: "i", mod: true }, command: "context", bar: ["chat"],
  },
  {
    id: "settings", label: "settings", group: "open",
    describe: "mode, loop limits, brain",
    chord: { key: ",", mod: true }, command: "model", bar: ALL_VIEWS,
  },

  // — session —
  {
    id: "newSession", label: "new session", group: "session",
    describe: "start a conversation in a new tab",
    leader: "n", command: "new",
  },
  {
    id: "sessions", label: "sessions", group: "session",
    describe: "switch to another conversation",
    chord: { key: "s", mod: true, shift: true }, command: "sessions",
  },
  {
    id: "clear", label: "clear", group: "session",
    describe: "empty this conversation, keeping the session",
    leader: "l", command: "clear",
  },
  {
    id: "rewind", label: "rewind", group: "session",
    describe: "the navigator: fork, truncate, drop a turn",
    leader: "r", command: "rewind",
  },

  // — loop —
  {
    id: "compact", label: "compact", group: "loop",
    describe: "summarise the older turns to free context",
    leader: "c", command: "compact", bar: ["chat"],
  },
  {
    id: "cancel", label: "cancel", group: "loop",
    describe: "stop the running turn",
    chord: { key: "Escape" },
  },
];

export const byId = (id: string): Binding | undefined => BINDINGS.find((b) => b.id === id);

export const commands = (): Binding[] => BINDINGS.filter((b) => b.command);

export const byCommand = (name: string): Binding | undefined =>
  BINDINGS.find((b) => b.command === name.toLowerCase());

const isMac = (): boolean =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const MOD = (): string => (isMac() ? "⌘" : "Ctrl+");

const KEY_LABELS: Record<string, string> = {
  Enter: "⏎", Escape: "Esc", Tab: "⇥",
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
};

/** How a binding is written on the bar and in help. */
export function hint(binding: Binding): string {
  if (binding.chord) {
    const { key, mod, shift, alt } = binding.chord;
    const label = KEY_LABELS[key] ?? key.toUpperCase();
    return `${mod ? MOD() : ""}${shift ? "⇧" : ""}${alt ? "⌥" : ""}${label}`;
  }
  if (binding.leader) return `${MOD()}K ${binding.leader.toUpperCase()}`;
  return "";
}

/** True when the event carries the platform's command modifier. */
export const hasMod = (e: KeyboardEvent | React.KeyboardEvent): boolean => e.metaKey || e.ctrlKey;

export function matches(e: KeyboardEvent, chord: Chord): boolean {
  if (!!chord.mod !== hasMod(e)) return false;
  if (!!chord.shift !== e.shiftKey) return false;
  if (!!chord.alt !== e.altKey) return false;
  return chord.key.length === 1
    ? e.key.toLowerCase() === chord.key.toLowerCase()
    : e.key === chord.key;
}

export function resolve(e: KeyboardEvent): Binding | undefined {
  return BINDINGS.find((b) => b.chord && matches(e, b.chord));
}

export function resolveLeader(key: string): Binding | undefined {
  return BINDINGS.find((b) => b.leader === key.toLowerCase());
}

/** §11: the bar shows what the keys do *here*. */
export function barFor(view: ViewKind | undefined): Binding[] {
  const actual = view ?? "chat";
  return BINDINGS.filter((b) => b.bar?.includes(actual));
}

export const GROUPS: { id: Binding["group"]; label: string }[] = [
  { id: "panels", label: "panels" },
  { id: "open", label: "open" },
  { id: "session", label: "session" },
  { id: "loop", label: "the loop" },
];
