import { describe, expect, it } from "vitest";
import {
  BINDINGS, barFor, byCommand, byId, commands, hint, matches, resolve, resolveLeader,
} from "../src/keymap.js";

/** §11: one table, so a binding cannot exist in one place and be missing from another. */

const ev = (key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods } as KeyboardEvent);

describe("the table itself", () => {
  it("has no duplicate ids", () => {
    const ids = BINDINGS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every binding a way to reach it", () => {
    // A binding with neither a chord nor a leader nor a command is unreachable —
    // which is exactly what happened to the system prompt for a while.
    for (const b of BINDINGS) {
      expect(b.chord ?? b.leader ?? b.command, `${b.id} is unreachable`).toBeTruthy();
    }
  });

  it("describes every binding", () => {
    for (const b of BINDINGS) {
      expect(b.label, `${b.id} has no label`).toBeTruthy();
      expect(b.describe.length, `${b.id}'s description is too terse`).toBeGreaterThan(10);
    }
  });

  it("has no duplicate chords", () => {
    const seen = new Map<string, string>();
    for (const b of BINDINGS) {
      if (!b.chord) continue;
      const key = `${b.chord.mod ? "m" : ""}${b.chord.shift ? "s" : ""}${b.chord.alt ? "a" : ""}:${b.chord.key.toLowerCase()}`;
      expect(seen.get(key), `${b.id} collides with ${seen.get(key)}`).toBeUndefined();
      seen.set(key, b.id);
    }
  });

  it("has no duplicate leader keys or commands", () => {
    const leaders = BINDINGS.filter((b) => b.leader).map((b) => b.leader);
    expect(new Set(leaders).size).toBe(leaders.length);
    const cmds = commands().map((b) => b.command);
    expect(new Set(cmds).size).toBe(cmds.length);
  });

  it("never claims a chord the browser owns", () => {
    // ⌘W, ⌘N, ⌘T and ⌘Q belong to the tab; binding them would silently do nothing.
    const stolen = ["w", "n", "t", "q"];
    for (const b of BINDINGS) {
      if (!b.chord?.mod || b.chord.shift || b.chord.alt) continue;
      expect(stolen, `${b.id} binds a chord the browser takes`).not.toContain(b.chord.key.toLowerCase());
    }
  });
});

describe("resolve", () => {
  it("finds a binding by its chord", () => {
    expect(resolve(ev("p", { metaKey: true }))?.id).toBe("file");
    expect(resolve(ev("p", { metaKey: true, shiftKey: true }))?.id).toBe("touched");
  });

  it("does not confuse a chord with its shifted form", () => {
    expect(resolve(ev("p", { metaKey: true }))?.id).not.toBe("touched");
  });

  it("ignores a bare key that needs a modifier", () => {
    expect(resolve(ev("p"))).toBeUndefined();
  });

  it("finds the leader's second key", () => {
    expect(resolveLeader("w")?.id).toBe("closeTab");
    expect(resolveLeader("N")?.id).toBe("newSession");
    expect(resolveLeader("z")).toBeUndefined();
  });
});

describe("matches", () => {
  it("requires every modifier to agree", () => {
    expect(matches(ev("b", { metaKey: true }), { key: "b", mod: true })).toBe(true);
    expect(matches(ev("b"), { key: "b", mod: true })).toBe(false);
    expect(matches(ev("b", { metaKey: true, shiftKey: true }), { key: "b", mod: true })).toBe(false);
  });

  it("matches named keys exactly", () => {
    expect(matches(ev("Enter", { metaKey: true, shiftKey: true }),
      { key: "Enter", mod: true, shift: true })).toBe(true);
    expect(matches(ev("enter", { metaKey: true, shiftKey: true }),
      { key: "Enter", mod: true, shift: true })).toBe(false);
  });
});

describe("byCommand", () => {
  it("maps a slash command to its binding", () => {
    expect(byCommand("compact")?.id).toBe("compact");
    expect(byCommand("CLEAR")?.id).toBe("clear");
  });

  it("returns nothing for a command that does not exist", () => {
    expect(byCommand("teleport")).toBeUndefined();
  });

  it("every command names a binding that exists", () => {
    for (const b of commands()) expect(byId(b.id)).toBeTruthy();
  });
});

describe("barFor", () => {
  it("shows what the keys do here", () => {
    const chat = barFor("chat").map((b) => b.id);
    const files = barFor("files").map((b) => b.id);
    expect(chat).toContain("compact");
    expect(files).not.toContain("compact");
    expect(files).toContain("attach");
  });

  it("always offers help and the menu", () => {
    for (const view of ["chat", "files", "editor", "viewer"] as const) {
      expect(barFor(view).map((b) => b.id)).toContain("help");
      expect(barFor(view).map((b) => b.id)).toContain("menu");
    }
  });

  it("falls back to the chat bar for an unknown view", () => {
    expect(barFor(undefined).map((b) => b.id)).toEqual(barFor("chat").map((b) => b.id));
  });
});

describe("hint", () => {
  it("writes a chord the way the bar shows it", () => {
    expect(hint(byId("file")!)).toMatch(/P$/);
    expect(hint(byId("maximize")!)).toContain("⏎");
    expect(hint(byId("closeTab")!)).toMatch(/K W$/);
  });

  it("gives every bar entry something to print", () => {
    for (const b of BINDINGS) {
      if (!b.bar) continue;
      expect(hint(b), `${b.id} would print an empty chord`).toBeTruthy();
    }
  });
});
