import { useEffect, useMemo, useRef, useState } from "react";

/**
 * The pick modal — v2's info tier with a filterable list.
 *
 * Built as the reusable one: M2's session/model/viewer choosers and M3's `+` picker are
 * the same shape, so they extend this rather than reimplementing it. Info-tier contract
 * from v2 §1: single line border, dim title, `⏎` takes the highlighted item, `Esc` closes.
 */

export interface PickItem {
  /** Unique within one pick. */
  id: string;
  label: string;
  /** Dim text on the right — a path, a size, a hint. */
  detail?: string;
  /** Grouping header shown above this item, when it differs from the previous one. */
  group?: string;
  /** Matched against the filter in addition to the label. */
  keywords?: string;
}

export interface PickProps {
  title: string;
  items: readonly PickItem[];
  placeholder?: string;
  /** Footer hint, right-aligned in the bottom border. */
  hint?: string;
  onChoose: (item: PickItem, alt: boolean) => void;
  onClose: () => void;
  /** Filter as the user types; when absent, the built-in subsequence match is used. */
  filter?: (items: readonly PickItem[], query: string) => PickItem[];
  /** Rendered above the list — the tab strip of the M3 picker will live here. */
  header?: React.ReactNode;
}

/**
 * Subsequence match, the way every fuzzy finder behaves: "amc" finds "ai-commander".
 * Scores prefer earlier and more contiguous matches so the obvious answer sorts first.
 */
export function fuzzyScore(text: string, query: string): number | null {
  if (query === "") return 0;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  let score = 0;
  let from = 0;
  let lastHit = -1;
  for (const ch of needle) {
    const hit = haystack.indexOf(ch, from);
    if (hit === -1) return null;
    // Contiguous runs and early matches are worth more.
    score += hit === lastHit + 1 ? 3 : 1;
    if (hit === 0) score += 2;
    lastHit = hit;
    from = hit + 1;
  }
  // Shorter haystacks win ties: an exact-ish match beats a long incidental one.
  return score * 1000 - haystack.length;
}

export function defaultFilter(items: readonly PickItem[], query: string): PickItem[] {
  if (query.trim() === "") return [...items];
  const scored: { item: PickItem; score: number }[] = [];
  for (const item of items) {
    const target = `${item.label} ${item.keywords ?? ""} ${item.detail ?? ""}`;
    const score = fuzzyScore(target, query.trim());
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

export function Pick({
  title, items, placeholder, hint, onChoose, onClose, filter, header,
}: PickProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(
    () => (filter ?? defaultFilter)(items, query),
    [items, query, filter],
  );

  useEffect(() => { setCursor(0); }, [query, items]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    listRef.current?.querySelector(".pick-row.sel")?.scrollIntoView({ block: "nearest" });
  }, [cursor, shown.length]);

  const choose = (index: number, alt: boolean): void => {
    const item = shown[index];
    if (item) onChoose(item, alt);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setCursor((c) => Math.min(shown.length - 1, c + 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
        return;
      case "PageDown":
        e.preventDefault();
        setCursor((c) => Math.min(shown.length - 1, c + 8));
        return;
      case "PageUp":
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 8));
        return;
      case "Enter":
        e.preventDefault();
        // ⌃⏎ is the "somewhere else" variant — the other panel, for file picks.
        choose(cursor, e.ctrlKey || e.metaKey);
        return;
      case "Escape":
        e.preventDefault();
        onClose();
        return;
      default:
        break;
    }
  };

  let lastGroup: string | undefined;

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className="modal info pick"
        role="dialog"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <span className="t">{title}</span>
        {header}
        <input
          ref={inputRef}
          className="pick-filter"
          value={query}
          placeholder={placeholder ?? "filter"}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
          aria-label="filter"
        />
        <div className="pick-list" ref={listRef} role="listbox">
          {shown.map((item, i) => {
            const header2 = item.group && item.group !== lastGroup ? item.group : undefined;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {header2 && <div className="pick-group">{header2}</div>}
                <div
                  className={`pick-row${i === cursor ? " sel" : ""}`}
                  role="option"
                  aria-selected={i === cursor}
                  onMouseMove={() => setCursor(i)}
                  onMouseDown={(e) => { e.preventDefault(); choose(i, e.ctrlKey || e.metaKey); }}
                >
                  <span className="pick-label">{item.label}</span>
                  {item.detail && <span className="pick-detail">{item.detail}</span>}
                </div>
              </div>
            );
          })}
          {shown.length === 0 && <div className="pick-empty">no matches</div>}
        </div>
        <div className="k">{hint ?? "⏎ choose · Esc close"}</div>
      </div>
    </div>
  );
}
