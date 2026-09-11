import { describe, expect, it } from "vitest";
import {
  Config, DEFAULT_RULES, Event, Intent, LogEntry, Rules, Workspace, ToolArgs,
} from "../src/index.js";

describe("config", () => {
  it("fills defaults around a minimal brain block", () => {
    const c = Config.parse({ brain: { endpoint: "http://192.168.1.40:8080/v1", model: "qwen3-27b" } });
    expect(c.mode).toBe("ask");
    expect(c.loop.shellTimeoutSec).toBe(120);
    expect(c.loop.toolOutputCap).toBe(8000);
    expect(c.context.autoCompactAt).toBe(0.75);
    expect(c.boot).toEqual(["AGENTS.md", "CLAUDE.md", "BOOT.md", "SOUL.md", "rules/"]);
  });

  it("rejects a bad endpoint", () => {
    expect(Config.safeParse({ brain: { endpoint: "nope", model: "m" } }).success).toBe(false);
  });
});

describe("rules", () => {
  it("parses the shipped defaults", () => {
    expect(Rules.parse(DEFAULT_RULES).danger.length).toBe(6);
  });

  it("keeps outside-root built in", () => {
    const r = Rules.parse(DEFAULT_RULES).danger.find((d) => d.id === "outside-root");
    expect(r?.builtin).toBe(true);
  });

  it("every match is a valid regex", () => {
    for (const rule of [...DEFAULT_RULES.danger, ...DEFAULT_RULES.allow]) {
      if (rule.match) expect(() => new RegExp(rule.match!)).not.toThrow();
    }
  });

  it("rm-rf matches both flag orders and not a plain rm", () => {
    const re = new RegExp(DEFAULT_RULES.danger[0]!.match!);
    expect(re.test("rm -rf build")).toBe(true);
    expect(re.test("rm -fr build")).toBe(true);
    expect(re.test("rm build")).toBe(false);
  });
});

describe("intents", () => {
  it("parses a send with attachments", () => {
    const i = Intent.parse({
      id: "i1", type: "session.send", sessionId: "s1", text: "hi",
      attachments: [{ kind: "file", path: "a.c", hash: "h" }],
    });
    expect(i.type).toBe("session.send");
  });

  it("requires the literal confirm on delete", () => {
    const bad = { id: "i2", type: "session.delete", sessionId: "s1", confirm: "yes" };
    expect(Intent.safeParse(bad).success).toBe(false);
    expect(Intent.safeParse({ ...bad, confirm: "delete" }).success).toBe(true);
  });

  it("rejects an unknown type", () => {
    expect(Intent.safeParse({ id: "i3", type: "session.nope" }).success).toBe(false);
  });
});

describe("events", () => {
  it("parses a streaming token", () => {
    const e = Event.parse({ id: "e1", type: "token", sessionId: "s1", groupId: "g1", delta: "he" });
    expect(e.type).toBe("token");
  });

  it("defaults open_in_panel to viewing the other panel", () => {
    const e = Event.parse({ id: "e2", type: "open_in_panel", path: "main.c" });
    expect(e).toMatchObject({ mode: "view", target: "other" });
  });
});

describe("session log", () => {
  it("round-trips every jsonl line shape from the spec", () => {
    const lines = [
      { t: "user", id: "g18", ts: 1, text: "x", attachments: [{ kind: "image", file: "img/pcb.jpg" }] },
      { t: "snapshot", ts: 2, group: "g18", ref: "refs/aicommander/s014-g18" },
      { t: "brain", id: "g18", ts: 3, text: "y", toolCalls: [{ callId: "c1", name: "read_file", args: {} }] },
      { t: "tool", id: "g18", ts: 4, callId: "c1", name: "read_file", args: {}, ok: true, summary: "212 lines" },
      { t: "permission", ts: 5, callId: "c3", rule: "rm-rf", answer: "deny" },
      { t: "cancel", ts: 6, group: "g20" },
      { t: "compact", ts: 7, upTo: "g16", summaryPath: "out/compact-1.md", before: 58000, after: 11000 },
    ];
    for (const line of lines) expect(LogEntry.safeParse(line).success).toBe(true);
  });
});

describe("workspace", () => {
  it("defaults to an even split, left focused", () => {
    const w = Workspace.parse({});
    expect(w.gutter).toBe(0.5);
    expect(w.focus).toBe("left");
    expect(w.collapsed).toBeNull();
  });

  it("rejects a gutter outside its range", () => {
    expect(Workspace.safeParse({ gutter: 0.95 }).success).toBe(false);
  });
});

describe("tool args", () => {
  it("validates an edit_file call", () => {
    expect(ToolArgs.edit_file.safeParse({ path: "a.c", old: "x", new: "y" }).success).toBe(true);
    expect(ToolArgs.edit_file.safeParse({ path: "a.c", old: "x" }).success).toBe(false);
  });

  it("keeps extra git args", () => {
    const parsed = ToolArgs.git.parse({ action: "commit", message: "m" });
    expect(parsed).toMatchObject({ action: "commit", message: "m" });
  });
});
