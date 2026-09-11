import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Event, PanelSide, Tab } from "@aicommander/protocol";
import { connect, echoUser, initialState, reduce, type ChatRow, type Connection, type UiState } from "./ws.js";
import { GUTTER_STEP, useGutterDrag, usePanelLayout } from "./panels.js";
import { usePanelTabs, type PanelTabs } from "./tabs.js";
import { BINDINGS, barFor, hasMod, resolve, resolveLeader, type Binding } from "./keys.js";
import { FilesView } from "./FilesView.js";
import { Editor } from "./Editor.js";
import { ImageViewer } from "./ImageViewer.js";
import { defaultRegistry } from "./viewers.js";
import { addChips, fileAttachment, removeChip, type Chip } from "./chips.js";
import { linkifyMentions } from "./mentions.js";
import { Pick, defaultFilter, type PickItem } from "./Pick.js";
import { Modal, type ModalButton } from "./Modal.js";
import { LogView, jobStatus } from "./LogView.js";
import { Navigator, type NavAction } from "./Navigator.js";
import { modalOpen, unlessModal, useModalLock } from "./modal-stack.js";
import { toPatch, toRuntimeTabs } from "./restore.js";
import type { Attachment } from "@aicommander/protocol";

/** The input shape of a modal (v2 "the other three shapes"): one field, ⏎ submits. */
function AskInput({
  question, onSubmit,
}: { question: string; onSubmit: (text: string) => void }): JSX.Element {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useModalLock();
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="modal-scrim">
      <div className="modal info" role="dialog" aria-label={question}>
        <span className="t">tell it something</span>
        <div className="modal-body">{question}</div>
        <textarea
          ref={ref}
          className="modal-edit info"
          rows={2}
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (text.trim()) onSubmit(text.trim());
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onSubmit("continue");
            }
          }}
        />
        <div className="k">⏎ send · Esc continue anyway</div>
      </div>
    </div>
  );
}

/**
 * v2 §1: the safe option is always the one Esc maps to, and a danger modal has no
 * Enter default — someone has to choose.
 */
function permissionButtons(tier: "info" | "warning" | "danger"): ModalButton[] {
  if (tier === "danger") {
    return [
      { id: "once", label: "allow once", letter: "a" },
      { id: "session", label: "allow for this session", letter: "s" },
      { id: "deny", label: "deny", letter: "d", isSafe: true },
    ];
  }
  if (tier === "warning") {
    return [
      { id: "deny", label: "deny", letter: "d", isDefault: true, isSafe: true },
      { id: "once", label: "allow once", letter: "a" },
      { id: "session", label: "allow for this session", letter: "s" },
    ];
  }
  return [
    { id: "once", label: "allow", letter: "a", isDefault: true },
    { id: "session", label: "always in this session", letter: "s" },
    { id: "deny", label: "deny", letter: "d", isSafe: true },
  ];
}

/** §11 slash commands. Anything needing M2/M3 machinery says so rather than
 *  silently doing nothing. */
const COMMANDS: { name: string; detail: string }[] = [
  { name: "clear", detail: "empty this session" },
  { name: "compact", detail: "summarise the older turns" },
  { name: "new", detail: "new session" },
  { name: "model", detail: "brain and endpoint" },
  { name: "files", detail: "open a file" },
  { name: "touched", detail: "files this session touched" },
  { name: "help", detail: "every key" },
  { name: "rewind", detail: "M2" },
];

/** The shell: top line, two tabbed panels with a draggable gutter, status line,
 *  and a context-relative F-bar. The files view lands in the next M1 step. */

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(
    (
      s: UiState,
      e: Event | { type: "__conn"; connected: boolean } | { type: "__echo"; text: string }
        | { type: "__answered" },
    ): UiState => {
      if (e.type === "__conn") return { ...s, connected: e.connected };
      if (e.type === "__echo") return echoUser(s, e.text);
      if (e.type === "__answered") return { ...s, permission: undefined, ask: undefined };
      return reduce(s, e);
    },
    initialState,
  );
  const conn = useRef<Connection>();

  /** Handlers that the socket callback needs but that change every render. */
  const live = useRef<{
    onShowFiles: (e: Extract<Event, { type: "show_files" }>) => void;
    onJobStart: (e: Extract<Event, { type: "job.start" }>) => void;
  }>();

  useEffect(() => {
    const c = connect(
      (e) => {
        if (e.type === "show_files") live.current?.onShowFiles(e);
      if (e.type === "job.start") live.current?.onJobStart(e);
        dispatch(e);
      },
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
  const layout = usePanelLayout({
    gutter: state.workspace?.gutter,
    focus: state.workspace?.focus,
    collapsed: state.workspace?.collapsed ?? null,
  });
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const drag = useGutterDrag(colsRef, layout.setGutter);

  // Each panel is a tabbed view host (§10). The chat tab is always there to start.
  const left = usePanelTabs([
    { id: "chat", view: "chat", title: "chat", dirty: false, conflict: false, missing: false },
  ], "chat");
  const right = usePanelTabs([]);
  const focused = layout.focus === "left" ? left : right;

  // Restore the saved tabs once, as soon as the workspace lands (v2 §4).
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !state.workspace) return;
    restored.current = true;
    const { panels } = state.workspace;
    if (panels.left.tabs.length > 0) {
      const r = toRuntimeTabs(panels.left);
      left.replaceAll(r.tabs, r.activeId);
    }
    if (panels.right.tabs.length > 0) {
      const r = toRuntimeTabs(panels.right);
      right.replaceAll(r.tabs, r.activeId);
    }
    if (state.workspace.promptDraft) setDraft(state.workspace.promptDraft);
    if (state.workspace.marked.length) setMarked(state.workspace.marked);
  }, [state.workspace, left, right]);

  // Toasts: bottom-right, 4s, stack 3 (§10).
  const [toasts, setToasts] = useState<{ id: number; level: "info" | "warning"; text: string }[]>([]);
  const toast = useCallback((level: "info" | "warning", text: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-2), { id, level, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  /** Lifted so workspace.json can hold them (v2 §4: closing mid-thought loses nothing). */
  const [draft, setDraft] = useState("");
  const [marked, setMarked] = useState<string[]>([]);

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

  /**
   * Where a file should open.
   *
   * Not "the panel you are not focused on" — that rule put files on top of the chat
   * whenever the user was working in the other panel. A file goes to the panel whose
   * *active tab is not a chat*, so a conversation is never buried by something the
   * brain wanted to show. Only when both sides are showing chats does it fall back to
   * the side away from focus.
   */
  const targetSideFor = useCallback((prefer?: PanelSide): PanelSide => {
    if (prefer) return prefer;
    const leftIsChat = left.active?.view === "chat";
    const rightIsChat = right.active?.view === "chat";
    if (leftIsChat && !rightIsChat) return "right";
    if (rightIsChat && !leftIsChat) return "left";
    if (leftIsChat && rightIsChat) return layoutRef.current.focus === "left" ? "right" : "left";
    // Neither side holds a chat: reuse whichever already has this kind of thing open,
    // which in practice means the panel the user has been reading in.
    return right.tabs.length >= left.tabs.length ? "right" : "left";
  }, [left, right]);

  /**
   * Open a file — the single code path for ⏎ in the files view, a mention click, a
   * pick, and the brain's show_files (§5). Never moves focus, and activates an existing
   * tab for the same path rather than opening a second one.
   */
  const openFile = useCallback((
    path: string,
    opts: { mode?: "view" | "edit"; side?: PanelSide } = {},
  ): { outcome: "opened" | "already-open"; side: PanelSide; view: string } => {
    const entry = defaultRegistry.resolve(path);
    // mode "edit" overrides the registry's choice of a rendered view (§5).
    const view = opts.mode === "edit" ? "editor" : entry.view;
    const side = targetSideFor(opts.side);
    const target = side === "left" ? left : right;

    const existing = target.tabs.find((t) => t.path === path && t.view === view);
    if (existing) {
      target.select(existing.id);
      return { outcome: "already-open", side, view };
    }
    target.open({
      view,
      title: path.split("/").pop() ?? path,
      path,
      viewer: entry.name,
      mode: opts.mode ?? entry.mode,
    });
    return { outcome: "opened", side, view };
  }, [left, right, targetSideFor]);

  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;

  /**
   * The socket is opened once on mount, so its callback would capture the first
   * render's `openFile` forever. Routing through a ref that every render refreshes
   * keeps the handler current without re-subscribing the socket.
   */
  live.current = {
    // Guard 4: a shell call that became a job gets its own log tab, in the panel the
    // user is not reading — the same rule as show_files.
    onJobStart: (e) => {
      const side = targetSideFor();
      const host = side === "left" ? left : right;
      host.open({ view: "log", title: `job ${e.jobId}`, jobId: e.jobId });
    },
    onShowFiles: (e) => {
      // `target` names where the files should land, but openFile opens *away* from the
      // side it is given — so pass the opposite. "other" means away from focus.
      const side = e.target === "other" ? undefined : e.target;
      // Opened in order, so the last path ends up active — the brain's final argument
      // is the one it most wants seen.
      const results = e.paths.map((path) => {
        const r = openFile(path, { side });
        return { path, outcome: r.outcome, view: r.view };
      });
      // Tell the loop what actually happened, so its tool result is truthful (§5).
      if (e.requestId) {
        conn.current?.send({
          type: "files.shown",
          requestId: e.requestId,
          results,
          side: results[0]?.outcome ? targetSideFor(side) : undefined,
        });
      }
    },
  };

  // Push the layout to the backend whenever it changes. The backend debounces to
  // 300ms, so this may fire on every keystroke of the draft without hitting disk.
  useEffect(() => {
    if (!restored.current) return;
    conn.current?.send({
      type: "workspace.set",
      patch: toPatch({
        gutter: layout.gutter,
        focus: layout.focus,
        collapsed: layout.collapsed,
        left: { tabs: left.tabs, activeId: left.activeId },
        right: { tabs: right.tabs, activeId: right.activeId },
        marked,
        promptDraft: draft,
      }),
    });
  }, [
    layout.gutter, layout.focus, layout.collapsed,
    left.tabs, left.activeId, right.tabs, right.activeId,
    marked, draft,
  ]);

  /** The session navigator (§10), and a pending job kill confirmation. */
  const [navOpen, setNavOpen] = useState(false);
  const [killJob, setKillJob] = useState<string | undefined>();
  /** Groups whose truncate is waiting on a warning modal. */
  const [confirmTruncate, setConfirmTruncate] = useState<string | undefined>();

  const runNav = useCallback((action: NavAction, groupId: string) => {
    const sessionId = state.sessionId;
    if (!sessionId) return;
    switch (action) {
      case "fork":
        conn.current?.send({ type: "session.rewind", sessionId, groupId, mode: "fork" });
        setNavOpen(false);
        return;
      case "truncate":
        // Reversible only by the snapshot it just took, so it asks first.
        setConfirmTruncate(groupId);
        return;
      case "drop":
        conn.current?.send({ type: "session.dropGroup", sessionId, groupId });
        return;
      case "dropOutputs":
        conn.current?.send({ type: "session.dropToolOutput", sessionId, groupId });
        return;
      case "compact":
        conn.current?.send({ type: "session.compact", sessionId });
        setNavOpen(false);
        return;
      default:
        return;
    }
  }, [state.sessionId]);

  /** Which pick modal is open, if any (§11). */
  const [pick, setPick] = useState<
    "menu" | "files" | "touched" | "sessions" | "settings" | "folders" | "help" | null
  >(null);
  const [tree, setTree] = useState<string[]>([]);

  /** The file list backs both ⌘P and @ completion; load it as soon as we connect. */
  const loadTree = useCallback(() => {
    conn.current?.request({ type: "fs.tree", limit: 5000 }, "fs.tree")
      .then((e) => setTree((e as { paths: string[] }).paths))
      .catch(() => setTree([]));
  }, []);

  const newSession = useCallback(() => {
    conn.current?.send({ type: "session.create" });
  }, []);

  useEffect(() => {
    if (state.connected) loadTree();
  }, [state.connected, loadTree]);

  /** Open a picked file: ⏎ here (the focused panel), ⌘⏎ the other one (§11). */
  const openPicked = useCallback((path: string, other: boolean) => {
    const focus = layoutRef.current.focus;
    const side = other ? (focus === "left" ? "right" : "left") : focus;
    openFileRef.current(path, { side });
    setPick(null);
  }, []);

  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  /** Folder list for ⌘O (§10 open folder). */
  const [folders, setFolders] = useState<{ path: string; recent: boolean }[]>([]);
  const loadFolders = useCallback(() => {
    conn.current?.request({ type: "folders.list" }, "folders.listed")
      .then((e) => setFolders((e as unknown as { folders: { path: string; recent: boolean }[] }).folders))
      .catch(() => setFolders([]));
  }, []);

  /**
   * Slash commands and their keyboard equivalents (§11). Everything that needs the
   * context assembler or the permission engine is M2/M3; those say so rather than
   * silently doing nothing, which is worse than an honest "not yet".
   */
  const runCommand = useCallback((id: string, arg?: string): void => {
    const sessionId = state.sessionId;
    switch (id) {
      case "clear":
        if (sessionId) conn.current?.send({ type: "session.clear", sessionId });
        return;
      case "new":
      case "newSession":
        newSession();
        return;
      case "model":
      case "settings":
        setPick("settings");
        return;
      case "help":
        setPick("help");
        return;
      case "files":
        loadTree();
        setPick("files");
        return;
      case "touched":
        setPick("touched");
        return;
      case "compact":
        if (sessionId) conn.current?.send({ type: "session.compact", sessionId });
        return;
      case "attach":
        toast("info", "the + picker arrives in M3 — use @ in the prompt, or ⌘P");
        return;
      case "rewind":
        setNavOpen(true);
        return;
      default:
        toast("warning", `unknown command: /${id}`);
    }
  }, [state.sessionId, newSession, loadTree, toast]);

  /** ⌘K leader: the next key picks an action (§11). */
  const [leaderArmed, setLeaderArmed] = useState(false);
  /** When Esc was last pressed, for the Esc Esc chord. */
  const lastEscape = useRef(0);

  const runAction = useCallback((id: string) => {
    switch (id) {
      case "help": setPick("help"); return;
      case "menu": setPick("menu"); return;
      case "file": loadTree(); setPick("files"); return;
      case "touched": setPick("touched"); return;
      case "sessions": setPick("sessions"); return;
      case "settings": setPick("settings"); return;
      case "openFolder": loadFolders(); setPick("folders"); return;
      case "newSession": newSession(); return;
      case "newTab": focusedRef.current.open({ view: "files", title: "files", path: "." }); return;
      case "closeTab": {
        const host = focusedRef.current;
        if (host.activeId) host.close(host.activeId);
        return;
      }
      case "collapse": layoutRef.current.toggleCollapse(); return;
      case "maximize": layoutRef.current.toggleMaximize(layoutRef.current.focus); return;
      case "attach":
      case "compact":
      case "clear":
      case "rewind":
        setNavOpen(true);
        return;
      default:
        return;
    }
  }, [loadTree, newSession]);

  const runActionRef = useRef(runAction);
  runActionRef.current = runAction;

  // Global keys (§11). Chords are ⌘-based; see keys.ts for why not F-keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // A modal owns the keyboard while it is up (modal-stack.ts). React's
      // stopPropagation cannot hold back a native window listener, so the rule is
      // enforced from the shared stack rather than by each handler remembering it.
      if (modalOpen()) return;

      if (e.key === "Escape") {
        if (leaderArmed) { setLeaderArmed(false); return; }
        if (state.status === "running") { e.preventDefault(); cancel(); return; }
        // Esc Esc on an idle session opens the navigator (§10).
        const now = Date.now();
        if (now - lastEscape.current < 500) {
          e.preventDefault();
          setNavOpen(true);
          lastEscape.current = 0;
        } else {
          lastEscape.current = now;
        }
        return;
      }

      // Second key of a ⌘K chord.
      if (leaderArmed) {
        e.preventDefault();
        setLeaderArmed(false);
        const binding = resolveLeader(e.key);
        if (binding) runActionRef.current(binding.id);
        return;
      }

      // Tab always swaps panels, including from the prompt — ⇧⏎ takes newlines.
      if (e.key === "Tab" && !hasMod(e)) {
        e.preventDefault();
        layout.swapFocus();
        return;
      }
      if (hasMod(e) && e.key === "Tab") {
        e.preventDefault();
        focusedRef.current.cycle(e.shiftKey ? -1 : 1);
        return;
      }
      if (hasMod(e) && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        layout.setGutter((g) => g + (e.key === "ArrowRight" ? GUTTER_STEP : -GUTTER_STEP));
        return;
      }
      if (hasMod(e) && (e.key === "1" || e.key === "2")) {
        e.preventDefault();
        layout.setFocus(e.key === "1" ? "left" : "right");
        return;
      }

      const binding = resolve(e);
      if (!binding) return;
      e.preventDefault();
      if (binding.id === "menu") {
        // ⌘K is both the menu and the leader: arm it, and open the menu if the next
        // key is not one of its own.
        setLeaderArmed(true);
        return;
      }
      runActionRef.current(binding.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.status, cancel, layout, leaderArmed]);

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
            <Chat rows={state.rows} running={running} onOpen={(p) => openFile(p)} />
            <Prompt
              onSend={send} running={running} queued={state.queued}
              focused={layout.focus === side}
              chips={chips}
              onRemoveChip={(key) => setChips((prev) => removeChip(prev, key))}
              text={draft}
              onTextChange={setDraft}
              files={tree}
              onAttach={(path) => mention([fileAttachment(path)])}
              onCommand={runCommand}
            />
          </>
        );
      case "editor":
        return (
          <Editor
            conn={conn.current}
            path={tab.path ?? ""}
            focused={layout.focus === side}
            revision={state.fileRevisions[tab.path ?? ""] ?? 0}
            onMissing={(m) => (side === "left" ? left : right).update(tab.id, { missing: m })}
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
            revision={state.fileRevisions[tab.path ?? ""] ?? 0}
            onEscape={focusChat}
          />
        );
      case "log":
        return (
          <LogView
            job={tab.jobId ? state.jobs[tab.jobId] : undefined}
            focused={layout.focus === side}
            onKill={(jobId) => setKillJob(jobId)}
            onEscape={focusChat}
          />
        );
      case "files":
        return (
          <FilesView
            conn={conn.current}
            path={tab.path ?? "."}
            focused={layout.focus === side}
            revision={state.revision}
            marked={marked}
            onMarkedChange={setMarked}
            onNavigate={(next) => {
              const host = side === "left" ? left : right;
              host.update(tab.id, { path: next, title: next === "." ? "files" : next.split("/").pop()! });
            }}
            onOpen={(p) => openFile(p)}
            onMention={mention}
          />
        );
      default:
        return <div className="body empty">no view</div>;
    }
  };

  const panelExtra = (tab: Tab | undefined): React.ReactNode => {
    if (tab?.view === "log") {
      const job = tab.jobId ? state.jobs[tab.jobId] : undefined;
      return <span className={job?.running ? "amber" : undefined}>{jobStatus(job)}</span>;
    }
    if (tab?.view !== "chat") return null;
    return running
      ? <span className="amber">running</span>
      : `${state.sessions.length} session${state.sessions.length === 1 ? "" : "s"}`;
  };

  // v2 §4: restore exactly where you were. Painting the default layout first and
  // correcting it a frame later is the flash this avoids.
  if (!state.workspace) {
    return <div className="screen booting" />;
  }

  return (
    <div className="screen" style={{ ["--gutter" as string]: String(layout.gutter) }}>
      <TopLine state={state} onModelClick={() => setPick("settings")} />
      <div className={colsClass} ref={colsRef}>
        <Panel
          side="left" focus={layout.focus} collapsed={layout.collapsed}
          onFocus={layout.setFocus} tabs={left}
          titleSuffix={left.active?.view === "chat" ? sessionName(state) : undefined}
          extra={panelExtra(left.active)}
          maximized={layout.maximized === "left"}
          onMaximize={layout.toggleMaximize}
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
          maximized={layout.maximized === "right"}
          onMaximize={layout.toggleMaximize}
        >
          {renderView(right.active, "right")}
        </Panel>
      </div>
      <StatusLine state={state} layout={layout} />
      <FKeys bindings={barFor(focused.active?.view)} onRun={runAction} />
      {pick === "menu" && (
        <Pick
          title="open"
          hint="⏎ choose · Esc close"
          items={[
            { id: "new-session", label: "new session", detail: "⌃N", group: "session" },
            ...(state.sessions.length > 1
              ? [{ id: "sessions", label: "existing session…", detail: `${state.sessions.length}`, group: "session" }]
              : []),
            { id: "files", label: "files", detail: "browse the repo", group: "open" },
            { id: "file", label: "file…", detail: "⌃P", group: "open" },
            { id: "touched", label: "files this session touched", detail: "⌃⇧P", group: "open" },
          ]}
          onChoose={(item) => {
            switch (item.id) {
              case "new-session": newSession(); setPick(null); return;
              case "sessions": setPick("sessions"); return;
              case "files":
                focused.open({ view: "files", title: "files", path: "." });
                setPick(null);
                return;
              case "file": loadTree(); setPick("files"); return;
              case "touched": setPick("touched"); return;
              default: setPick(null);
            }
          }}
          onClose={() => setPick(null)}
        />
      )}
      {pick === "files" && (
        <Pick
          title="open file"
          placeholder="fuzzy filter"
          hint="⏎ here · ⌃⏎ other panel · Esc close"
          items={tree.map((path) => ({ id: path, label: path }))}
          onChoose={(item, alt) => openPicked(item.id, alt)}
          onClose={() => setPick(null)}
        />
      )}
      {pick === "touched" && (
        <Pick
          title={`files this session touched`}
          placeholder="filter"
          hint="⏎ here · ⌃⏎ other panel · Esc close"
          items={state.touched.map((t) => ({
            id: t.path,
            label: t.path,
            detail: t.kind === "written" ? "written" : t.kind,
            group: t.kind === "written" ? "changed" : "seen",
          }))}
          onChoose={(item, alt) => openPicked(item.id, alt)}
          onClose={() => setPick(null)}
        />
      )}
      {pick === "sessions" && (
        <Pick
          title="session"
          placeholder="filter"
          hint="⏎ open · Esc close"
          items={state.sessions.map((m) => ({
            id: m.id,
            label: m.name,
            detail: m.id === state.sessionId ? "current" : m.model,
          }))}
          onChoose={(item) => {
            conn.current?.send({ type: "session.open", sessionId: item.id });
            setPick(null);
          }}
          onClose={() => setPick(null)}
        />
      )}
      {state.permission && (
        <Modal
          tier={state.permission.level}
          title={state.permission.level === "danger" ? "danger" : state.permission.level === "warning" ? "warning" : "allow?"}
          editable={state.permission.tool === "shell" ? state.permission.command : undefined}
          buttons={permissionButtons(state.permission.level)}
          onChoose={(id, edited) => {
            const requestId = state.permission!.requestId;
            conn.current?.send({
              type: "permission.answer",
              requestId,
              answer: id === "session" ? "session" : id === "deny" ? "deny" : "once",
              ...(edited !== undefined ? { editedCommand: edited } : {}),
            });
            dispatch({ type: "__answered" });
          }}
        >
          <span className="modal-reason">{state.permission.reason}</span>
          <code className="modal-command">{state.permission.command}</code>
          <span className="modal-reason">
            {state.permission.tool}
            {state.permission.rule.startsWith("ask-") ? "" : ` · rule ${state.permission.rule}`}
          </span>
        </Modal>
      )}
      {navOpen && (
        <Navigator
          groups={state.groups}
          snapshots={new Set(state.snapshots)}
          onAction={runNav}
          onClose={() => setNavOpen(false)}
        />
      )}
      {confirmTruncate && (
        <Modal
          tier="warning"
          title="truncate"
          buttons={[
            { id: "cancel", label: "cancel", letter: "c", isDefault: true, isSafe: true },
            { id: "truncate", label: "truncate here", letter: "t" },
          ]}
          onChoose={(id) => {
            if (id === "truncate" && state.sessionId) {
              conn.current?.send({
                type: "session.rewind", sessionId: state.sessionId,
                groupId: confirmTruncate, mode: "truncate",
              });
              setNavOpen(false);
            }
            setConfirmTruncate(undefined);
          }}
        >
          {`Everything after this turn is removed from the session, and the files are restored to how they were. `}
          {`The turns after it cannot be brought back.`}
        </Modal>
      )}
      {killJob && (
        <Modal
          tier="warning"
          title="kill job"
          buttons={[
            { id: "cancel", label: "cancel", letter: "c", isDefault: true, isSafe: true },
            { id: "kill", label: "kill it", letter: "k" },
          ]}
          onChoose={(id) => {
            if (id === "kill") conn.current?.send({ type: "job.kill", jobId: killJob });
            setKillJob(undefined);
          }}
        >
          {`Stop ${state.jobs[killJob]?.cmd ?? "this job"}? `}
          {`It gets SIGTERM, then SIGKILL after five seconds. You can run it again.`}
        </Modal>
      )}
      {state.ask && (
        state.ask.options.length === 1 && state.ask.options[0] === "__input" ? (
          // "tell it something" — a guard pause asking for free text (§6).
          <AskInput
            question={state.ask.question}
            onSubmit={(text) => {
              conn.current?.send({ type: "ask.answer", requestId: state.ask!.requestId, choice: text });
              dispatch({ type: "__answered" });
            }}
          />
        ) : (
          <Modal
            tier="info"
            title="the loop is asking"
            buttons={state.ask.options.map((o, i) => ({
              id: o,
              label: o,
              letter: o[0] ?? String(i + 1),
              isDefault: i === 0,
              isSafe: o === "stop" || i === state.ask!.options.length - 1,
            }))}
            onChoose={(id) => {
              conn.current?.send({ type: "ask.answer", requestId: state.ask!.requestId, choice: id });
              dispatch({ type: "__answered" });
            }}
          >
            {state.ask.question}
          </Modal>
        )
      )}
      {pick === "folders" && (
        <Pick
          title="open folder"
          placeholder="filter"
          hint="⏎ open · Esc close"
          items={folders.map((f) => ({
            id: f.path,
            label: f.path.replace(/^\/Users\/[^/]+/, "~"),
            detail: f.recent ? "recent" : undefined,
            group: f.recent ? "recent" : "home",
          }))}
          onChoose={(item) => {
            // One repo per window (§10): opening a folder is a new backend.
            toast("info", `run: aicommander serve ${item.id}`);
            setPick(null);
          }}
          onClose={() => setPick(null)}
        />
      )}
      {pick === "settings" && (
        <Pick
          title="settings"
          placeholder="filter"
          hint="⏎ choose · Esc close"
          items={[
            {
              id: "brain",
              label: `brain · ${state.config?.brain.model ?? "?"}`,
              detail: state.config ? hostOf(state.config.brain.endpoint) : "",
              group: "model",
            },
            { id: "mode", label: `mode · ${state.config?.mode ?? "ask"}`, detail: "ask / auto / plan", group: "loop" },
            { id: "ctx", label: `context · ${fmtK(state.ctxMax)}`, detail: "from the endpoint", group: "loop" },
          ]}
          onChoose={() => {
            toast("info", "editing settings arrives with the options modal (M2)");
            setPick(null);
          }}
          onClose={() => setPick(null)}
        />
      )}
      {pick === "help" && (
        <Pick
          title="keys"
          placeholder="filter"
          hint="⏎ run · Esc close"
          items={BINDINGS.map((b) => ({ id: b.id, label: b.label, detail: b.hint }))}
          onChoose={(item) => { setPick(null); runAction(item.id); }}
          onClose={() => setPick(null)}
        />
      )}
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
  side, focus, collapsed, onFocus, tabs, titleSuffix, extra, maximized, onMaximize, children,
}: {
  side: PanelSide;
  focus: PanelSide;
  collapsed: PanelSide | null;
  onFocus: (s: PanelSide) => void;
  tabs: PanelTabs;
  titleSuffix?: string;
  extra?: React.ReactNode;
  maximized: boolean;
  onMaximize: (side: PanelSide) => void;
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
      <div className="tr">
        {extra}
        <i
          className="max"
          title={maximized ? "restore" : "maximize (⌘⇧Enter)"}
          onMouseDown={(e) => { e.stopPropagation(); onMaximize(side); }}
        >{maximized ? "▾" : "▴"}</i>
      </div>
      {tabs.tabs.length > 1 && (
        <div className="tabs">
          {tabs.tabs.map((t) => (
            <span
              key={t.id}
              className={`tab${t.id === tabs.activeId ? " on" : ""}${t.conflict ? " conflict" : ""}`}
              onMouseDown={(e) => { e.stopPropagation(); onFocus(side); tabs.select(t.id); }}
            >
              {t.title}{t.dirty ? " ●" : ""}{t.missing ? " (missing)" : ""}
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

function TopLine({
  state, onModelClick,
}: { state: UiState; onModelClick: () => void }): JSX.Element {
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
        {brain && (
          <span className="amber clickable" onClick={onModelClick} title="settings (⌘,)">
            {brain.model} @ {host}
          </span>
        )}
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

function Chat({
  rows, running, onOpen,
}: { rows: ChatRow[]; running: boolean; onOpen: (path: string) => void }): JSX.Element {
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
      {rows.map((r, i) => <Row key={r.callId ?? i} row={r} onOpen={onOpen} />)}
      {running && rows[rows.length - 1]?.kind !== "tool" && (
        <div className="b"><Spinner /> <span className="dim">thinking…</span></div>
      )}
    </div>
  );
}

function Row({ row, onOpen }: { row: ChatRow; onOpen: (path: string) => void }): JSX.Element {
  if (row.kind === "tool") {
    const cls = row.ok === false ? "tool err" : "tool";
    return (
      <div className={cls}>
        {row.running && <><Spinner /> </>}
        {row.name}{" "}
        {row.path
          ? <i><Mention path={row.path} label={row.args ?? row.path} onOpen={onOpen} /></i>
          : <i>{row.args}</i>}
        {row.summary ? `  ${row.summary}` : row.running ? " …" : ""}
      </div>
    );
  }
  return (
    <div className={row.kind === "user" ? "u" : "b"}>
      {linkifyMentions(row.text).map((seg, i) =>
        seg.path
          ? <Mention key={i} path={seg.path} label={seg.text} onOpen={onOpen} />
          : <span key={i}>{seg.text}</span>,
      )}
    </div>
  );
}

/**
 * Braille spinner. Driven by a frame counter rather than a CSS animation because the
 * glyph itself changes — the point is that a still frame reads as frozen, which is
 * exactly what it looked like before.
 */
function Spinner(): JSX.Element {
  const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return <span className="spin">{FRAMES[frame]}</span>;
}

/** A clickable path — the same code path as ⏎ in the files view. */
function Mention({
  path, label, onOpen,
}: { path: string; label: string; onOpen: (path: string) => void }): JSX.Element {
  return (
    <span
      className="m"
      role="link"
      tabIndex={0}
      title={`open ${path}`}
      onClick={() => onOpen(path)}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(path); }}
    >
      {label}
    </span>
  );
}

function Prompt({
  onSend, running, queued, focused, chips, onRemoveChip, text, onTextChange,
  files, onAttach, onCommand,
}: {
  onSend: (text: string, attachments: Attachment[]) => void;
  running: boolean;
  queued?: string;
  focused: boolean;
  chips: Chip[];
  onRemoveChip: (key: string) => void;
  /** Lifted to the app so workspace.json can hold the draft (v2 §4). */
  text: string;
  onTextChange: (text: string) => void;
  /** Repo files, for @ completion. */
  files: string[];
  /** @ picked a file: it becomes a chip. */
  onAttach: (path: string) => void;
  /** A /command was entered. */
  onCommand: (name: string, arg?: string) => void;
}): JSX.Element {
  const setText = onTextChange;
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the text up to 40% of the panel, then scroll (§10).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const max = Math.round(window.innerHeight * 0.4);
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [text]);

  // Take the caret whenever this panel becomes focused, so switching panels or tabs
  // lands you ready to type instead of needing a click.
  useEffect(() => {
    if (focused) ref.current?.focus();
    else ref.current?.blur();
  }, [focused]);

  /** The @path or /command being typed right now, for the inline completer. */
  const trailing = /(^|\s)([@/])([\w./-]*)$/.exec(text);
  const completing = trailing
    ? { sigil: trailing[2]! as "@" | "/", query: trailing[3] ?? "" }
    : undefined;

  const suggestions = useMemo(() => {
    if (!completing) return [];
    if (completing.sigil === "/") {
      return COMMANDS
        .filter((c) => c.name.startsWith(completing.query.toLowerCase()))
        .slice(0, 8)
        .map((c) => ({ value: c.name, detail: c.detail }));
    }
    return defaultFilter(files.map((f) => ({ id: f, label: f })), completing.query)
      .slice(0, 8)
      .map((f) => ({ value: f.label, detail: "" }));
  }, [completing?.sigil, completing?.query, files]);

  const [suggestion, setSuggestion] = useState(0);
  useEffect(() => { setSuggestion(0); }, [text]);

  const applySuggestion = (value: string): void => {
    if (!trailing) return;
    const before = text.slice(0, text.length - (trailing[2]!.length + (trailing[3] ?? "").length));
    if (completing?.sigil === "@") {
      // A file becomes a chip, not text — the same shape the picker produces (§7).
      onAttach(value);
      setText(before);
    } else {
      setText(`${before}/${value} `);
    }
  };

  const onKeyDown = unlessModal((e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Inline completion for @path and /command.
    if (suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSuggestion((i) => Math.min(suggestions.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSuggestion((i) => Math.max(0, i - 1));
        return;
      }
      // Tab always completes. Enter completes only while the typed text is still a
      // prefix of something — once it names a command exactly, Enter runs it, so
      // "/clear" does not need a second Enter to get past its own suggestion.
      const exact = completing?.sigil === "/"
        && suggestions.some((sg) => sg.value === completing.query.toLowerCase());
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !exact)) {
        e.preventDefault();
        applySuggestion(suggestions[suggestion]!.value);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const trimmed = text.trim();
      // Attachments alone are not a turn; the model needs something to do with them.
      if (!trimmed) return;
      // A line that is only a slash command runs here rather than going to the brain.
      const command = /^\/(\w+)\s*(.*)$/.exec(trimmed);
      if (command && COMMANDS.some((c) => c.name === command[1]!.toLowerCase())) {
        onCommand(command[1]!.toLowerCase(), command[2]);
        setText("");
        return;
      }
      onSend(trimmed, chips.map((c) => c.attachment));
      setText("");
    }
    // Backspace at the very start removes the last chip, the way a mail client does.
    if (e.key === "Backspace" && text === "" && chips.length > 0) {
      e.preventDefault();
      onRemoveChip(chips[chips.length - 1]!.key);
    }
  });

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
      {suggestions.length > 0 && (
        <div className="suggest">
          {suggestions.map((sug, i) => (
            <div
              key={sug.value}
              className={i === suggestion ? "suggest-row sel" : "suggest-row"}
              onMouseMove={() => setSuggestion(i)}
              onMouseDown={(e) => { e.preventDefault(); applySuggestion(sug.value); }}
            >
              <span>{completing?.sigil}{sug.value}</span>
              {sug.detail && <span className="dim">{sug.detail}</span>}
            </div>
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

/** Compact sizes for the status line, matching the files view's style. */
function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}k`;
  return `${bytes}b`;
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
        {state.lastSnapshot && (
          <span title="the snapshot taken before the last turn">
            snap {fmtBytes(state.lastSnapshot.bytes)} · {state.lastSnapshot.ms}ms
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The bar along the bottom (§11) — still the mockup's shape, but showing chords that
 * exist on every keyboard. Each entry is clickable, so the whole keymap is reachable
 * with a mouse too.
 */
function FKeys({
  bindings, onRun,
}: { bindings: Binding[]; onRun: (id: string) => void }): JSX.Element {
  return (
    <div className="fkeys">
      {bindings.map((b) => (
        <span key={b.id} className="fkey" onClick={() => onRun(b.id)} title={b.hint}>
          <b>{b.hint}</b>
          <span className="ctx">{b.label}</span>
        </span>
      ))}
    </div>
  );
}
