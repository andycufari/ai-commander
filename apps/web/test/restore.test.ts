import { describe, expect, it } from "vitest";
import type { Tab } from "@aicommander/protocol";
import { toPersistedTabs, toRuntimeTabs } from "../src/restore.js";

const tab = (over: Partial<Tab>): Tab => ({
  id: "t1", view: "editor", title: "x", dirty: false, conflict: false, missing: false, ...over,
});

describe("toRuntimeTabs", () => {
  it("mints ids and titles from what a tab points at", () => {
    const { tabs } = toRuntimeTabs({
      tabs: [{ view: "editor", path: "docs/NOTES.md" }, { view: "chat", session: "014" }],
      active: 0,
    });
    expect(tabs[0]).toMatchObject({ view: "editor", path: "docs/NOTES.md", title: "NOTES.md" });
    expect(tabs[1]).toMatchObject({ view: "chat", title: "chat" });
    // Ids are generated, not restored — a persisted id means nothing after a restart.
    expect(tabs[0]!.id).not.toBe(tabs[1]!.id);
  });

  it("restores the active tab by index", () => {
    const { tabs, activeId } = toRuntimeTabs({
      tabs: [{ view: "files", path: "." }, { view: "editor", path: "a.md" }],
      active: 1,
    });
    expect(activeId).toBe(tabs[1]!.id);
  });

  it("falls back to the first tab when the index is out of range", () => {
    const { tabs, activeId } = toRuntimeTabs({ tabs: [{ view: "chat" }], active: 7 });
    expect(activeId).toBe(tabs[0]!.id);
  });

  it("handles an empty panel", () => {
    expect(toRuntimeTabs({ tabs: [], active: 0 })).toEqual({ tabs: [], activeId: null });
  });

  it("names the files view by its directory", () => {
    const { tabs } = toRuntimeTabs({ tabs: [{ view: "files", path: "hw" }], active: 0 });
    expect(tabs[0]!.title).toBe("hw");
    const root = toRuntimeTabs({ tabs: [{ view: "files", path: "." }], active: 0 });
    expect(root.tabs[0]!.title).toBe("files");
  });

  it("restores a tab whose file may be gone, rather than dropping it", () => {
    // Whether it exists is discovered when the view loads; a layout the user arranged
    // is not silently discarded.
    const { tabs } = toRuntimeTabs({ tabs: [{ view: "editor", path: "ghost.md" }], active: 0 });
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.missing).toBe(false);
  });

  it("infers the viewer when one was not persisted", () => {
    const { tabs } = toRuntimeTabs({ tabs: [{ view: "viewer", path: "a.png" }], active: 0 });
    expect(tabs[0]!.viewer).toBe("image");
  });
});

describe("toPersistedTabs", () => {
  it("keeps only what identifies a tab", () => {
    const p = toPersistedTabs([tab({ path: "a.md", mode: "view", viewer: "markdown", dirty: true })], "t1");
    // dirty/conflict/missing are runtime state, not layout.
    expect(p.tabs[0]).toEqual({ view: "editor", path: "a.md", mode: "view", viewer: "markdown" });
  });

  it("records the active index", () => {
    const p = toPersistedTabs([tab({ id: "a" }), tab({ id: "b" })], "b");
    expect(p.active).toBe(1);
  });

  it("falls back to 0 when nothing is active", () => {
    expect(toPersistedTabs([tab({ id: "a" })], null).active).toBe(0);
  });

  it("round-trips through restore unchanged", () => {
    const original = {
      tabs: [
        { view: "files" as const, path: "hw" },
        { view: "editor" as const, path: "NOTES.md", cursor: [12, 0] as [number, number], mode: "edit" as const },
      ],
      active: 1,
    };
    const runtime = toRuntimeTabs(original);
    const back = toPersistedTabs(runtime.tabs, runtime.activeId);
    expect(back.active).toBe(original.active);
    expect(back.tabs[0]).toMatchObject({ view: "files", path: "hw" });
    expect(back.tabs[1]).toMatchObject({ view: "editor", path: "NOTES.md", cursor: [12, 0], mode: "edit" });
  });
});
