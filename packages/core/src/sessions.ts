import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Group, LogEntry, SessionMeta } from "@aicommander/protocol";
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

  async delete(id: string): Promise<void> {
    await rm(sessionPath(this.root, id), { recursive: true, force: true });
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
