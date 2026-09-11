import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Group, LogEntry } from "@aicommander/protocol";
import { ensureProjectDir } from "../src/config.js";
import { nextSummaryPath, planCompact, transcriptOf } from "../src/compact.js";

const roots: string[] = [];
const makeRepo = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "aic-comp-"));
  roots.push(root);
  await ensureProjectDir(root);
  return root;
};
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const group = (id: string, tokens: number): Group =>
  ({ id, sessionId: "s1", ts: 1, userText: `ask ${id}`, brainText: `reply ${id}`,
     tokens, toolCount: 1, cancelled: false });
const wrote = (id: string, path: string): LogEntry =>
  ({ t: "tool", id, ts: 1, callId: "c", name: "write_file", args: { path }, ok: true,
     summary: "", outputPath: null, tokens: 10 });

describe("planCompact", () => {
  it("keeps the last N groups and summarises the rest", () => {
    const groups = ["g1","g2","g3","g4","g5","g6","g7","g8"].map((id) => group(id, 100));
    const plan = planCompact(groups, [], 6);
    expect(plan.older.map((g) => g.id)).toEqual(["g1", "g2"]);
    expect(plan.kept).toHaveLength(6);
  });

  it("does nothing when there is not enough history", () => {
    const plan = planCompact([group("g1", 100)], [], 6);
    expect(plan.older).toEqual([]);
  });

  it("sums the tokens that would be reclaimed", () => {
    const groups = [group("g1", 500), group("g2", 300), group("g3", 100)];
    expect(planCompact(groups, [], 1).before).toBe(800);
  });

  it("carries the changed files through verbatim", () => {
    // A paraphrase reliably ruins "which files did we change".
    const groups = [group("g1", 100), group("g2", 100), group("g3", 100)];
    const entries = [wrote("g1", "src/main.c"), wrote("g2", "docs/NOTES.md")];
    const plan = planCompact(groups, entries, 1);
    expect(plan.files).toEqual(["src/main.c", "docs/NOTES.md"]);
  });

  it("does not list files from groups that are being kept", () => {
    const groups = [group("g1", 100), group("g2", 100)];
    const entries = [wrote("g1", "old.c"), wrote("g2", "recent.c")];
    expect(planCompact(groups, entries, 1).files).toEqual(["old.c"]);
  });

  it("does not repeat a file written twice, or list a failed write", () => {
    const groups = [group("g1", 100), group("g2", 100)];
    const entries: LogEntry[] = [
      wrote("g1", "a.c"),
      wrote("g1", "a.c"),
      { ...wrote("g1", "failed.c"), ok: false } as LogEntry,
    ];
    expect(planCompact(groups, entries, 1).files).toEqual(["a.c"]);
  });

  it("ignores reads — only what changed is worth preserving", () => {
    const groups = [group("g1", 100), group("g2", 100)];
    const entries: LogEntry[] = [
      { t: "tool", id: "g1", ts: 1, callId: "c", name: "read_file", args: { path: "read.c" },
        ok: true, summary: "", outputPath: null, tokens: 5 },
    ];
    expect(planCompact(groups, entries, 1).files).toEqual([]);
  });
});

describe("nextSummaryPath", () => {
  it("starts at 1 and never overwrites an earlier summary", async () => {
    const root = await makeRepo();
    const first = await nextSummaryPath(root);
    expect(first.endsWith("compact-1.md")).toBe(true);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(first, "one");
    const second = await nextSummaryPath(root);
    expect(second.endsWith("compact-2.md")).toBe(true);
    expect(await readFile(first, "utf8")).toBe("one");
  });
});

describe("transcriptOf", () => {
  it("renders turns without transcript noise", () => {
    const text = transcriptOf([group("g1", 10)]);
    expect(text).toContain("user: ask g1");
    expect(text).toContain("assistant: reply g1");
    expect(text).toContain("1 tool calls");
  });
});
