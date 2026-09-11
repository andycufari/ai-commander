import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Event } from "@aicommander/protocol";
import type { PanelSide } from "@aicommander/protocol";
import { connect, echoUser, initialState, reduce, type ChatRow, type Connection, type UiState } from "./ws.js";
import { GUTTER_STEP, useGutterDrag, usePanelLayout } from "./panels.js";

/** The shell: top line, two panels with a draggable gutter, status line, F-bar.
 *  Tabs and the files view land in the next M1 steps. */

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

  const send = useCallback((text: string) => {
    if (!state.sessionId) return;
    dispatch({ type: "__echo", text });
    conn.current?.send({ type: "session.send", sessionId: state.sessionId, text, attachments: [] });
  }, [state.sessionId]);

  const cancel = useCallback(() => {
    if (state.sessionId) conn.current?.send({ type: "session.cancel", sessionId: state.sessionId });
  }, [state.sessionId]);

  // Esc cancels the loop from anywhere in the app (§11).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && state.status === "running") {
        e.preventDefault();
        cancel();
      }
      if (e.key === "F10") {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.status, cancel]);

  const running = state.status === "running";
  const colsRef = useRef<HTMLDivElement>(null);
  const layout = usePanelLayout({});
  const drag = useGutterDrag(colsRef, layout.setGutter);

  // Global keys (§11): Tab swaps focus, ⌃←/→ resizes, ⌃B collapses, Esc cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = (e.target as HTMLElement | null)?.tagName === "TEXTAREA";

      if (e.key === "Escape" && state.status === "running") {
        e.preventDefault();
        cancel();
        return;
      }
      // Tab swaps panels, but must still indent inside the prompt.
      if (e.key === "Tab" && !typing) {
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
      if (e.key === "F10") e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.status, cancel, layout]);

  const colsClass = [
    "cols",
    layout.collapsed === "left" ? "collapsed-left" : "",
    layout.collapsed === "right" ? "collapsed-right" : "",
  ].filter(Boolean).join(" ");

  const chat = (
    <>
      <div className="t">chat{sessionName(state) ? ` · ${sessionName(state)}` : ""}</div>
      <div className="tr">
        {running ? <span className="amber">running</span>
          : `${state.sessions.length} session${state.sessions.length === 1 ? "" : "s"}`}
      </div>
      <Chat rows={state.rows} running={running} />
      <Prompt onSend={send} running={running} queued={state.queued} focused={layout.focus === "left"} />
    </>
  );

  return (
    <div className="screen" style={{ ["--gutter" as string]: String(layout.gutter) }}>
      <TopLine state={state} />
      <div className={colsClass} ref={colsRef}>
        <Panel side="left" focus={layout.focus} collapsed={layout.collapsed} onFocus={layout.setFocus}>
          {chat}
        </Panel>
        <div
          className={drag.dragging ? "gutter dragging" : "gutter"}
          onPointerDown={drag.onPointerDown}
          title="drag, or ⌃← / ⌃→"
        />
        <Panel side="right" focus={layout.focus} collapsed={layout.collapsed} onFocus={layout.setFocus}>
          <div className="t">panel</div>
          <div className="body dim empty">files view · M1 step 3</div>
        </Panel>
      </div>
      <StatusLine state={state} layout={layout} />
      <FKeys focus={layout.focus} />
    </div>
  );
}

function Panel({
  side, focus, collapsed, onFocus, children,
}: {
  side: PanelSide;
  focus: PanelSide;
  collapsed: PanelSide | null;
  onFocus: (s: PanelSide) => void;
  children: React.ReactNode;
}): JSX.Element {
  const cls = [
    "blk",
    focus === side ? "focus" : "",
    collapsed === side ? "hidden" : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={cls} onMouseDown={() => onFocus(side)}>
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
  onSend, running, queued, focused,
}: { onSend: (text: string) => void; running: boolean; queued?: string; focused: boolean }): JSX.Element {
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
      if (!trimmed) return;
      onSend(trimmed);
      setText("");
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

/** §11: the F-bar is context-relative — it shows what the keys do *here*.
 *  `live` marks a key that is actually wired; the rest are dim until their step lands. */
const CHAT_KEYS: [string, string, boolean][] = [
  ["F1", "help", false],
  ["F2", "+ attach", false],
  ["F3", "sessions", false],
  ["F4", "system", false],
  ["F5", "options", false],
  ["F6", "compact", false],
  ["F7", "rewind", false],
  ["F8", "clear", false],
  ["F9", "open ▸", false],
  ["F10", "quit", false],
];

const FILES_KEYS: [string, string, boolean][] = [
  ["F1", "help", false],
  ["F2", "menu", false],
  ["F3", "view", false],
  ["F4", "edit", false],
  ["F5", "copy", false],
  ["F6", "move", false],
  ["F7", "mkdir", false],
  ["F8", "delete", false],
  ["F9", "upload", false],
  ["F10", "quit", false],
];

function FKeys({ focus }: { focus: PanelSide }): JSX.Element {
  const keys = focus === "left" ? CHAT_KEYS : FILES_KEYS;
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
