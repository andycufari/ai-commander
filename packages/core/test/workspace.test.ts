import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureProjectDir } from "../src/config.js";
import { WorkspaceStore } from "../src/workspace.js";

const roots: string[] = [];
const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "aic-ws-"));
  roots.push(dir);
  await ensureProjectDir(dir);
  return dir;
};
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fileOf = (root: string) => join(root, ".aicommander", "workspace.json");

describe("WorkspaceStore", () => {
  it("returns defaults for a repo with no layout yet", async () => {
    const w = await new WorkspaceStore(await makeRepo()).load();
    expect(w).toMatchObject({ layout: "commander", gutter: 0.5, focus: "left" });
  });

  it("merges a patch over the current state", async () => {
    const store = new WorkspaceStore(await makeRepo());
    await store.set({ gutter: 0.4 });
    const w = await store.set({ focus: "right" });
    expect(w).toMatchObject({ gutter: 0.4, focus: "right" });
  });

  it("merges nested panels without losing the other side", async () => {
    const store = new WorkspaceStore(await makeRepo());
    await store.set({ panels: { left: { tabs: [{ view: "chat" }], active: 0 } } });
    const w = await store.set({ panels: { right: { tabs: [{ view: "files", path: "." }], active: 0 } } });
    expect(w.panels.left.tabs).toHaveLength(1);
    expect(w.panels.right.tabs).toHaveLength(1);
  });

  it("replaces arrays rather than concatenating them", async () => {
    const store = new WorkspaceStore(await makeRepo());
    await store.set({ marked: ["a.c", "b.c"] });
    const w = await store.set({ marked: ["c.c"] });
    expect(w.marked).toEqual(["c.c"]);
  });

  it("debounces the write, then persists", async () => {
    const root = await makeRepo();
    const store = new WorkspaceStore(root);
    await store.set({ gutter: 0.35 });
    // Nothing on disk yet: a write per keystroke of the draft would be silly.
    await expect(readFile(fileOf(root), "utf8")).rejects.toThrow();
    await sleep(500);
    expect(JSON.parse(await readFile(fileOf(root), "utf8")).gutter).toBe(0.35);
  }, 10000);

  it("collapses a burst of patches into one write", async () => {
    const root = await makeRepo();
    const store = new WorkspaceStore(root);
    for (const c of "a sentence typed into the prompt") {
      await store.set({ promptDraft: c });
    }
    await sleep(500);
    expect(JSON.parse(await readFile(fileOf(root), "utf8")).promptDraft).toBe("t");
  }, 10000);

  it("flush writes immediately, for quit", async () => {
    const root = await makeRepo();
    const store = new WorkspaceStore(root);
    await store.set({ focus: "right" });
    await store.flush();
    expect(JSON.parse(await readFile(fileOf(root), "utf8")).focus).toBe("right");
  });

  it("round-trips the v2 shape", async () => {
    const root = await makeRepo();
    const store = new WorkspaceStore(root);
    await store.set({
      gutter: 0.46,
      focus: "right",
      panels: {
        left: { tabs: [{ view: "files", path: "hw/" }, { view: "editor", path: "NOTES.md", cursor: [12, 0] }], active: 0 },
        right: { tabs: [{ view: "chat", session: "014" }], active: 0 },
      },
      marked: ["firmware/main.c"],
      promptDraft: "after that…",
    });
    await store.flush();
    const onDisk = JSON.parse(await readFile(fileOf(root), "utf8"));
    expect(onDisk).toMatchObject({
      layout: "commander",
      gutter: 0.46,
      focus: "right",
      marked: ["firmware/main.c"],
      promptDraft: "after that…",
    });
    expect(onDisk.panels.left.tabs[1].cursor).toEqual([12, 0]);
  });

  it("ignores a patch that would make the layout invalid", async () => {
    const store = new WorkspaceStore(await makeRepo());
    await store.set({ gutter: 0.4 });
    // A bad gutter must not wipe a good layout.
    const w = await store.set({ gutter: 99 });
    expect(w.gutter).toBe(0.4);
  });

  it("falls back to defaults when the file on disk is corrupt", async () => {
    const root = await makeRepo();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(fileOf(root), "{ not json");
    const w = await new WorkspaceStore(root).load();
    expect(w.gutter).toBe(0.5);
  });
});
