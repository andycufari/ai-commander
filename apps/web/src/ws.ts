import { randomUUID } from "./id.js";
import type { Config, Event, Group, Intent, SessionMeta } from "@aicommander/protocol";

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

    case "session.events":
      // Replaces the transcript wholesale, which also clears any optimistic echoes.
      return { ...state, sessionId: event.sessionId, rows: groupsToRows(event.groups) };

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
  close: () => void;
}

export function connect(onEvent: (e: Event) => void, onOpen: () => void, onClose: () => void): Connection {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  let socket = new WebSocket(url);
  let closed = false;
  let retry = 500;

  const wire = (ws: WebSocket): void => {
    ws.onopen = () => {
      retry = 500;
      onOpen();
    };
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data as string) as Event);
      } catch {
        // a frame we cannot read is not worth tearing the session down for
      }
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

  return {
    send: (intent: IntentInput) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ id: randomUUID(), ...intent }));
      }
    },
    close: () => {
      closed = true;
      socket.close();
    },
  };
}
