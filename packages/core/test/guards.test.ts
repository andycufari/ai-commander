import { describe, expect, it } from "vitest";
import { capText, ErrorGuard, fingerprint, RepeatGuard } from "../src/guards.js";

/** §6 guards 1, 2 and 3. */

describe("fingerprint", () => {
  it("is the same for the same call", () => {
    expect(fingerprint("grep", { pattern: "x" })).toBe(fingerprint("grep", { pattern: "x" }));
  });

  it("ignores key order — a reordered object is not a new idea", () => {
    expect(fingerprint("grep", { pattern: "x", path: "src" }))
      .toBe(fingerprint("grep", { path: "src", pattern: "x" }));
  });

  it("ignores cosmetic whitespace", () => {
    // The same grep typed with different spacing is still a repeat.
    expect(fingerprint("shell", { cmd: "grep  foo   src" }))
      .toBe(fingerprint("shell", { cmd: "grep foo src" }));
    expect(fingerprint("shell", { cmd: " ls " })).toBe(fingerprint("shell", { cmd: "ls" }));
  });

  it("still separates genuinely different calls", () => {
    expect(fingerprint("grep", { pattern: "x" })).not.toBe(fingerprint("grep", { pattern: "y" }));
    expect(fingerprint("grep", { pattern: "x" })).not.toBe(fingerprint("glob", { pattern: "x" }));
  });

  it("normalises nested objects and arrays too", () => {
    expect(fingerprint("t", { a: { z: 1, y: " s " }, list: ["  a ", "b"] }))
      .toBe(fingerprint("t", { a: { y: "s", z: 1 }, list: ["a", "b"] }));
  });

  it("ignores undefined values", () => {
    expect(fingerprint("t", { a: 1, b: undefined })).toBe(fingerprint("t", { a: 1 }));
  });
});

describe("RepeatGuard", () => {
  it("fires on the Nth identical call", () => {
    const g = new RepeatGuard(3);
    expect(g.record("grep", { pattern: "x" })).toBe(false);
    expect(g.record("grep", { pattern: "x" })).toBe(false);
    expect(g.record("grep", { pattern: "x" })).toBe(true);
  });

  it("counts whitespace variants as the same call", () => {
    const g = new RepeatGuard(3);
    g.record("shell", { cmd: "grep foo" });
    g.record("shell", { cmd: "grep  foo" });
    expect(g.record("shell", { cmd: " grep foo " })).toBe(true);
  });

  it("resets on a different call", () => {
    const g = new RepeatGuard(3);
    g.record("grep", { pattern: "x" });
    g.record("grep", { pattern: "x" });
    g.record("glob", { pattern: "*" });
    expect(g.record("grep", { pattern: "x" })).toBe(false);
    expect(g.repeats).toBe(1);
  });

  it("does not fire again immediately after the user says continue", () => {
    const g = new RepeatGuard(3);
    for (let i = 0; i < 3; i += 1) g.record("grep", { pattern: "x" });
    g.forgive();
    expect(g.record("grep", { pattern: "x" })).toBe(false);
    expect(g.record("grep", { pattern: "x" })).toBe(false);
    expect(g.record("grep", { pattern: "x" })).toBe(true);
  });
});

describe("ErrorGuard", () => {
  it("fires on the Nth consecutive failure", () => {
    const g = new ErrorGuard(4);
    expect([g.record(false), g.record(false), g.record(false), g.record(false)])
      .toEqual([false, false, false, true]);
  });

  it("any success clears the run", () => {
    const g = new ErrorGuard(4);
    g.record(false);
    g.record(false);
    g.record(false);
    g.record(true);
    expect(g.errors).toBe(0);
    expect(g.record(false)).toBe(false);
  });

  it("forgives after the user continues", () => {
    const g = new ErrorGuard(2);
    g.record(false);
    g.record(false);
    g.forgive();
    expect(g.record(false)).toBe(false);
  });
});

describe("capText", () => {
  const path = ".aicommander/out/c1.txt";

  it("leaves short output alone", () => {
    const r = capText("short", 100, path);
    expect(r.truncated).toBe(false);
    expect(r.content).toBe("short");
    expect(r.outputPath).toBeUndefined();
  });

  it("splits head 60 / tail 40 and marks the gap", () => {
    const text = `${"H".repeat(5000)}${"M".repeat(10000)}${"T".repeat(5000)}`;
    const r = capText(text, 1000, path);
    expect(r.truncated).toBe(true);
    expect(r.content.startsWith("H".repeat(600))).toBe(true);
    expect(r.content.endsWith("T".repeat(400))).toBe(true);
    expect(r.omitted).toBe(20000 - 1000);
  });

  it("names the file the rest is in, inside the content", () => {
    const r = capText("x".repeat(9000), 8000, path);
    // The model reads the content, not the metadata, so the path must be in the text.
    expect(r.content).toContain(`[… 1000 chars omitted → ${path}]`);
    expect(r.outputPath).toBe(path);
  });

  it("is exact at the boundary", () => {
    expect(capText("x".repeat(100), 100, path).truncated).toBe(false);
    expect(capText("x".repeat(101), 100, path).truncated).toBe(true);
  });
});
