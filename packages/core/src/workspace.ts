import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, Workspace } from "@aicommander/protocol";
import { projectDir } from "./config.js";

/**
 * workspace.json (v2 §4) — written by the backend, debounced.
 *
 * The UI sends patches on every change; writing each one would mean a disk write per
 * keystroke of the prompt draft. 300ms of quiet is enough to batch a drag or a typed
 * sentence into one write, and a flush on close means nothing is lost on quit.
 */

const DEBOUNCE_MS = 300;

/** Deep-merge a patch over the current workspace. Arrays replace, never concat. */
function merge(base: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown> ?? {}) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(out[k], v) : v;
  }
  return out;
}

export class WorkspaceStore {
  private current: Workspace | undefined;
  private timer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {}

  private get file(): string {
    return join(projectDir(this.root), "workspace.json");
  }

  /** Read from disk, falling back to defaults for a repo opened for the first time. */
  async load(): Promise<Workspace> {
    if (this.current) return this.current;
    try {
      const raw = await readFile(this.file, "utf8");
      this.current = Workspace.parse(JSON.parse(raw));
    } catch {
      // Missing or malformed: a broken layout file must not stop the app opening.
      this.current = DEFAULT_WORKSPACE;
    }
    return this.current;
  }

  /** Apply a patch and schedule a write. Returns the merged state for broadcasting. */
  async set(patch: unknown): Promise<Workspace> {
    const base = await this.load();
    const merged = Workspace.safeParse(merge(base, patch));
    // A patch that does not validate leaves the workspace as it was rather than
    // wiping a good layout with a bad one.
    if (!merged.success) return base;
    this.current = merged.data;
    this.schedule();
    return this.current;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, DEBOUNCE_MS);
  }

  /** Write now — on close, or when a caller needs the file to be current. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const state = this.current;
    if (!state) return;
    // Serialise writes so two flushes cannot interleave.
    this.writing = this.writing.then(async () => {
      await writeFile(this.file, `${JSON.stringify(state, null, 2)}\n`);
    }).catch(() => {
      // A failed layout write is not worth surfacing; the session is what matters.
    });
    return this.writing;
  }
}
