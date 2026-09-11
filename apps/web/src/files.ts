import type { FsEntry } from "@aicommander/protocol";

/** §10 files view — an NC list: name, size, date. */

/** Always shown even with hidden files off, because they are part of the project (§10). */
export const ALWAYS_VISIBLE: Record<string, string> = {
  ".aicommander": "sessions · out · viewers",
  skills: "skills",
};

export const isHidden = (name: string): boolean => name.startsWith(".");

/**
 * Directories first, then files, each alphabetical — the NC ordering the mockup shows.
 * Comparison is case-insensitive so `README.md` and `apps/` sort where a human expects,
 * with a case-sensitive tiebreak to keep the order stable.
 */
export function sortEntries(entries: readonly FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    return byName !== 0 ? byName : a.name.localeCompare(b.name);
  });
}

/** Hidden entries are filtered unless the toggle is on — except the always-visible ones. */
export function visibleEntries(entries: readonly FsEntry[], showHidden: boolean): FsEntry[] {
  const kept = entries.filter(
    (e) => showHidden || !isHidden(e.name) || e.name in ALWAYS_VISIBLE,
  );
  return sortEntries(kept);
}

/** `1.2M`, `9.8k`, `.3k` — the mockup's compact sizes. */
export function formatSize(bytes: number, dir: boolean): string {
  if (dir) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}k`;
  // Under 1k the mockup writes `.3k`. Below ~50 bytes that rounds to a useless `.0k`,
  // so small files show their real byte count instead.
  const rounded = (bytes / 1024).toFixed(1).replace(/^0/, "");
  return rounded === ".0" ? String(bytes) : `${rounded}k`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** `sep 10`, or `sep 2024` once it is not this year. */
export function formatDate(mtime: number, now = Date.now()): string {
  if (!mtime) return "";
  const d = new Date(mtime);
  const month = MONTHS[d.getMonth()] ?? "";
  return d.getFullYear() === new Date(now).getFullYear()
    ? `${month} ${String(d.getDate()).padStart(2, "0")}`
    : `${month} ${d.getFullYear()}`;
}

/** Join a directory and a name into a repo path, keeping "." meaning the root. */
export function joinPath(dir: string, name: string): string {
  if (dir === "." || dir === "") return name;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

/** The parent of a repo path, or null at the root. */
export function parentOf(dir: string): string | null {
  if (dir === "." || dir === "" || !dir.includes("/")) return dir === "." ? null : ".";
  return dir.slice(0, dir.lastIndexOf("/")) || ".";
}

/** Footer line from the mockup: `1 of 3 dirs · 14 files`. */
export function summarize(entries: readonly FsEntry[], markedCount: number): string {
  const dirs = entries.filter((e) => e.dir).length;
  const files = entries.length - dirs;
  const base = `${dirs} dir${dirs === 1 ? "" : "s"} · ${files} file${files === 1 ? "" : "s"}`;
  return markedCount > 0 ? `${markedCount} marked · ${base}` : base;
}
