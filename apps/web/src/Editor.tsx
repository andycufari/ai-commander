import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, rectangularSelection, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { cpp } from "@codemirror/lang-cpp";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { commanderTheme } from "./cm-theme.js";
import { renderMarkdown } from "./markdown.js";
import { extensionOf } from "./viewers.js";
import type { Connection } from "./ws.js";
import { modalOpen, unlessModal } from "./modal-stack.js";

/**
 * §10 editor — CodeMirror 6, minimal extensions. No autocomplete: this is a harness
 * for iterating with a brain, not an IDE, and a popup stealing Enter would fight the
 * prompt. ⌃S saves, ⌃E toggles markdown edit⇄preview in place, Esc returns to chat.
 */

const languageFor = (path: string): Extension[] => {
  switch (extensionOf(path)) {
    case "md": case "markdown": case "mdx": return [markdown()];
    case "js": case "jsx": case "mjs": case "cjs": return [javascript()];
    case "ts": case "tsx": return [javascript({ typescript: true })];
    case "c": case "h": case "cpp": case "hpp": case "cc": return [cpp()];
    case "py": return [python()];
    case "json": case "jsonc": return [json()];
    default: return [];
  }
};

export interface EditorProps {
  conn: Connection | undefined;
  path: string;
  focused: boolean;
  /** "view" renders markdown; "edit" shows the buffer. Toggled by ⌃E. */
  mode: "view" | "edit";
  onModeChange: (mode: "view" | "edit") => void;
  onDirty: (dirty: boolean) => void;
  /** Conflict marks the tab; the full warning modal is M2. */
  onConflict: (conflict: boolean) => void;
  onToast: (level: "info" | "warning", text: string) => void;
  onEscape: () => void;
  /** Bumped when fs.changed names this path. */
  revision?: number;
  /** The file stopped existing, or came back. */
  onMissing?: (missing: boolean) => void;
}

export function Editor({
  conn, path, focused, mode, onModeChange, onDirty, onConflict, onToast, onEscape, revision,
  onMissing,
}: EditorProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();

  /**
   * The callers pass inline arrows, so these identities change every render. Holding
   * them in refs keeps the load effect and the CodeMirror instance keyed on the file
   * alone — otherwise every parent render refetched the file and threw the buffer away.
   */
  const cb = useRef({ onDirty, onConflict, onToast, onEscape, onModeChange, onMissing });
  cb.current = { onDirty, onConflict, onToast, onEscape, onModeChange, onMissing };
  const [loaded, setLoaded] = useState<string>();
  const [error, setError] = useState<string>();
  /** Hash of the content we loaded — fs.write rejects if disk has moved on (§3). */
  const baseHash = useRef<string | null>(null);
  /** What is on disk as far as we know — dirty is measured against this, not the
   *  originally loaded text, or the tab would stay marked after a save. */
  const savedDoc = useRef<string>("");
  const dirtyRef = useRef(false);
  /** False until the first successful read, so a reload can be told from a first load. */
  const loadedOnce = useRef(false);

  const isMarkdown = ["md", "markdown", "mdx"].includes(extensionOf(path));

  /**
   * Load the file, and reload it when the watcher says it changed on disk.
   *
   * A clean buffer takes the new content silently — that is the whole point of watching.
   * A dirty buffer is left alone and marked conflict, the same path as a ⌃S hash
   * mismatch: the user's unsaved edits are the thing worth protecting, and the M2
   * warning modal will offer the choice properly.
   */
  useEffect(() => {
    let cancelled = false;
    if (!conn) return;
    const isReload = loadedOnce.current;

    conn.request({ type: "fs.read", path }, "fs.content")
      .then((e) => {
        if (cancelled) return;
        const reply = e as { content: string; hash: string };
        cb.current.onMissing?.(false);

        if (isReload && dirtyRef.current) {
          if (reply.hash !== baseHash.current) {
            cb.current.onConflict(true);
            cb.current.onToast("warning", `${path} changed on disk — your unsaved edits are kept`);
          }
          return;
        }
        if (isReload && reply.content === savedDoc.current) return;

        loadedOnce.current = true;
        baseHash.current = reply.hash;
        savedDoc.current = reply.content;
        setLoaded(reply.content);
        setError(undefined);
        dirtyRef.current = false;
        cb.current.onDirty(false);
        cb.current.onConflict(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        // A restored tab whose file is gone keeps its place and says so (§10).
        cb.current.onMissing?.(true);
        if (!loadedOnce.current) setError(err.message);
      });
    return () => { cancelled = true; };
  }, [conn, path, revision]);

  const save = useCallback((): boolean => {
    const v = view.current;
    if (!v || !conn) return false;
    const content = v.state.doc.toString();
    conn.request({ type: "fs.write", path, content, baseHash: baseHash.current }, "fs.wrote")
      .then((e) => {
        // The reply carries the hash of what is now on disk, so the buffer re-bases
        // without a second read.
        baseHash.current = (e as { hash: string }).hash;
        savedDoc.current = content;
        loadedOnce.current = true;
        dirtyRef.current = false;
        cb.current.onDirty(false);
        cb.current.onConflict(false);
        cb.current.onToast("info", `saved ${path}`);
      })
      .catch((err: Error) => {
        // Keep the buffer — the user's edits are the thing worth protecting.
        // The full warning modal with a diff is M2; a toast and a tab mark for now.
        cb.current.onConflict(true);
        cb.current.onToast("warning", `${path} changed on disk — your edits are kept, not saved`);
      });
    return true;
  }, [conn, path]);

  // Build the view once per file, and once per mode change out of preview.
  useEffect(() => {
    if (loaded === undefined || !host.current) return;
    if (isMarkdown && mode === "view") return;

    // §11 writes these as ⌃S and ⌃E. CodeMirror's `Mod-` is Cmd on macOS, so both
    // are bound: the documented Ctrl chord works everywhere, and Cmd works where a
    // mac user's fingers expect it.
    const toggleMode = (): boolean => {
      if (isMarkdown) cb.current.onModeChange("view");
      return true;
    };
    // CodeMirror has its own key pipeline, so the modal rule is applied to each
    // binding rather than to a React handler.
    const guard = (run: () => boolean) => (): boolean => (modalOpen() ? true : run());
    const saveKey = keymap.of([
      { key: "Mod-s", preventDefault: true, run: guard(() => save()) },
      { key: "Ctrl-s", preventDefault: true, run: guard(() => save()) },
      { key: "Mod-e", preventDefault: true, run: guard(toggleMode) },
      { key: "Ctrl-e", preventDefault: true, run: guard(toggleMode) },
      { key: "Escape", preventDefault: true, run: guard(() => { cb.current.onEscape(); return true; }) },
    ]);

    const state = EditorState.create({
      doc: loaded,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        rectangularSelection(),
        highlightActiveLine(),
        indentOnInput(),
        bracketMatching(),
        foldGutter(),
        search({ top: false }),
        highlightSelectionMatches(),
        // saveKey first so ⌃S and Esc win over the defaults.
        saveKey,
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
        ...languageFor(path),
        commanderTheme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          const nowDirty = u.state.doc.toString() !== savedDoc.current;
          if (nowDirty !== dirtyRef.current) {
            dirtyRef.current = nowDirty;
            cb.current.onDirty(nowDirty);
          }
        }),
      ],
    });

    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    // The EditorView is reachable from its DOM node, which is how CodeMirror itself
    // expects tooling to find it; ui-check drives real transactions through this.
    (host.current as HTMLElement & { cmView?: EditorView }).cmView = v;
    return () => { v.destroy(); view.current = undefined; };
  }, [loaded, path, isMarkdown, mode, save]);

  useEffect(() => {
    if (focused && view.current) view.current.focus();
  }, [focused, loaded, mode]);

  // In preview mode the keys live on the container, since there is no CodeMirror.
  const onPreviewKey = unlessModal((e: React.KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "e" || e.key === "E")) {
      e.preventDefault();
      cb.current.onModeChange("edit");
    } else if (e.key === "Escape") {
      e.preventDefault();
      cb.current.onEscape();
    }
  });

  const html = useMemo(
    () => (isMarkdown && mode === "view" && loaded !== undefined ? renderMarkdown(loaded) : ""),
    [isMarkdown, mode, loaded],
  );

  if (error && loaded === undefined) {
    return <div className="body empty"><span className="red">{error}</span></div>;
  }
  if (loaded === undefined) {
    return <div className="body empty">reading {path}…</div>;
  }

  if (isMarkdown && mode === "view") {
    return (
      <div
        className="body md"
        tabIndex={0}
        onKeyDown={onPreviewKey}
        // Rendered by renderMarkdown, which escapes all input before emitting tags.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return <div className="body cm" ref={host} />;
}
