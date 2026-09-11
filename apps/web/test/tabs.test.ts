import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { keysFor, usePanelTabs } from "../src/tabs.js";

const chat = { id: "chat", view: "chat" as const, title: "chat", dirty: false };

describe("usePanelTabs", () => {
  it("opens a tab and focuses it", () => {
    const { result } = renderHook(() => usePanelTabs());
    act(() => { result.current.open({ view: "files", title: "files" }); });
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.active?.title).toBe("files");
  });

  it("focuses an existing tab instead of duplicating a file", () => {
    const { result } = renderHook(() => usePanelTabs([chat], "chat"));
    let first = "";
    act(() => { first = result.current.open({ view: "editor", title: "a.c", path: "a.c" }); });
    act(() => { result.current.select("chat"); });
    let second = "";
    act(() => { second = result.current.open({ view: "editor", title: "a.c", path: "a.c" }); });
    expect(result.current.tabs).toHaveLength(2);
    expect(second).toBe(first);
    expect(result.current.activeId).toBe(first);
  });

  it("opens the same path in different views as separate tabs", () => {
    const { result } = renderHook(() => usePanelTabs());
    act(() => { result.current.open({ view: "editor", title: "a.md", path: "a.md" }); });
    act(() => { result.current.open({ view: "viewer", title: "a.md", path: "a.md" }); });
    expect(result.current.tabs).toHaveLength(2);
  });

  it("closing the active tab focuses its left neighbour", () => {
    const { result } = renderHook(() => usePanelTabs([chat], "chat"));
    let b = "";
    act(() => { result.current.open({ view: "files", title: "b" }); });
    act(() => { b = result.current.open({ view: "files", title: "c" }); });
    act(() => { result.current.close(b); });
    expect(result.current.active?.title).toBe("b");
  });

  it("closing the last tab leaves nothing active", () => {
    const { result } = renderHook(() => usePanelTabs([chat], "chat"));
    act(() => { result.current.close("chat"); });
    expect(result.current.tabs).toHaveLength(0);
    expect(result.current.activeId).toBeNull();
  });

  it("closing an inactive tab keeps the focus where it was", () => {
    const { result } = renderHook(() => usePanelTabs([chat], "chat"));
    let other = "";
    act(() => { other = result.current.open({ view: "files", title: "f" }); });
    act(() => { result.current.select("chat"); });
    act(() => { result.current.close(other); });
    expect(result.current.activeId).toBe("chat");
  });

  it("cycles forward and backward, wrapping", () => {
    const { result } = renderHook(() => usePanelTabs([chat], "chat"));
    act(() => { result.current.open({ view: "files", title: "b" }); });
    act(() => { result.current.select("chat"); });
    act(() => { result.current.cycle(1); });
    expect(result.current.active?.title).toBe("b");
    act(() => { result.current.cycle(1); });
    expect(result.current.active?.title).toBe("chat");
    act(() => { result.current.cycle(-1); });
    expect(result.current.active?.title).toBe("b");
  });

  it("marks a tab dirty", () => {
    const { result } = renderHook(() => usePanelTabs([chat], "chat"));
    act(() => { result.current.setDirty("chat", true); });
    expect(result.current.tabs[0]!.dirty).toBe(true);
  });

  it("cycling with no tabs does nothing", () => {
    const { result } = renderHook(() => usePanelTabs());
    act(() => { result.current.cycle(1); });
    expect(result.current.activeId).toBeNull();
  });
});

describe("keysFor", () => {
  it("gives each view its own bar", () => {
    expect(keysFor("chat").map((k) => k[1])).toContain("sessions");
    expect(keysFor("files").map((k) => k[1])).toContain("mkdir");
    expect(keysFor("editor").map((k) => k[1])).toContain("save");
  });

  it("always has ten keys, F1 through F10", () => {
    for (const v of ["chat", "files", "editor", "viewer"] as const) {
      const keys = keysFor(v);
      expect(keys).toHaveLength(10);
      expect(keys[0]![0]).toBe("F1");
      expect(keys[9]![0]).toBe("F10");
    }
  });

  it("falls back to the chat bar for an unknown view", () => {
    expect(keysFor(undefined)).toEqual(keysFor("chat"));
  });
});
