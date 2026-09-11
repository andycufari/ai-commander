import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment, FsEntry } from "@aicommander/protocol";
import type { Connection } from "./ws.js";
import {
  ALWAYS_VISIBLE, formatDate, formatSize, joinPath, parentOf, summarize, visibleEntries,
} from "./files.js";
import { fileAttachment } from "./chips.js";

/**
 * §10 files view — NC list with name, size, date.
 * ↑↓ move · ⏎ open in the other panel (dir: enter) · Backspace up · Ins mark ·
 * @ mentions the marked set into the prompt · ⌃H hidden files.
 */

export interface FilesViewProps {
  conn: Connection | undefined;
  path: string;
  focused: boolean;
  /** Bumped by fs.changed so the listing refreshes (M1 step 6). */
  revision?: number;
  onNavigate: (path: string) => void;
  /** ⏎ on a file — the panel host routes it through the viewer registry. */
  onOpen: (path: string) => void;
  /** @ on the marked set (or the cursor row when nothing is marked). */
  onMention: (attachments: Attachment[]) => void;
  /** Marks live in the app so workspace.json can hold them (v2 §4). */
  marked?: readonly string[];
  onMarkedChange?: (marked: string[]) => void;
}

export function FilesView({
  conn, path, focused, revision, onNavigate, onOpen, onMention,
  marked: markedProp, onMarkedChange,
}: FilesViewProps): JSX.Element {
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [error, setError] = useState<string>();
  const [cursor, setCursor] = useState(0);
  const [marked, setMarked] = useState<Set<string>>(new Set(markedProp ?? []));
  const [showHidden, setShowHidden] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  /** False until the first listing, so a refresh can be told from a first load. */
  const listedOnce = useRef(false);

  /**
   * List the directory, and re-list it when the watcher reports a change.
   *
   * A refresh keeps the cursor and the marks: the file you were looking at should still
   * be under the cursor after the brain writes something elsewhere in the tree.
   */
  useEffect(() => {
    let cancelled = false;
    if (!conn) return;
    const isRefresh = listedOnce.current;
    conn
      .request({ type: "fs.list", path }, "fs.listed")
      .then((e) => {
        if (cancelled) return;
        listedOnce.current = true;
        setEntries((e as { entries: FsEntry[] }).entries);
        setError(undefined);
        if (!isRefresh) setCursor(0);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => { cancelled = true; };
  }, [conn, path, revision]);

  const rows = visibleEntries(entries, showHidden);
  const atRoot = parentOf(path) === null;
  const current = rows[Math.min(cursor, rows.length - 1)];

  useEffect(() => {
    onMarkedChange?.([...marked]);
  }, [marked, onMarkedChange]);

  // Marks belong to the directory they were made in — but survive a refresh of it.
  useEffect(() => {
    listedOnce.current = false;
    setMarked(new Set());
  }, [path]);

  const move = useCallback((delta: number) => {
    setCursor((c) => Math.max(0, Math.min(rows.length - 1, c + delta)));
  }, [rows.length]);

  const enter = useCallback((entry: FsEntry | undefined) => {
    if (!entry) return;
    if (entry.dir) onNavigate(entry.path);
    else onOpen(entry.path);
  }, [onNavigate, onOpen]);

  const up = useCallback(() => {
    const parent = parentOf(path);
    if (parent !== null) onNavigate(parent);
  }, [path, onNavigate]);

  const toggleMark = useCallback((entry: FsEntry | undefined) => {
    if (!entry || entry.dir) return;
    setMarked((prev) => {
      const next = new Set(prev);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    move(1);
  }, [move]);

  const mention = useCallback(() => {
    // Nothing marked → mention the row under the cursor, which is what you meant.
    const paths = marked.size > 0 ? [...marked] : current && !current.dir ? [current.path] : [];
    if (paths.length === 0) return;
    onMention(paths.map(fileAttachment));
    setMarked(new Set());
  }, [marked, current, onMention]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); move(1); return;
      case "ArrowUp": e.preventDefault(); move(-1); return;
      case "PageDown": e.preventDefault(); move(10); return;
      case "PageUp": e.preventDefault(); move(-10); return;
      case "Home": e.preventDefault(); setCursor(0); return;
      case "End": e.preventDefault(); setCursor(rows.length - 1); return;
      case "Enter": e.preventDefault(); enter(current); return;
      case "Backspace": e.preventDefault(); up(); return;
      case "Insert": e.preventDefault(); toggleMark(current); return;
      case "@": e.preventDefault(); mention(); return;
      default:
        if (e.ctrlKey && (e.key === "h" || e.key === "H")) {
          e.preventDefault();
          setShowHidden((v) => !v);
        }
    }
  };

  // Keep the cursor row in view as it moves.
  useEffect(() => {
    listRef.current?.querySelector(".row.sel")?.scrollIntoView({ block: "nearest" });
  }, [cursor, rows.length]);

  useEffect(() => {
    if (focused) listRef.current?.focus();
  }, [focused]);

  return (
    <>
      <div
        className="body files"
        ref={listRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        role="listbox"
        aria-label="files"
      >
        {error && <div className="err-row">{error}</div>}
        {!atRoot && (
          <div className="row up" onDoubleClick={up}>
            <span className="d">▸ ..</span>
          </div>
        )}
        {rows.map((entry, i) => {
          const isMarked = marked.has(entry.path);
          const label = ALWAYS_VISIBLE[entry.name];
          return (
            <div
              key={entry.path}
              className={`row${i === cursor ? " sel" : ""}${isMarked ? " marked" : ""}`}
              onMouseDown={() => setCursor(i)}
              onDoubleClick={() => enter(entry)}
              role="option"
              aria-selected={i === cursor}
            >
              <span className="nm">
                {entry.dir ? <span className="d">▸ {entry.name}/</span> : (
                  <>{isMarked ? <span className="mark">✓ </span> : "  "}{entry.name}</>
                )}
              </span>
              <span className="sz">{formatSize(entry.size, entry.dir)}</span>
              <span className="dt">{label ? <span className="dim">{label}</span> : formatDate(entry.mtime)}</span>
            </div>
          );
        })}
        {rows.length === 0 && !error && <div className="dim">(empty)</div>}
      </div>
      <div className="tb files-tb">
        {summarize(rows, marked.size)}{showHidden ? " · hidden shown" : ""}
      </div>
    </>
  );
}
