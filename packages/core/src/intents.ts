import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { basename } from "node:path";
import {
  type Config, type Event, type FsEntry, type Intent, type Rules, type Workspace,
  DEFAULT_WORKSPACE, Workspace as WorkspaceSchema,
} from "@aicommander/protocol";
import { projectDir } from "./config.js";
import { resolveInRoot, toRepoPath } from "./paths.js";
import { globFiles } from "./tools.js";
import { SessionStore } from "./sessions.js";
import type { Loop } from "./loop.js";
import { join } from "node:path";

const run = promisify(execFile);

export interface Ctx {
  root: string;
  config: Config;
  rules: Rules;
  sessions: SessionStore;
  loop: Loop;
  /** To every connected client — state the UI must agree on. */
  broadcast: (event: Event) => void;
  /** To the client that sent the intent — replies and errors. */
  send: (event: Event) => void;
}

const ev = <T extends Event["type"]>(type: T, payload: Omit<Extract<Event, { type: T }>, "id" | "type">) =>
  ({ id: randomUUID(), type, ...payload }) as Extract<Event, { type: T }>;

const hash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

export async function handleIntent(intent: Intent, ctx: Ctx): Promise<void> {
  switch (intent.type) {
    case "session.create": {
      const meta = await ctx.sessions.create(intent.name, ctx.config.brain.model);
      ctx.broadcast(ev("session.list", { sessions: await ctx.sessions.list() }));
      ctx.send(ev("session.events", { sessionId: meta.id, meta, groups: [], touched: [] }));
      return;
    }

    case "session.open": {
      const meta = await ctx.sessions.readMeta(intent.sessionId);
      const entries = await ctx.sessions.read(intent.sessionId);
      ctx.send(ev("session.events", {
        sessionId: meta.id,
        meta,
        groups: SessionStore.toGroups(meta.id, entries),
        touched: SessionStore.touchedFiles(entries),
      }));
      ctx.send(ev("session.state", {
        sessionId: meta.id,
        status: "idle",
        ctxUsed: 0,
        ctxMax: ctx.config.brain.ctx,
        toolCount: 0,
        elapsed: 0,
      }));
      return;
    }

    case "session.rename": {
      const meta = await ctx.sessions.readMeta(intent.sessionId);
      await ctx.sessions.writeMeta({ ...meta, name: intent.name });
      ctx.broadcast(ev("session.list", { sessions: await ctx.sessions.list() }));
      return;
    }

    case "session.delete": {
      await ctx.sessions.delete(intent.sessionId);
      ctx.broadcast(ev("session.list", { sessions: await ctx.sessions.list() }));
      return;
    }

    case "session.close":
      return;

    case "session.send": {
      // Running: queue it for the next tool boundary (guard 5). Idle: start a turn.
      if (ctx.loop.isRunning(intent.sessionId)) {
        ctx.loop.queue(intent.sessionId, intent.text);
        return;
      }
      // Deliberately not awaited: the turn streams events for its whole life, and the
      // socket must stay responsive so Esc can cancel it.
      void ctx.loop.send(intent.sessionId, intent.text).catch((err: unknown) => {
        ctx.broadcast(ev("error", { message: err instanceof Error ? err.message : String(err) }));
      });
      return;
    }

    case "session.cancel": {
      if (!ctx.loop.cancel(intent.sessionId)) {
        ctx.send(ev("toast", { level: "info", text: "nothing running" }));
      }
      return;
    }

    case "files.shown": {
      ctx.loop.resolveShow(intent.requestId, intent.results, intent.side);
      return;
    }

    case "session.rewind":
    case "session.dropGroup":
    case "session.dropToolOutput":
    case "session.compact":
    case "session.clear":
    case "permission.answer":
    case "ask.answer":
      throw new Error(`${intent.type} arrives with the agent loop`);

    case "options.set":
      throw new Error("options.set arrives with the options modal (M2)");

    case "fs.list": {
      const abs = await resolveInRoot(ctx.root, intent.path);
      const dirents = await readdir(abs, { withFileTypes: true });
      const entries: FsEntry[] = [];
      for (const d of dirents) {
        const full = join(abs, d.name);
        const info = await stat(full).catch(() => undefined);
        entries.push({
          name: d.name,
          path: toRepoPath(ctx.root, full),
          dir: d.isDirectory(),
          size: info?.size ?? 0,
          mtime: info ? Math.floor(info.mtimeMs) : 0,
        });
      }
      // Directories first, then name — the NC ordering the files view expects (§10).
      entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      ctx.send(ev("fs.listed", { intentId: intent.id, path: toRepoPath(ctx.root, abs), entries }));
      return;
    }

    case "fs.tree": {
      // globFiles already skips node_modules/.git/dist/.aicommander, which is what
      // makes this usable as a fuzzy-open source rather than a wall of build output.
      const all = await globFiles(ctx.root, "**/*");
      const paths = all.slice(0, intent.limit);
      ctx.send(ev("fs.tree", {
        intentId: intent.id,
        paths,
        truncated: all.length > paths.length,
      }));
      return;
    }

    case "fs.read": {
      const abs = await resolveInRoot(ctx.root, intent.path);
      const content = await readFile(abs, "utf8");
      ctx.send(ev("fs.content", {
        intentId: intent.id,
        path: toRepoPath(ctx.root, abs),
        content,
        hash: hash(content),
      }));
      return;
    }

    case "fs.write": {
      const abs = await resolveInRoot(ctx.root, intent.path);
      if (intent.baseHash !== null) {
        const current = await readFile(abs, "utf8").catch(() => undefined);
        // The editor loaded a version that is no longer on disk — the UI shows the
        // external-change modal rather than silently overwriting (§10).
        if (current !== undefined && hash(current) !== intent.baseHash) {
          throw new Error(`${intent.path} changed on disk since it was opened`);
        }
      }
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, intent.content);
      ctx.send(ev("fs.wrote", {
        intentId: intent.id,
        path: toRepoPath(ctx.root, abs),
        hash: hash(intent.content),
      }));
      ctx.broadcast(ev("fs.changed", { paths: [toRepoPath(ctx.root, abs)] }));
      return;
    }

    case "fs.mkdir": {
      const abs = await resolveInRoot(ctx.root, intent.path);
      await mkdir(abs, { recursive: true });
      ctx.broadcast(ev("fs.changed", { paths: [toRepoPath(ctx.root, abs)] }));
      return;
    }

    case "fs.rename":
    case "fs.move": {
      const from = await resolveInRoot(ctx.root, intent.path);
      const to = await resolveInRoot(ctx.root, intent.to);
      await mkdir(join(to, ".."), { recursive: true });
      await rename(from, to);
      ctx.broadcast(ev("fs.changed", {
        paths: [toRepoPath(ctx.root, from), toRepoPath(ctx.root, to)],
      }));
      return;
    }

    case "fs.copy": {
      const from = await resolveInRoot(ctx.root, intent.path);
      const to = await resolveInRoot(ctx.root, intent.to);
      await mkdir(join(to, ".."), { recursive: true });
      await copyFile(from, to);
      ctx.broadcast(ev("fs.changed", { paths: [toRepoPath(ctx.root, to)] }));
      return;
    }

    case "fs.delete": {
      const abs = await resolveInRoot(ctx.root, intent.path);
      if (abs === ctx.root) throw new Error("refusing to delete the repo root");
      if (abs === projectDir(ctx.root)) throw new Error("refusing to delete .aicommander");
      await rm(abs, { recursive: true, force: true });
      ctx.broadcast(ev("fs.changed", { paths: [toRepoPath(ctx.root, abs)] }));
      return;
    }

    case "git.status": {
      const text = await git(ctx.root, ["status", "--short", "--branch"]);
      ctx.send(ev("git.result", { intentId: intent.id, action: "status", text }));
      return;
    }
    case "git.log": {
      const args = ["log", `-n${intent.n}`, "--oneline", "--no-color"];
      if (intent.path) args.push("--", intent.path);
      ctx.send(ev("git.result", { intentId: intent.id, action: "log", text: await git(ctx.root, args) }));
      return;
    }
    case "git.diff": {
      const args = ["diff", "--no-color"];
      if (intent.path) args.push("--", intent.path);
      ctx.send(ev("git.result", { intentId: intent.id, action: "diff", text: await git(ctx.root, args) }));
      return;
    }
    case "git.commit": {
      const text = await git(ctx.root, ["commit", "-m", intent.message]);
      ctx.send(ev("git.result", { intentId: intent.id, action: "commit", text }));
      await emitGitState(ctx);
      return;
    }
    case "git.checkout": {
      const text = await git(ctx.root, ["checkout", intent.ref]);
      ctx.send(ev("git.result", { intentId: intent.id, action: "checkout", text }));
      await emitGitState(ctx);
      return;
    }

    case "workspace.get": {
      ctx.send(ev("workspace", { workspace: await readWorkspace(ctx.root) }));
      return;
    }
    case "workspace.set": {
      const next = WorkspaceSchema.parse({ ...(await readWorkspace(ctx.root)), ...intent.patch });
      await writeFile(
        join(projectDir(ctx.root), "workspace.json"),
        `${JSON.stringify(next, null, 2)}\n`,
      );
      ctx.broadcast(ev("workspace", { workspace: next }));
      return;
    }

    case "viewer.list":
    case "viewer.install":
      throw new Error(`${intent.type} arrives with the viewer registry (M4)`);
  }
}

/** git is shelled out to, per §1 — reliability over libraries. */
export async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await run("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    return stdout || stderr;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error((e.stderr || e.stdout || e.message).trim());
  }
}

export async function emitGitState(ctx: Ctx): Promise<void> {
  const state = await gitState(ctx.root).catch(() => undefined);
  if (state) ctx.broadcast(ev("git.changed", state));
}

export async function gitState(root: string): Promise<{ branch: string; dirty: number; ahead: number }> {
  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const status = await git(root, ["status", "--porcelain"]);
  const dirty = status.split("\n").filter((l) => l.trim()).length;
  let ahead = 0;
  try {
    const counts = await git(root, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
    ahead = Number.parseInt(counts.trim().split(/\s+/)[1] ?? "0", 10) || 0;
  } catch {
    // no upstream configured — ahead stays 0
  }
  return { branch, dirty, ahead };
}

async function readWorkspace(root: string): Promise<Workspace> {
  try {
    const raw = await readFile(join(projectDir(root), "workspace.json"), "utf8");
    return WorkspaceSchema.parse(JSON.parse(raw));
  } catch {
    return DEFAULT_WORKSPACE;
  }
}

export { basename };
