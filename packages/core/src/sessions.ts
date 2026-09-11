import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Group, LogEntry, SessionMeta } from "@aicommander/protocol";

/** Which group a log entry belongs to, where it belongs to one. */
export function groupOf(entry: LogEntry): string | undefined {
  if (entry.t === "user" || entry.t === "brain" || entry.t === "tool") return entry.id;
  if (entry.t === "snapshot" || entry.t === "cancel") return entry.group;
  return undefined;
}

/** A file this session has touched (§11 ⌃⇧P). */
export interface TouchedFile {
  path: string;
  kind: "written" | "read" | "mentioned";
  /** When it was last touched. */
  ts: number;
}
import { projectDir } from "./config.js";

/** §4: session.jsonl is the source of truth; everything else is derived from it. */

const sessionsDir = (root: string): string => join(projectDir(root), "sessions");
const sessionPath = (root: string, id: string): string => join(sessionsDir(root), id);

export class SessionStore {
  constructor(private readonly root: string) {}

  async create(name?: string, model = "unknown"): Promise<SessionMeta> {
    const id = randomUUID().slice(0, 8);
    const meta: SessionMeta = {
      id,
      name: name ?? `session ${id}`,
      model,
      created: Date.now(),
      snapshots: [],
      specialTools: [],
    };
    const dir = sessionPath(this.root, id);
    await mkdir(join(dir, "img"), { recursive: true });
    await this.writeMeta(meta);
    await writeFile(join(dir, "session.jsonl"), "");
    return meta;
  }

  async list(): Promise<SessionMeta[]> {
    let ids: string[];
    try {
      ids = (await readdir(sessionsDir(this.root), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const id of ids) {
      const m = await this.readMeta(id).catch(() => undefined);
      if (m) metas.push(m);
    }
    return metas.sort((a, b) => b.created - a.created);
  }

  async readMeta(id: string): Promise<SessionMeta> {
    const raw = await readFile(join(sessionPath(this.root, id), "meta.json"), "utf8");
    return SessionMeta.parse(JSON.parse(raw));
  }

  async writeMeta(meta: SessionMeta): Promise<void> {
    const dir = sessionPath(this.root, meta.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  }

  /** Append one event. The jsonl file is only ever appended to, never rewritten in place. */
  async append(id: string, entry: LogEntry): Promise<void> {
    await appendFile(join(sessionPath(this.root, id), "session.jsonl"), `${JSON.stringify(entry)}\n`);
  }

  /** Read the log back. A malformed line is skipped rather than failing the whole session. */
  async read(id: string): Promise<LogEntry[]> {
    let raw: string;
    try {
      raw = await readFile(join(sessionPath(this.root, id), "session.jsonl"), "utf8");
    } catch {
      return [];
    }
    const out: LogEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(LogEntry.parse(JSON.parse(line)));
      } catch {
        // a truncated last line after a crash — drop it and keep the rest
      }
    }
    return out;
  }

  /**
   * Empty a session without deleting it (§3 session.clear).
   *
   * The log is truncated rather than the directory removed: the session keeps its id,
   * name and place in the list, so "clear" means "forget this conversation", not
   * "throw away the session I named". Snapshots are dropped with it, since the groups
   * they belong to are gone.
   */
  async clear(id: string): Promise<void> {
    const dir = sessionPath(this.root, id);
    await writeFile(join(dir, "session.jsonl"), "");
    const meta = await this.readMeta(id).catch(() => undefined);
    if (meta) await this.writeMeta({ ...meta, snapshots: [] });
  }

  /** Replace the log wholesale — used when entries are edited, not just filtered. */
  async replaceLog(id: string, entries: LogEntry[]): Promise<void> {
    const lines = entries.map((e) => `${JSON.stringify(e)}\n`).join("");
    await writeFile(join(sessionPath(this.root, id), "session.jsonl"), lines);
  }

  /** Rewrite the log, keeping only entries the predicate accepts. */
  async rewrite(id: string, keep: (entry: LogEntry) => boolean): Promise<void> {
    const entries = await this.read(id);
    const lines = entries.filter(keep).map((e) => `${JSON.stringify(e)}\n`).join("");
    await writeFile(join(sessionPath(this.root, id), "session.jsonl"), lines);
  }

  /** Everything up to and including a group — the log a fork starts from (§10). */
  async upTo(id: string, groupId: string): Promise<LogEntry[]> {
    const entries = await this.read(id);
    const end = entries.findIndex((e) => groupOf(e) === groupId);
    if (end === -1) return entries;
    // Include the whole group, not just its first entry.
    let last = end;
    for (let i = end; i < entries.length; i += 1) {
      if (groupOf(entries[i]!) === groupId) last = i;
    }
    return entries.slice(0, last + 1);
  }

  /** Copy a session's history into a new one, for fork (§10). */
  async fork(from: string, groupId: string, name?: string): Promise<SessionMeta> {
    const source = await this.readMeta(from);
    const created = await this.create(name ?? `${source.name} (fork)`, source.model);
    const entries = await this.upTo(from, groupId);
    for (const entry of entries) await this.append(created.id, entry);
    await this.writeMeta({
      ...created,
      forkedFrom: from,
      specialTools: source.specialTools,
      options: source.options,
    });
    return this.readMeta(created.id);
  }

  async delete(id: string): Promise<void> {
    await rm(sessionPath(this.root, id), { recursive: true, force: true });
  }

  /**
   * Every file this session has touched, for the ⌃⇧P modal (§11).
   *
   * Derived from the log rather than from UI state, so it survives a reload and stays
   * per-session — "the files this conversation is about" is the useful set. Writes sort
   * first and are marked, because the thing you most often want to look at is what the
   * brain just changed; within each kind, most recent first.
   */
  static touchedFiles(entries: LogEntry[]): TouchedFile[] {
    const byPath = new Map<string, TouchedFile>();

    const note = (path: string, kind: TouchedFile["kind"], ts: number): void => {
      const prev = byPath.get(path);
      // A file written at any point counts as written, even if later only read.
      const rank = { written: 2, mentioned: 1, read: 0 } as const;
      if (prev && rank[prev.kind] >= rank[kind]) {
        prev.ts = Math.max(prev.ts, ts);
        return;
      }
      byPath.set(path, { path, kind, ts: Math.max(ts, prev?.ts ?? 0) });
    };

    for (const e of entries) {
      if (e.t === "tool") {
        if (!e.ok) continue;
        const args = e.args as { path?: unknown; paths?: unknown };
        if (e.name === "write_file" || e.name === "edit_file") {
          if (typeof args.path === "string" && args.path) note(args.path, "written", e.ts);
        } else if (e.name === "read_file") {
          if (typeof args.path === "string" && args.path) note(args.path, "read", e.ts);
        } else if (e.name === "show_files") {
          // show_files takes an array; every path the brain chose to surface counts.
          for (const p of Array.isArray(args.paths) ? args.paths : []) {
            if (typeof p === "string" && p) note(p, "read", e.ts);
          }
        }
      } else if (e.t === "user") {
        for (const a of e.attachments) {
          if (a.kind === "file") note(a.path, "mentioned", e.ts);
        }
      }
    }

    return [...byPath.values()].sort((a, b) => {
      const aw = a.kind === "written" ? 1 : 0;
      const bw = b.kind === "written" ? 1 : 0;
      if (aw !== bw) return bw - aw;
      return b.ts - a.ts;
    });
  }

  /** Replay the log into groups — the unit the UI renders and rewind operates on (§4). */
  static toGroups(sessionId: string, entries: LogEntry[]): Group[] {
    const order: string[] = [];
    const byId = new Map<string, Group>();
    const get = (id: string, ts: number): Group => {
      let g = byId.get(id);
      if (!g) {
        g = { id, sessionId, ts, userText: "", brainText: "", tokens: 0, toolCount: 0, cancelled: false };
        byId.set(id, g);
        order.push(id);
      }
      return g;
    };

    for (const e of entries) {
      switch (e.t) {
        case "user":
          get(e.id, e.ts).userText = e.text;
          break;
        case "brain": {
          const g = get(e.id, e.ts);
          // A group can have several brain turns (one per tool round trip); concatenate.
          g.brainText += e.text;
          break;
        }
        case "tool": {
          const g = get(e.id, e.ts);
          g.toolCount += 1;
          // Counted from the log, so the navigator shows what a group actually cost
          // rather than a guess made at render time.
          g.tokens += e.tokens;
          break;
        }
        case "cancel": {
          const g = byId.get(e.group);
          if (g) g.cancelled = true;
          break;
        }
        default:
          break;
      }
    }
    return order.map((id) => byId.get(id)!);
  }
}
