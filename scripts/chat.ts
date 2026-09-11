#!/usr/bin/env node
/**
 * Terminal WS client — drive a session before the web app exists (M0 item 3).
 *
 *   node scripts/chat.js [--port 7777] [--session <id>] [--new]
 *
 * Type to send. Esc (or ctrl-c once) cancels a running loop; ctrl-c again quits.
 * Colours follow the v0 palette: brain in amber, tools dim, mentions phosphor green.
 */
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { Event, Intent } from "@aicommander/protocol";

const C = {
  dim: "\x1b[38;5;65m",
  ink: "\x1b[38;5;252m",
  hi: "\x1b[38;5;114m",
  amber: "\x1b[38;5;179m",
  red: "\x1b[38;5;167m",
  off: "\x1b[0m",
};

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const port = Number.parseInt(flag("--port") ?? "7777", 10);
const wantNew = argv.includes("--new");
let sessionId = flag("--session");

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const send = (intent: Intent): void => ws.send(JSON.stringify(intent));
const id = (): string => randomUUID().slice(0, 8);

let running = false;
let streaming = false;
/** Tool calls in flight, so tool.end can name what finished. */
const pending = new Map<string, string>();
/** Input typed before the session was ready. */
const preSession: string[] = [];

const drain = (): void => {
  while (preSession.length && sessionId) {
    send({ id: id(), type: "session.send", sessionId, text: preSession.shift()!, attachments: [] });
  }
};

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${C.hi}› ${C.off}` });

/** Piped input closes stdin once it runs out; prompting a closed readline throws. */
let inputOpen = true;
rl.on("close", () => {
  inputOpen = false;
});
const prompt = (): void => {
  if (inputOpen) rl.prompt();
};

const line = (s = ""): void => {
  if (streaming) {
    process.stdout.write("\n");
    streaming = false;
  }
  process.stdout.write(`${s}\n`);
};

ws.on("open", () => {
  line(`${C.dim}connected to :${port}${C.off}`);
});

ws.on("message", (raw) => {
  const e = JSON.parse(raw.toString()) as Event;
  switch (e.type) {
    case "config":
      line(`${C.dim}brain  ${e.config.brain.model} @ ${e.config.brain.endpoint}${C.off}`);
      break;

    case "session.list":
      if (!sessionId && !wantNew && e.sessions.length) {
        sessionId = e.sessions[0]!.id;
        line(`${C.dim}session ${sessionId} (${e.sessions[0]!.name}) — --new for a fresh one${C.off}`);
        send({ id: id(), type: "session.open", sessionId });
        drain();
        prompt();
      } else if (!sessionId) {
        send({ id: id(), type: "session.create" });
      }
      break;

    case "session.events":
      if (!sessionId) {
        sessionId = e.sessionId;
        line(`${C.dim}session ${sessionId}${C.off}`);
      }
      for (const g of e.groups) {
        if (g.userText) line(`${C.dim}you  ${C.off}${g.userText}`);
        if (g.brainText) line(`${C.amber}brain${C.off} ${g.brainText}`);
      }
      drain();
      prompt();
      break;

    case "session.state":
      running = e.status === "running";
      if (e.status === "cancelled") line(`${C.red}cancelled${C.off}`);
      if (!running) {
        // Piped input that has run out: nothing more is coming, so leave rather than
        // hanging on an open socket. Interactive sessions keep waiting for the next line.
        if (!inputOpen && !preSession.length) {
          ws.close();
          return;
        }
        prompt();
      }
      break;

    case "token":
      if (!streaming) {
        process.stdout.write(`${C.amber}brain${C.off} `);
        streaming = true;
      }
      process.stdout.write(e.delta);
      break;

    case "tool.start":
      pending.set(e.callId, e.name);
      line(`${C.dim}  ⚙ ${e.name} ${JSON.stringify(e.args).slice(0, 100)}${C.off}`);
      break;

    case "tool.end": {
      const name = pending.get(e.callId) ?? "tool";
      pending.delete(e.callId);
      const mark = e.ok ? `${C.hi}✓${C.off}` : `${C.red}✗${C.off}`;
      line(`${C.dim}  ${mark} ${C.dim}${name} — ${e.summary}${e.truncated ? " (truncated)" : ""}${C.off}`);
      break;
    }

    case "toast":
      line(`${e.level === "warning" ? C.red : C.dim}${e.text}${C.off}`);
      break;

    case "error":
      line(`${C.red}error  ${e.message}${C.off}`);
      prompt();
      break;

    default:
      break;
  }
});

ws.on("close", () => {
  line(`${C.dim}disconnected${C.off}`);
  process.exit(0);
});
ws.on("error", (err) => {
  line(`${C.red}${err.message}${C.off}`);
  line(`${C.dim}is the backend running?  ./bin/aicommander serve . --port ${port}${C.off}`);
  process.exit(1);
});

rl.on("line", (input) => {
  const text = input.trim();
  if (!text) return prompt();
  if (text === "/quit" || text === "/q") return process.exit(0);
  if (text === "/cancel") {
    send({ id: id(), type: "session.cancel", sessionId: sessionId! });
    return;
  }
  if (!sessionId) {
    // Typed (or piped) before the session exists — hold it until session.events lands.
    preSession.push(text);
    return;
  }
  send({ id: id(), type: "session.send", sessionId, text, attachments: [] });
  if (running) line(`${C.dim}queued — lands at the next tool boundary${C.off}`);
});

// Esc cancels the loop. readline owns stdin, so hook its keypress stream rather than
// switching raw mode on underneath it.
if (process.stdin.isTTY) {
  const { emitKeypressEvents } = await import("node:readline");
  emitKeypressEvents(process.stdin);
  process.stdin.on("keypress", (_ch, key: { name?: string } | undefined) => {
    if (key?.name === "escape" && running && sessionId) {
      send({ id: id(), type: "session.cancel", sessionId });
    }
  });
}

rl.on("SIGINT", () => {
  if (running && sessionId) {
    line(`${C.dim}cancelling…${C.off}`);
    send({ id: id(), type: "session.cancel", sessionId });
  } else {
    process.exit(0);
  }
});
