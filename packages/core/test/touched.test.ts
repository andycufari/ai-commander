import { describe, expect, it } from "vitest";
import type { LogEntry } from "@aicommander/protocol";
import { SessionStore } from "../src/sessions.js";

/** §11 ⌃⇧P: files this session touched, derived from the log so it survives reload. */

const tool = (name: string, args: Record<string, unknown>, ts: number, ok = true): LogEntry =>
  ({ t: "tool", id: "g1", ts, callId: `c${ts}`, name, args, ok, summary: "", outputPath: null, tokens: 0 });

describe("touchedFiles", () => {
  it("collects written, read and mentioned files", () => {
    const touched = SessionStore.touchedFiles([
      tool("write_file", { path: "a.md" }, 3),
      tool("read_file", { path: "b.c" }, 2),
      { t: "user", id: "g1", ts: 1, text: "x", attachments: [{ kind: "file", path: "c.h", hash: "" }] },
    ]);
    expect(touched.map((t) => t.path).sort()).toEqual(["a.md", "b.c", "c.h"]);
  });

  it("sorts writes first, then others, recent first within each", () => {
    const touched = SessionStore.touchedFiles([
      tool("read_file", { path: "old-read.c" }, 1),
      tool("write_file", { path: "old-write.md" }, 2),
      tool("read_file", { path: "new-read.c" }, 5),
      tool("write_file", { path: "new-write.md" }, 4),
    ]);
    expect(touched.map((t) => t.path)).toEqual([
      "new-write.md", "old-write.md", "new-read.c", "old-read.c",
    ]);
  });

  it("marks the kind so the modal can group them", () => {
    const touched = SessionStore.touchedFiles([tool("edit_file", { path: "a.md" }, 1)]);
    expect(touched[0]).toMatchObject({ path: "a.md", kind: "written" });
  });

  it("a file both read and written counts as written", () => {
    const touched = SessionStore.touchedFiles([
      tool("read_file", { path: "a.md" }, 1),
      tool("write_file", { path: "a.md" }, 2),
    ]);
    expect(touched).toHaveLength(1);
    expect(touched[0]!.kind).toBe("written");
  });

  it("does not downgrade a written file that is read again later", () => {
    const touched = SessionStore.touchedFiles([
      tool("write_file", { path: "a.md" }, 1),
      tool("read_file", { path: "a.md" }, 9),
    ]);
    expect(touched[0]).toMatchObject({ kind: "written", ts: 9 });
  });

  it("collects every path of a show_files call", () => {
    const touched = SessionStore.touchedFiles([
      tool("show_files", { paths: ["a.png", "b.md"] }, 1),
    ]);
    expect(touched.map((t) => t.path).sort()).toEqual(["a.md".replace("a.md", "a.png"), "b.md"].sort());
  });

  it("ignores failed tool calls", () => {
    const touched = SessionStore.touchedFiles([
      tool("write_file", { path: "nope.md" }, 1, false),
    ]);
    expect(touched).toEqual([]);
  });

  it("ignores tools that do not name a file", () => {
    const touched = SessionStore.touchedFiles([
      tool("shell", { cmd: "ls" }, 1),
      tool("glob", { pattern: "**/*" }, 2),
    ]);
    expect(touched).toEqual([]);
  });

  it("is empty for a session that has done nothing", () => {
    expect(SessionStore.touchedFiles([])).toEqual([]);
  });
});
