/**
 * §11 keymap, adapted for a browser.
 *
 * F-keys are out: many keyboards do not have them, macOS maps them to media by default,
 * and the browser claims several. The F-bar stays — it is the shell's visual language —
 * but it shows the chord that actually works.
 *
 * A few chords can never be ours in a tab (⌘W, ⌘N, ⌘T, ⌘Q close or open browser
 * windows). Rather than fight for them, the things they would have done hang off a
 * ⌘K leader, the way Slack and VS Code do it. In Tauri the direct chords come back and
 * the leader keeps working, so nothing has to be relearned.
 */

export type Chord = { key: string; mod?: boolean; shift?: boolean; alt?: boolean };

export interface Binding {
  id: string;
  /** What the F-bar and help overlay show. */
  label: string;
  /** Printed form of the chord, e.g. "⌘P" or "⌘K W". */
  hint: string;
  chord?: Chord;
  /** Second key, pressed after ⌘K. */
  leader?: string;
}

/** True when the event carries the platform's command modifier. */
export const hasMod = (e: KeyboardEvent | React.KeyboardEvent): boolean => e.metaKey || e.ctrlKey;

const isMac = (): boolean =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export const MOD = (): string => (isMac() ? "⌘" : "Ctrl+");

export const BINDINGS: Binding[] = [
  // Direct chords the browser leaves alone.
  { id: "help", label: "help", hint: "⌘/", chord: { key: "/", mod: true } },
  { id: "attach", label: "attach", hint: "⌘⇧A", chord: { key: "a", mod: true, shift: true } },
  { id: "sessions", label: "sessions", hint: "⌘⇧S", chord: { key: "s", mod: true, shift: true } },
  { id: "file", label: "file", hint: "⌘P", chord: { key: "p", mod: true } },
  { id: "touched", label: "touched", hint: "⌘⇧P", chord: { key: "p", mod: true, shift: true } },
  { id: "menu", label: "menu", hint: "⌘K", chord: { key: "k", mod: true } },
  { id: "settings", label: "settings", hint: "⌘,", chord: { key: ",", mod: true } },
  { id: "system", label: "system", hint: "⌘⇧M", chord: { key: "m", mod: true, shift: true } },
  { id: "context", label: "context", hint: "⌘I", chord: { key: "i", mod: true } },
  { id: "openFolder", label: "open", hint: "⌘O", chord: { key: "o", mod: true } },
  { id: "collapse", label: "collapse", hint: "⌘B", chord: { key: "b", mod: true } },
  { id: "even", label: "even split", hint: "⌘0", chord: { key: "0", mod: true } },
  { id: "maximize", label: "maximize", hint: "⌘⇧↵", chord: { key: "Enter", mod: true, shift: true } },
  { id: "compact", label: "compact", hint: "⌘K C", leader: "c" },
  { id: "clear", label: "clear", hint: "⌘K L", leader: "l" },
  { id: "newSession", label: "new session", hint: "⌘K N", leader: "n" },
  { id: "newTab", label: "new tab", hint: "⌘K T", leader: "t" },
  { id: "closeTab", label: "close tab", hint: "⌘K W", leader: "w" },
  { id: "rewind", label: "rewind", hint: "⌘K R", leader: "r" },
];

export const byId = (id: string): Binding | undefined => BINDINGS.find((b) => b.id === id);

/** Does this event match the chord? */
export function matches(e: KeyboardEvent, chord: Chord): boolean {
  if (chord.mod && !hasMod(e)) return false;
  if (!chord.mod && hasMod(e)) return false;
  if (!!chord.shift !== e.shiftKey) return false;
  if (chord.key.length === 1) return e.key.toLowerCase() === chord.key.toLowerCase();
  return e.key === chord.key;
}

/** The binding an event fires, if any. */
export function resolve(e: KeyboardEvent): Binding | undefined {
  return BINDINGS.find((b) => b.chord && matches(e, b.chord));
}

/** The binding a leader key selects, after ⌘K. */
export function resolveLeader(key: string): Binding | undefined {
  return BINDINGS.find((b) => b.leader === key.toLowerCase());
}

/** The bar along the bottom — what the keys do *here* (§11). */
export function barFor(view: string | undefined): Binding[] {
  const ids = view === "files"
    // `attach` and `system` earn their place here too: you browse files in this panel,
    // and both are otherwise only reachable by a chord nobody has memorised yet.
    ? ["help", "menu", "attach", "file", "system", "collapse", "maximize", "closeTab", "settings"]
    : view === "editor" || view === "viewer"
      ? ["help", "menu", "file", "touched", "collapse", "maximize", "closeTab", "settings"]
      : ["help", "menu", "attach", "file", "touched", "system", "context", "compact", "settings"];
  return ids.map(byId).filter((b): b is Binding => b !== undefined);
}
