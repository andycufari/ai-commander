import { randomUUID } from "./id.js";
import { toolPath } from "./mentions.js";
import type {
  Config, Event, Group, Intent, SessionMeta, TouchedFile, Workspace,
} from "@aicommander/protocol";

/**
 * The browser only renders and sends intents (§2) — all state lives in the backend,
 * so this keeps just enough to draw the screen and rebuilds it from events on reconnect.
 */

export interface ChatRow {
  kind: "user" | "brain" | "tool";
  text: string;
  /** tool rows */
  callId?: string;
  name?: string;
  args?: string;
  summary?: string;
  ok?: boolean;
  running?: boolean;
  /** Set when the tool acts on a file, so the row links to it (§10). */
  path?: string;
}

export interface UiState {
  connected: boolean;
  config?: Config;
  /** Repo root, for the top line. */
  root?: string;
  sessions: SessionMeta[];
  /** False until session.list has arrived — an empty list before that means
   *  "not known yet", not "no sessions", and creating one on it duplicates. */
  sessionsLoaded: boolean;
  sessionId?: string;
  rows: ChatRow[];
  status: "idle" | "running" | "paused" | "cancelled";
  toolCount: number;
  elapsed: number;
  ctxUsed: number;
  ctxMax: number;
  queued?: string;
  git?: { branch: string; dirty: number; ahead: number };
  /** Files this session has touched, for ⌃⇧P (§11). Writes first, recent first. */
  touched: TouchedFile[];
  /** The restored layout. Until it arrives the app does not paint, so a saved
   *  layout never flashes the default one first (v2 §4). */
  workspace?: Workspace;
  /** Bumped by fs.changed, so the files view re-lists. */
  revision: number;
  /**
   * Per-path change counter. A view keyed on its own path's count reloads once per
   * change to *that* file — keying on the global revision instead would re-run on
   * every unrelated change, and flipping a prop back to 0 re-runs it a second time.
   */
  fileRevisions: Record<string, number>;
  error?: string;
}

export const initialState: UiState = {
  connected: false,
  sessions: [],
  sessionsLoaded: false,
  rows: [],
  status: "idle",
  toolCount: 0,
  elapsed: 0,
  ctxUsed: 0,
  ctxMax: 0,
  touched: [],
  revision: 0,
  fileRevisions: {},
};

/** Local echo: the backend's turn.start carries no text, so a sent message would not
 *  appear until the session was replayed. Show it immediately, as the user typed it. */
export function echoUser(state: UiState, text: string): UiState {
  return { ...state, rows: [...state.rows, { kind: "user", text }] };
}

export function reduce(state: UiState, event: Event): UiState {
  switch (event.type) {
    case "config":
      return { ...state, config: event.config, root: event.root, ctxMax: event.config.brain.ctx };

    case "session.list":
      return { ...state, sessions: event.sessions, sessionsLoaded: true };

    case "session.events": {
      // Sent on open *and* after every turn, to refresh the touched list. Replaying the
      // transcript on the post-turn refresh would drop the streamed tool rows, which the
      // groups do not carry — so rows are only rebuilt when the session actually changes.
      const sameSession = state.sessionId === event.sessionId;
      return {
        ...state,
        sessionId: event.sessionId,
        rows: sameSession && state.rows.length > 0 ? state.rows : groupsToRows(event.groups),
        touched: event.touched,
      };
    }

    case "session.state":
      return {
        ...state,
        status: event.status,
        toolCount: event.toolCount,
        elapsed: event.elapsed,
        ctxUsed: event.ctxUsed,
        ctxMax: event.ctxMax || state.ctxMax,
        queued: event.queued,
      };

    case "token": {
      const rows = [...state.rows];
      const last = rows[rows.length - 1];
      // Append to the open brain row, or start one.
      if (last?.kind === "brain") rows[rows.length - 1] = { ...last, text: last.text + event.delta };
      else rows.push({ kind: "brain", text: event.delta });
      return { ...state, rows };
    }

    case "tool.start":
      return {
        ...state,
        rows: [...state.rows, {
          kind: "tool",
          text: "",
          callId: event.callId,
          name: event.name,
          args: summarizeArgs(event.args),
          path: toolPath(event.name, event.args),
          running: true,
        }],
      };

    case "tool.end":
      return {
        ...state,
        rows: state.rows.map((r) =>
          r.callId === event.callId
            ? { ...r, running: false, ok: event.ok, summary: event.summary + (event.truncated ? " · truncated" : "") }
            : r,
        ),
      };

    case "workspace":
      return { ...state, workspace: event.workspace };

    case "fs.changed": {
      const fileRevisions = { ...state.fileRevisions };
      for (const p of event.paths) fileRevisions[p] = (fileRevisions[p] ?? 0) + 1;
      return { ...state, revision: state.revision + 1, fileRevisions };
    }

    case "git.changed":
      return { ...state, git: { branch: event.branch, dirty: event.dirty, ahead: event.ahead } };

    case "toast":
      return { ...state, error: event.level === "warning" ? event.text : state.error };

    case "error":
      return { ...state, error: event.message };

    default:
      return state;
  }
}

/** The args line under a tool call — the mockup shows the telling argument, not the object. */
export function summarizeArgs(args: Record<string, unknown>): string {
  const first = args.path ?? args.pattern ?? args.cmd ?? args.query ?? args.name ?? args.action;
  if (typeof first === "string") return first;
  const json = JSON.stringify(args);
  return json === "{}" ? "" : json.slice(0, 120);
}

function groupsToRows(groups: Group[]): ChatRow[] {
  const rows: ChatRow[] = [];
  for (const g of groups) {
    if (g.userText) rows.push({ kind: "user", text: g.userText });
    if (g.brainText) rows.push({ kind: "brain", text: g.brainText });
  }
  return rows;
}

/** Distributive, so each intent variant keeps its own fields — a plain
 *  Omit<Intent, "id"> would collapse the union and lose them. */
export type IntentInput = Intent extends infer T
  ? T extends { id: string }
    ? Omit<T, "id"> & { id?: string }
    : never
  : never;

export interface Connection {
  send: (intent: IntentInput) => void;
  /**
   * Send an intent and wait for the reply event that quotes its id (§3 reply events).
   * Directory listings and file reads are per-tab, not global state, so they are
   * awaited here rather than pushed through the app-wide reducer.
   */
  request: <T extends Event>(intent: IntentInput, replyType: T["type"], timeoutMs?: number) => Promise<T>;
  close: () => void;
}

export function connect(onEvent: (e: Event) => void, onOpen: () => void, onClose: () => void): Connection {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  let socket = new WebSocket(url);
  let closed = false;
  let retry = 500;

  /** Pending request() calls, keyed by the intent id they are waiting on. */
  const waiting = new Map<string, { type: string; resolve: (e: Event) => void; reject: (err: Error) => void }>();

  const wire = (ws: WebSocket): void => {
    ws.onopen = () => {
      retry = 500;
      onOpen();
    };
    ws.onmessage = (m) => {
      let event: Event;
      try {
        event = JSON.parse(m.data as string) as Event;
      } catch {
        // a frame we cannot read is not worth tearing the session down for
        return;
      }
      // A reply resolves its waiter; an error aimed at the same intent rejects it.
      const intentId = (event as { intentId?: string }).intentId;
      if (intentId) {
        const pending = waiting.get(intentId);
        if (pending) {
          waiting.delete(intentId);
          if (event.type === "error") pending.reject(new Error(event.message));
          else if (event.type === pending.type) pending.resolve(event);
          else pending.reject(new Error(`expected ${pending.type}, got ${event.type}`));
        }
      }
      onEvent(event);
    };
    ws.onclose = () => {
      onClose();
      if (closed) return;
      // The backend owns the session, so reconnecting restores it (§2).
      setTimeout(() => {
        socket = new WebSocket(url);
        wire(socket);
      }, retry);
      retry = Math.min(retry * 2, 5000);
    };
  };
  wire(socket);

  const send = (intent: IntentInput): string | undefined => {
    if (socket.readyState !== WebSocket.OPEN) return undefined;
    const id = (intent as { id?: string }).id ?? randomUUID();
    socket.send(JSON.stringify({ ...intent, id }));
    return id;
  };

  return {
    send: (intent) => void send(intent),
    request: <T extends Event>(intent: IntentInput, replyType: T["type"], timeoutMs = 8000) =>
      new Promise<T>((resolve, reject) => {
        const id = send(intent);
        if (!id) {
          reject(new Error("not connected"));
          return;
        }
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`${intent.type} timed out`));
        }, timeoutMs);
        waiting.set(id, {
          type: replyType,
          resolve: (e) => { clearTimeout(timer); resolve(e as T); },
          reject: (err) => { clearTimeout(timer); reject(err); },
        });
      }),
    close: () => {
      closed = true;
      socket.close();
    },
  };
}
