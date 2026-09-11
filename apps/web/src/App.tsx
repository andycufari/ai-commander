import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Event, PanelSide, Tab } from "@aicommander/protocol";
import { connect, echoUser, initialState, reduce, type ChatRow, type Connection, type UiState } from "./ws.js";
import { GUTTER_STEP, useGutterDrag, usePanelLayout } from "./panels.js";
import { keysFor, usePanelTabs, type FKeySet, type PanelTabs } from "./tabs.js";
import { FilesView } from "./FilesView.js";
import { Editor } from "./Editor.js";
import { ImageViewer } from "./ImageViewer.js";
import { defaultRegistry } from "./viewers.js";
import { addChips, removeChip, type Chip } from "./chips.js";
import type { Attachment } from "@aicommander/protocol";

/** The shell: top line, two tabbed panels with a draggable gutter, status line,
 *  and a context-relative F-bar. The files view lands in the next M1 step. */

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(
    (s: UiState, e: Event | { type: "__conn"; connected: boolean } | { type: "__echo"; text: string }): UiState => {
      if (e.type === "__conn") return { ...s, connected: e.connected };
      if (e.type === "__echo") return echoUser(s, e.text);
      return reduce(s, e);
    },
    initialState,
  );
  const conn = useRef<Connection>();

  useEffect(() => {
    const c = connect(
      (e) => dispatch(e),
      () => dispatch({ type: "__conn", connected: true }),
      () => dispatch({ type: "__conn", connected: false }),
    );
    conn.current = c;
    return () => c.close();
  }, []);

  // Open the most recent session, or start one — but only once session.list has
  // actually arrived. Acting on the initial empty list would create a duplicate
  // session on every reload and then open that empty one instead of the transcript.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !state.connected || !state.sessionsLoaded) return;
    opened.current = true;
    if (state.sessions.length > 0) {
      conn.current?.send({ type: "session.open", sessionId: state.sessions[0]!.id });
    } else {
      conn.current?.send({ type: "session.create" });
    }
  }, [state.connected, state.sessionsLoaded, state.sessions]);

  const send = useCallback((text: string, attachments: Attachment[] = []) => {
    if (!state.sessionId) return;
    const shown = attachments.length
      ? `${attachments.map((a) => (a.kind === "file" ? `@${a.path}` : "")).filter(Boolean).join(" ")}\n${text}`.trim()
      : text;
    dispatch({ type: "__echo", text: shown });
    conn.current?.send({ type: "session.send", sessionId: state.sessionId, text, attachments });
  }, [state.sessionId]);

  const cancel = useCallback(() => {
    if (state.sessionId) conn.current?.send({ type: "session.cancel", sessionId: state.sessionId });
  }, [state.sessionId]);

  const running = state.status === "running";
  const colsRef = useRef<HTMLDivElement>(null);
  const layout = usePanelLayout({});
  const drag = useGutterDrag(colsRef, layout.setGutter);

  // Each panel is a tabbed view host (§10). The chat tab is always there to start.
  const left = usePanelTabs([{ id: "chat", view: "chat", title: "chat", dirty: false, conflict: false }], "chat");
  const right = usePanelTabs([]);
  const focused = layout.focus === "left" ? left : right;

  // Toasts: bottom-right, 4s, stack 3 (§10).
  const [toasts, setToasts] = useState<{ id: number; level: "info" | "warning"; text: string }[]>([]);
  const toast = useCallback((level: "info" | "warning", text: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-2), { id, level, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  // Prompt attachments, as chips (§7). The M3 + picker adds to the same list.
  const [chips, setChips] = useState<Chip[]>([]);
  const mention = useCallback((attachments: Attachment[]) => {
    setChips((prev) => addChips(prev, attachments));
  }, []);

  /** Esc in a view returns to the chat (§11: "Esc → chat"). */
  const focusChat = useCallback(() => {
    const side: PanelSide = left.tabs.some((t) => t.view === "chat") ? "left" : "right";
    const host = side === "left" ? left : right;
    const chatTab = host.tabs.find((t) => t.view === "chat");
    if (chatTab) host.select(chatTab.id);
    layout.setFocus(side);
  }, [left, right, layout]);

  /** ⏎ on a file: the registry decides which view opens it, in the *other* panel (§5). */
  const openFile = useCallback((fromSide: PanelSide, path: string) => {
    const entry = defaultRegistry.resolve(path);
    const target = fromSide === "left" ? right : left;
    target.open({
      view: entry.view,
      title: path.split("/").pop() ?? path,
      path,
      viewer: entry.name,
      mode: entry.mode,
    });
  }, [left, right]);

  // Global keys (§11): Tab swaps focus, ⌃←/→ resizes, ⌃B collapses, Esc cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = (e.target as HTMLElement | null)?.tagName === "TEXTAREA";

      if (e.key === "Escape" && state.status === "running") {
        e.preventDefault();
        cancel();
        return;
      }
      // Tab swaps panels, but must still indent inside the prompt — and must not
      // swallow ⌃⇥, which cycles tabs within the focused panel.
      if (e.key === "Tab" && !typing && !e.ctrlKey) {
        e.preventDefault();
        layout.swapFocus();
        return;
      }
      if (e.ctrlKey && e.key === "ArrowLeft") {
        e.preventDefault();
        layout.setGutter((g) => g - GUTTER_STEP);
        return;
      }
      if (e.ctrlKey && e.key === "ArrowRight") {
        e.preventDefault();
        layout.setGutter((g) => g + GUTTER_STEP);
        return;
      }
      if (e.ctrlKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        layout.toggleCollapse();
        return;
      }
      // Tab host keys (§11): ⌃T new, ⌃W close, ⌃⇥ cycle.
      if (e.ctrlKey && (e.key === "t" || e.key === "T")) {
        e.preventDefault();
        // Until the picker exists, a new tab is a files view on the repo root.
        focused.open({ view: "files", title: "files", path: "." });
        return;
      }
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        focused.cycle(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.ctrlKey && (e.key === "w" || e.key === "W")) {
        e.preventDefault();
        if (focused.activeId) focused.close(focused.activeId);
        return;
      }
      if (e.key === "F10") e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.status, cancel, layout, focused]);

  const colsClass = [
    "cols",
    layout.collapsed === "left" ? "collapsed-left" : "",
    layout.collapsed === "right" ? "collapsed-right" : "",
  ].filter(Boolean).join(" ");

  const renderView = (tab: Tab | undefined, side: PanelSide): JSX.Element => {
    switch (tab?.view) {
      case "chat":
        return (
          <>
            <Chat rows={state.rows} running={running} />
            <Prompt
              onSend={send} running={running} queued={state.queued}
              focused={layout.focus === side}
              chips={chips}
              onRemoveChip={(key) => setChips((prev) => removeChip(prev, key))}
            />
          </>
        );
      case "editor":
        return (
          <Editor
            conn={conn.current}
            path={tab.path ?? ""}
            focused={layout.focus === side}
            mode={tab.mode ?? "edit"}
            onModeChange={(m) => (side === "left" ? left : right).update(tab.id, { mode: m })}
            onDirty={(d) => (side === "left" ? left : right).setDirty(tab.id, d)}
            onConflict={(c) => (side === "left" ? left : right).update(tab.id, { conflict: c })}
            onToast={toast}
            onEscape={focusChat}
          />
        );
      case "viewer":
        return (
          <ImageViewer
            path={tab.path ?? ""}
            focused={layout.focus === side}
            onEscape={focusChat}
          />
        );
      case "files":
        return (
          <FilesView
            conn={conn.current}
            path={tab.path ?? "."}
            focused={layout.focus === side}
            onNavigate={(next) => {
              const host = side === "left" ? left : right;
              host.update(tab.id, { path: next, title: next === "." ? "files" : next.split("/").pop()! });
            }}
            onOpen={(p) => openFile(side, p)}
            onMention={mention}
          />
        );
      default:
        return <div className="body empty">no view</div>;
    }
  };

  const panelExtra = (tab: Tab | undefined): React.ReactNode => {
    if (tab?.view !== "chat") return null;
    return running
      ? <span className="amber">running</span>
      : `${state.sessions.length} session${state.sessions.length === 1 ? "" : "s"}`;
  };

  return (
    <div className="screen" style={{ ["--gutter" as string]: String(layout.gutter) }}>
      <TopLine state={state} />
      <div className={colsClass} ref={colsRef}>
        <Panel
          side="left" focus={layout.focus} collapsed={layout.collapsed}
          onFocus={layout.setFocus} tabs={left}
          titleSuffix={left.active?.view === "chat" ? sessionName(state) : undefined}
          extra={panelExtra(left.active)}
        >
          {renderView(left.active, "left")}
        </Panel>
        <div
          className={drag.dragging ? "gutter dragging" : "gutter"}
          onPointerDown={drag.onPointerDown}
          title="drag, or ⌃← / ⌃→"
        />
        <Panel
          side="right" focus={layout.focus} collapsed={layout.collapsed}
          onFocus={layout.setFocus} tabs={right}
          extra={panelExtra(right.active)}
        >
          {renderView(right.active, "right")}
        </Panel>
      </div>
      <StatusLine state={state} layout={layout} />
      <FKeys keys={keysFor(focused.active?.view)} />
      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.level}`}>{t.text}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function Panel({
  side, focus, collapsed, onFocus, tabs, titleSuffix, extra, children,
}: {
  side: PanelSide;
  focus: PanelSide;
  collapsed: PanelSide | null;
  onFocus: (s: PanelSide) => void;
  tabs: PanelTabs;
  titleSuffix?: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  const cls = [
    "blk",
    focus === side ? "focus" : "",
    collapsed === side ? "hidden" : "",
  ].filter(Boolean).join(" ");

  const title = tabs.active
    ? `${tabs.active.title}${titleSuffix ? ` · ${titleSuffix}` : ""}`
    : "panel";

  return (
    <div className={cls} onMouseDown={() => onFocus(side)}>
      <div className="t">{title}</div>
      {extra !== null && extra !== undefined && <div className="tr">{extra}</div>}
      {tabs.tabs.length > 1 && (
        <div className="tabs">
          {tabs.tabs.map((t) => (
            <span
              key={t.id}
              className={`tab${t.id === tabs.activeId ? " on" : ""}${t.conflict ? " conflict" : ""}`}
              onMouseDown={(e) => { e.stopPropagation(); onFocus(side); tabs.select(t.id); }}
            >
              {t.title}{t.dirty ? " ●" : ""}
              <i
                className="x"
                title="close"
                onMouseDown={(e) => { e.stopPropagation(); tabs.close(t.id); }}
              >×</i>
            </span>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

const sessionName = (s: UiState): string =>
  s.sessions.find((x) => x.id === s.sessionId)?.name ?? "";

function TopLine({ state }: { state: UiState }): JSX.Element {
  const brain = state.config?.brain;
  const host = brain ? hostOf(brain.endpoint) : "";
  return (
    <div className="topline">
      <b>ai commander</b>
      <span className="path" title={state.root}>{state.root ? tilde(state.root) : "connecting…"}</span>
      {state.git && (
        <span className="hi">
          git {state.git.branch}
          {state.git.dirty > 0 ? " ●" : ""}
        </span>
      )}
      <div className="r">
        {brain && <span className="amber">brain {brain.model} @ {host}</span>}
        <span>ctx {fmtK(state.ctxUsed)}/{fmtK(state.ctxMax)}</span>
        {!state.connected && <span style={{ color: "var(--red)" }}>disconnected</span>}
      </div>
    </div>
  );
}

/** The mockup writes the repo as ~/lab/… — collapse $HOME the same way. */
function tilde(path: string): string {
  const home = homeFromPath(path);
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** The browser has no $HOME, so infer it from the shape of a macOS/Linux user path. */
function homeFromPath(path: string): string | undefined {
  const m = /^(\/(?:Users|home)\/[^/]+)/.exec(path);
  return m?.[1];
}

const hostOf = (endpoint: string): string => {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
};

const fmtK = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function Chat({ rows, running }: { rows: ChatRow[]; running: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow the stream, unless the user has scrolled up to read something.
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [rows]);

  const onScroll = (): void => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <div className="body wrap" ref={ref} onScroll={onScroll}>
      {rows.map((r, i) => <Row key={r.callId ?? i} row={r} />)}
      {running && rows[rows.length - 1]?.kind !== "tool" && <div className="b"><span className="spin">⠹</span></div>}
    </div>
  );
}

function Row({ row }: { row: ChatRow }): JSX.Element {
  if (row.kind === "tool") {
    const cls = row.ok === false ? "tool err" : "tool";
    return (
      <div className={cls}>
        {row.running && <span className="spin">⠹ </span>}
        {row.name} <i>{row.args}</i>
        {row.summary ? `  ${row.summary}` : row.running ? " …" : ""}
      </div>
    );
  }
  return <div className={row.kind === "user" ? "u" : "b"}>{row.text}</div>;
}

function Prompt({
  onSend, running, queued, focused, chips, onRemoveChip,
}: {
  onSend: (text: string, attachments: Attachment[]) => void;
  running: boolean;
  queued?: string;
  focused: boolean;
  chips: Chip[];
  onRemoveChip: (key: string) => void;
}): JSX.Element {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the text up to 40% of the panel, then scroll (§10).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const max = Math.round(window.innerHeight * 0.4);
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [text]);

  // Only hold the caret while this panel has focus, so Tab can leave it.
  useEffect(() => {
    if (focused) ref.current?.focus();
    else ref.current?.blur();
  }, [focused]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const trimmed = text.trim();
      // Attachments alone are not a turn; the model needs something to do with them.
      if (!trimmed) return;
      onSend(trimmed, chips.map((c) => c.attachment));
      setText("");
    }
    // Backspace at the very start removes the last chip, the way a mail client does.
    if (e.key === "Backspace" && text === "" && chips.length > 0) {
      e.preventDefault();
      onRemoveChip(chips[chips.length - 1]!.key);
    }
  };

  const footer = queued
    ? "queued · sends at the next tool boundary"
    : running
      ? "⏎ queue · Esc cancel"
      : "⏎ send · ⇧⏎ newline";

  return (
    <div className="prompt">
      <span className="t">prompt</span>
      {chips.length > 0 && (
        <div className="chips">
          {chips.map((c) => (
            <span key={c.key} className={`chip ${c.attachment.kind}`}>
              {c.label}
              <i className="x" title="remove" onMouseDown={(e) => { e.preventDefault(); onRemoveChip(c.key); }}>×</i>
            </span>
          ))}
        </div>
      )}
      <div className="row">
        <span className="chev">›</span>
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={running ? "" : "ask the brain"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
      </div>
      <span className="tb">{footer}</span>
    </div>
  );
}

function StatusLine({
  state, layout,
}: { state: UiState; layout: { focus: string; other: string; gutter: number } }): JSX.Element {
  const running = state.status === "running";
  return (
    <div className="status">
      {running ? (
        <>
          <span className="amber">
            running · {state.toolCount} tool{state.toolCount === 1 ? "" : "s"} · {Math.round(state.elapsed)}s
          </span>
          <span>Esc cancel</span>
        </>
      ) : (
        <>
          <span>{state.status === "cancelled" ? <span className="red">cancelled</span> : "idle"}</span>
          <span>⏎ send</span>
          <span>⇧⏎ newline</span>
        </>
      )}
      <span>Tab → {layout.other}</span>
      <div className="r">
        {state.error && <span className="red">{state.error}</span>}
        {state.queued && <span className="amber">1 queued</span>}
      </div>
    </div>
  );
}

function FKeys({ keys }: { keys: FKeySet }): JSX.Element {
  return (
    <div className="fkeys">
      {keys.map(([key, label, live]) => (
        <span key={key}>
          <b>{key}</b>
          <span className={live ? "ctx" : undefined}>{label}</span>
        </span>
      ))}
    </div>
  );
}
