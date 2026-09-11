import { describe, expect, it } from "vitest";
import type { Event } from "@aicommander/protocol";
import { echoUser, initialState, reduce, summarizeArgs, type UiState } from "../src/ws.js";

const run = (events: Event[], from: UiState = initialState): UiState =>
  events.reduce(reduce, from);

const ev = (e: Partial<Event> & { type: string }): Event => ({ id: "e", ...e } as Event);

describe("reduce", () => {
  it("appends streaming tokens into one brain row", () => {
    const s = run([
      ev({ type: "token", sessionId: "s", groupId: "g", delta: "Hel" }),
      ev({ type: "token", sessionId: "s", groupId: "g", delta: "lo" }),
    ]);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ kind: "brain", text: "Hello" });
  });

  it("starts a new brain row after a tool call", () => {
    const s = run([
      ev({ type: "token", sessionId: "s", groupId: "g", delta: "looking" }),
      ev({ type: "tool.start", sessionId: "s", groupId: "g", callId: "c1", name: "glob", args: { pattern: "*.c" } }),
      ev({ type: "token", sessionId: "s", groupId: "g", delta: "found" }),
    ]);
    expect(s.rows.map((r) => r.kind)).toEqual(["brain", "tool", "brain"]);
  });

  it("closes a tool row with its summary", () => {
    const s = run([
      ev({ type: "tool.start", sessionId: "s", groupId: "g", callId: "c1", name: "read_file", args: { path: "a.c" } }),
      ev({ type: "tool.end", callId: "c1", ok: true, summary: "212 lines", truncated: false }),
    ]);
    expect(s.rows[0]).toMatchObject({ running: false, ok: true, summary: "212 lines" });
  });

  it("marks truncated output", () => {
    const s = run([
      ev({ type: "tool.start", sessionId: "s", groupId: "g", callId: "c1", name: "shell", args: {} }),
      ev({ type: "tool.end", callId: "c1", ok: true, summary: "ok", truncated: true }),
    ]);
    expect(s.rows[0]!.summary).toContain("truncated");
  });

  it("rebuilds the transcript from a replayed session", () => {
    const s = run([ev({
      type: "session.events",
      sessionId: "s1",
      meta: { id: "s1", name: "n", model: "m", created: 1, snapshots: [], specialTools: [] },
      groups: [
        { id: "g1", sessionId: "s1", ts: 1, userText: "hi", brainText: "hello", tokens: 0, toolCount: 0, cancelled: false },
      ],
    })]);
    expect(s.sessionId).toBe("s1");
    expect(s.rows.map((r) => r.kind)).toEqual(["user", "brain"]);
  });

  it("tracks loop state and the queued message", () => {
    const s = run([ev({
      type: "session.state", sessionId: "s", status: "running",
      ctxUsed: 100, ctxMax: 98304, toolCount: 3, elapsed: 12.4, queued: "later",
    })]);
    expect(s).toMatchObject({ status: "running", toolCount: 3, queued: "later" });
  });

  it("takes ctxMax from config on connect", () => {
    const s = run([ev({
      type: "config",
      config: {
        brain: { endpoint: "http://x/v1", model: "m", apiKey: "", temperature: 0.6, ctx: 98304, toolFormat: "auto" },
        mode: "ask",
        loop: { maxToolCallsPerTurn: 50, maxTurnsPerPrompt: 20, shellTimeoutSec: 120, toolOutputCap: 8000, repeatGuard: 3, errorGuard: 4 },
        context: { autoCompactAt: 0.75, keepLastGroups: 6 },
        boot: [], tools: { special: [] }, notify: true,
      },
    })]);
    expect(s.ctxMax).toBe(98304);
  });

  it("keeps an error for the status line", () => {
    expect(run([ev({ type: "error", message: "boom" })]).error).toBe("boom");
  });
});

describe("summarizeArgs", () => {
  it("shows the telling argument", () => {
    expect(summarizeArgs({ path: "firmware/main.c" })).toBe("firmware/main.c");
    expect(summarizeArgs({ pattern: "**/*.c" })).toBe("**/*.c");
    expect(summarizeArgs({ cmd: "make all" })).toBe("make all");
  });

  it("falls back to json, and shows nothing for empty args", () => {
    expect(summarizeArgs({})).toBe("");
    expect(summarizeArgs({ a: 1 })).toBe('{"a":1}');
  });
});

describe("session list loading", () => {
  const meta = (id: string, created: number) =>
    ({ id, name: id, model: "m", created, snapshots: [], specialTools: [] });

  it("starts with the list not yet loaded", () => {
    expect(initialState.sessionsLoaded).toBe(false);
  });

  it("marks the list loaded even when it is empty", () => {
    // The empty case is exactly the one that used to create a duplicate session
    // on every reload, so it must be distinguishable from "not known yet".
    const s = run([ev({ type: "session.list", sessions: [] })]);
    expect(s.sessionsLoaded).toBe(true);
    expect(s.sessions).toEqual([]);
  });

  it("keeps the order the backend sent", () => {
    const s = run([ev({ type: "session.list", sessions: [meta("new", 2), meta("old", 1)] })]);
    expect(s.sessions.map((x) => x.id)).toEqual(["new", "old"]);
  });
});

describe("local echo", () => {
  it("shows a sent message immediately", () => {
    const s = echoUser(initialState, "hello");
    expect(s.rows).toEqual([{ kind: "user", text: "hello" }]);
  });

  it("a replayed session replaces echoes rather than duplicating them", () => {
    const echoed = echoUser(initialState, "hi");
    const s = reduce(echoed, {
      id: "e", type: "session.events", sessionId: "s1",
      meta: { id: "s1", name: "n", model: "m", created: 1, snapshots: [], specialTools: [] },
      groups: [{ id: "g1", sessionId: "s1", ts: 1, userText: "hi", brainText: "yo", tokens: 0, toolCount: 0, cancelled: false }],
    } as never);
    expect(s.rows.filter((r) => r.kind === "user")).toHaveLength(1);
  });
});
