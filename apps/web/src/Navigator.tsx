import { useEffect, useMemo, useRef, useState } from "react";
import type { Group } from "@aicommander/protocol";
import { useModalLock } from "./modal-stack.js";

/**
 * §10 session navigator / rewind (F7, or Esc Esc).
 *
 * Groups with what they cost, and the operations that change history. Token counts come
 * from the log rather than a render-time estimate, so the number you decide on is the
 * number that was actually spent.
 */

export type NavAction = "fork" | "truncate" | "drop" | "dropOutputs" | "compact";

export interface NavigatorProps {
  groups: readonly Group[];
  /** Group ids that have a snapshot, so the list can say what a rewind will restore. */
  snapshots: ReadonlySet<string>;
  onAction: (action: NavAction, groupId: string) => void;
  onClose: () => void;
}

const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export function Navigator({ groups, snapshots, onAction, onClose }: NavigatorProps): JSX.Element {
  useModalLock();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(Math.max(0, groups.length - 1));
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [...groups];
    return groups.filter(
      (g) => g.userText.toLowerCase().includes(q) || g.brainText.toLowerCase().includes(q),
    );
  }, [groups, query]);

  useEffect(() => { setCursor(Math.max(0, shown.length - 1)); }, [shown.length]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    listRef.current?.querySelector(".nav-row.sel")?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const act = (action: NavAction): void => {
    const group = shown[cursor];
    if (group) onAction(action, group.id);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); setCursor((c) => Math.min(shown.length - 1, c + 1)); return;
      case "ArrowUp": e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); return;
      case "Enter": e.preventDefault(); act("fork"); return;
      case "Escape": e.preventDefault(); e.stopPropagation(); onClose(); return;
      case "t": if (!query) { e.preventDefault(); act("truncate"); } return;
      case "x": if (!query) { e.preventDefault(); act("dropOutputs"); } return;
      case "c": if (!query) { e.preventDefault(); act("compact"); } return;
      case "Delete": case "Backspace":
        if (!query && e.key === "Delete") { e.preventDefault(); act("drop"); }
        return;
      default: return;
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className="modal info navigator"
        role="dialog"
        aria-label="session navigator"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <span className="t">session</span>
        <input
          ref={inputRef}
          className="pick-filter"
          value={query}
          placeholder="/ search"
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
          aria-label="search the session"
        />
        <div className="nav-list" ref={listRef} role="listbox">
          {shown.map((g, i) => (
            <div
              key={g.id}
              className={`nav-row${i === cursor ? " sel" : ""}`}
              role="option"
              aria-selected={i === cursor}
              onMouseMove={() => setCursor(i)}
              onMouseDown={(e) => { e.preventDefault(); setCursor(i); }}
              onDoubleClick={() => onAction("fork", g.id)}
            >
              <span className="nav-text">
                {g.cancelled ? <span className="red">✗ </span> : null}
                {g.userText || <span className="dim">(no prompt)</span>}
              </span>
              <span className="nav-meta">
                {snapshots.has(g.id) ? "⏱ " : ""}
                {g.toolCount > 0 ? `${g.toolCount} tool${g.toolCount === 1 ? "" : "s"} · ` : ""}
                {fmtTokens(g.tokens)}
              </span>
            </div>
          ))}
          {shown.length === 0 && <div className="pick-empty">nothing matches</div>}
        </div>
        <div className="k">⏎ fork · t truncate · Del drop · x drop output · c compact · Esc close</div>
      </div>
    </div>
  );
}
