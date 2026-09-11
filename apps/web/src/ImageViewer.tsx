import { useCallback, useEffect, useRef, useState } from "react";

/**
 * §10 image viewer — fit to panel by default, `1` for 1:1, drag to pan, scroll to zoom.
 * Filename and dimensions sit in the bottom border, like the files view's caption.
 */

const MIN_SCALE = 0.05;
const MAX_SCALE = 32;
const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export interface ImageViewerProps {
  path: string;
  focused: boolean;
  onEscape: () => void;
  /** Bumped by fs.changed so a regenerated image reloads (M1 step 6). */
  revision?: number;
}

export function ImageViewer({ path, focused, onEscape, revision }: ImageViewerProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number }>();
  const [scale, setScale] = useState(1);
  /** null while fitting: the panel decides the scale until the user zooms. */
  const [userScale, setUserScale] = useState<number | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [error, setError] = useState(false);
  const dragging = useRef<{ x: number; y: number; panX: number; panY: number }>();

  const url = `/file?path=${encodeURIComponent(path)}${revision ? `&v=${revision}` : ""}`;

  /** The scale that fits the image inside the panel, never enlarging past 1:1. */
  const fitScale = useCallback((): number => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || !natural || natural.w === 0 || natural.h === 0) return 1;
    return Math.min(1, Math.min(box.width / natural.w, box.height / natural.h));
  }, [natural]);

  // Refit whenever the panel resizes — the gutter moving or a panel collapsing must
  // not leave the image at a stale scale.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const apply = (): void => {
      if (userScale === null) {
        setScale(fitScale());
        setPan({ x: 0, y: 0 });
      }
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(box);
    return () => ro.disconnect();
  }, [fitScale, userScale]);

  const zoomTo = useCallback((next: number) => {
    setUserScale(clampScale(next));
    setScale(clampScale(next));
  }, []);

  const fit = useCallback(() => {
    setUserScale(null);
    setScale(fitScale());
    setPan({ x: 0, y: 0 });
  }, [fitScale]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case "1": e.preventDefault(); zoomTo(1); setPan({ x: 0, y: 0 }); return;
      case "0": case "f": e.preventDefault(); fit(); return;
      case "+": case "=": e.preventDefault(); zoomTo(scale * 1.25); return;
      case "-": e.preventDefault(); zoomTo(scale / 1.25); return;
      case "Escape": e.preventDefault(); onEscape(); return;
      default: break;
    }
  };

  const onWheel = (e: React.WheelEvent): void => {
    // The panel does not scroll, so the wheel is free to mean zoom.
    e.preventDefault();
    zoomTo(scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
  };

  const onPointerDown = (e: React.PointerEvent): void => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragging.current;
    if (!d) return;
    setPan({ x: d.panX + (e.clientX - d.x), y: d.panY + (e.clientY - d.y) });
  };
  const endDrag = (): void => { dragging.current = undefined; };

  useEffect(() => {
    if (focused) boxRef.current?.focus();
  }, [focused]);

  const pct = Math.round(scale * 100);

  return (
    <>
      <div
        className="body image"
        ref={boxRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={fit}
      >
        {error ? (
          <span className="red">cannot display {path}</span>
        ) : (
          <img
            ref={imgRef}
            src={url}
            alt={path}
            draggable={false}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              transformOrigin: "center center",
            }}
            onLoad={(e) => {
              const el = e.currentTarget;
              setNatural({ w: el.naturalWidth, h: el.naturalHeight });
              setError(false);
            }}
            onError={() => setError(true)}
          />
        )}
      </div>
      <div className="tb image-tb">
        {path.split("/").pop()}
        {natural ? ` · ${natural.w}×${natural.h}` : ""}
        {` · ${pct}%`}
        {userScale === null ? " (fit)" : ""}
        {" · 1 for 1:1"}
      </div>
    </>
  );
}
