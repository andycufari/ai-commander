import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelSide } from "@aicommander/protocol";

/** §10: gutter draggable and ⌃←/→ in 5% steps, ⌃B collapses the other panel. */

export const GUTTER_MIN = 0.15;
export const GUTTER_MAX = 0.85;
export const GUTTER_STEP = 0.05;

export const clampGutter = (v: number): number =>
  Math.min(GUTTER_MAX, Math.max(GUTTER_MIN, Math.round(v * 1000) / 1000));

/** Maximised panels take 80% of the row — wide enough to read, narrow enough to keep
 *  the conversation in view (unlike a collapse, which hides it). */
export const MAXIMIZED = 0.8;

export interface PanelLayout {
  gutter: number;
  focus: PanelSide;
  collapsed: PanelSide | null;
  /** Which panel is maximised, if any. */
  maximized: PanelSide | null;
  toggleMaximize: (side: PanelSide) => void;
  setGutter: (v: number | ((prev: number) => number)) => void;
  setFocus: (side: PanelSide) => void;
  toggleCollapse: () => void;
  swapFocus: () => void;
  /** The panel that is not focused — where open_in_panel puts things (§5). */
  other: PanelSide;
}

export interface LayoutInit {
  gutter?: number;
  focus?: PanelSide;
  collapsed?: PanelSide | null;
  /** Called whenever the layout settles, so it can be persisted (workspace.json). */
  onChange?: (next: { gutter: number; focus: PanelSide; collapsed: PanelSide | null }) => void;
}

export function usePanelLayout(init: LayoutInit = {}): PanelLayout {
  const [gutter, setGutterRaw] = useState(init.gutter ?? 0.5);
  const [focus, setFocus] = useState<PanelSide>(init.focus ?? "left");
  const [collapsed, setCollapsed] = useState<PanelSide | null>(init.collapsed ?? null);
  const [maximized, setMaximized] = useState<PanelSide | null>(null);
  /** The gutter to return to when un-maximising. */
  const restoreGutter = useRef(init.gutter ?? 0.5);

  // Adopt a layout that arrives from the backend after the first render.
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current || init.gutter === undefined) return;
    applied.current = true;
    setGutterRaw(clampGutter(init.gutter));
    if (init.focus) setFocus(init.focus);
    setCollapsed(init.collapsed ?? null);
  }, [init.gutter, init.focus, init.collapsed]);

  const setGutter = useCallback((v: number | ((prev: number) => number)) => {
    setGutterRaw((prev) => clampGutter(typeof v === "function" ? v(prev) : v));
  }, []);

  const swapFocus = useCallback(() => {
    setFocus((f) => (f === "left" ? "right" : "left"));
  }, []);

  /** Maximise a panel to 80%, or restore the gutter it had before. */
  const toggleMaximize = useCallback((side: PanelSide) => {
    setMaximized((current) => {
      if (current === side) {
        setGutterRaw(clampGutter(restoreGutter.current));
        return null;
      }
      if (current === null) restoreGutter.current = gutter;
      setGutterRaw(side === "left" ? MAXIMIZED : 1 - MAXIMIZED);
      return side;
    });
  }, [gutter]);

  /** ⌃B collapses the *other* panel; pressing it again restores (§10). */
  const toggleCollapse = useCallback(() => {
    setCollapsed((c) => (c === null ? (focus === "left" ? "right" : "left") : null));
  }, [focus]);

  const onChange = init.onChange;
  useEffect(() => {
    onChange?.({ gutter, focus, collapsed });
  }, [gutter, focus, collapsed, onChange]);

  return {
    gutter, focus, collapsed, maximized,
    setGutter, setFocus, toggleCollapse, toggleMaximize, swapFocus,
    other: focus === "left" ? "right" : "left",
  };
}

/** Pointer drag on the gutter → a fraction of the container width. */
export function useGutterDrag(
  containerRef: React.RefObject<HTMLElement>,
  setGutter: (v: number) => void,
): { dragging: boolean; onPointerDown: (e: React.PointerEvent) => void } {
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent): void => {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width > 0) setGutter((e.clientX - r.left) / r.width);
    };
    const up = (): void => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging, containerRef, setGutter]);

  return { dragging, onPointerDown };
}
