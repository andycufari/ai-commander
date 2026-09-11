import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { basename } from "node:path";
import {
  type Config, type Event, type FsEntry, type Intent, type Rules, type Workspace,
  DEFAULT_WORKSPACE, Workspace as WorkspaceSchema,
} from "@aicommander/protocol";
import { homedir } from "node:os";
import { globalDir, projectDir } from "./config.js";

/** ~/.aicommander/recents.json — repos opened before (§4). */
async function readRecents(): Promise<string[]> {
  try {
    const raw = await readFile(join(globalDir(), "recents.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}
import { resolveInRoot, toRepoPath } from "./paths.js";
import { globFiles } from "./tools.js";
import { groupOf, SessionStore } from "./sessions.js";
import { pruneSnapshots, restoreSnapshot } from "./snapshots.js";
import type { Loop } from "./loop.js";
import type { WorkspaceStore } from "./workspace.js";
import { join } from "node:path";

const run = promisify(execFile);

export interface Ctx {
  root: string;
  config: Config;
  rules: Rules;
  sessions: SessionStore;
  loop: Loop;
  workspace: WorkspaceStore;
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
    case "session.clear": {
      // Cancel anything running first: clearing under a live loop would leave the
      // turn writing into a log the user just emptied.
      ctx.loop.cancel(intent.sessionId);
      await ctx.sessions.clear(intent.sessionId);
      const meta = await ctx.sessions.readMeta(intent.sessionId);
      ctx.broadcast(ev("session.events", {
        sessionId: intent.sessionId, meta, groups: [], touched: [],
      }));
      ctx.broadcast(ev("toast", { level: "info", text: "session cleared" }));
      return;
    }

    case "permission.answer": {
      ctx.loop.resolvePermission(intent.requestId, {
        answer: intent.answer,
        editedCommand: intent.editedCommand,
      });
      return;
    }

    case "ask.answer": {
      ctx.loop.resolveAsk(intent.requestId, intent.choice);
      return;
    }

    case "session.rewind": {
      const meta = await ctx.sessions.readMeta(intent.sessionId);
      const snapshot = meta.snapshots.find((s) => s.groupId === intent.groupId);

      // Restoring the tree is what makes a rewind mean something; without a snapshot
      // only the log can be rewound, and the user should be told which happened.
      let restored: { written: number; deleted: number } | undefined;
      if (snapshot) {
        const tree = (await git(ctx.root, ["rev-parse", `${snapshot.gitRef}^{tree}`])).trim();
        restored = await restoreSnapshot(ctx.root, tree);
      }

      if (intent.mode === "fork") {
        const forked = await ctx.sessions.fork(intent.sessionId, intent.groupId);
        ctx.broadcast(ev("session.list", { sessions: await ctx.sessions.list() }));
        const entries = await ctx.sessions.read(forked.id);
        ctx.send(ev("session.events", {
          sessionId: forked.id, meta: forked,
          groups: SessionStore.toGroups(forked.id, entries),
          touched: SessionStore.touchedFiles(entries),
        }));
      } else {
        // Truncate in place: everything after this group goes, refs included.
        const keepGroups = new Set(
          SessionStore.toGroups(intent.sessionId, await ctx.sessions.upTo(intent.sessionId, intent.groupId))
            .map((g) => g.id),
        );
        for (const snap of meta.snapshots) {
          if (!keepGroups.has(snap.groupId)) {
            await pruneSnapshots(ctx.root, intent.sessionId, snap.groupId);
          }
        }
        await ctx.sessions.rewrite(intent.sessionId, (e) => {
          const g = groupOf(e);
          return g === undefined || keepGroups.has(g);
        });
        await ctx.sessions.writeMeta({
          ...meta,
          snapshots: meta.snapshots.filter((s) => keepGroups.has(s.groupId)),
        });
        await sendSession(ctx, intent.sessionId);
      }

      ctx.broadcast(ev("fs.changed", { paths: [] }));
      ctx.broadcast(ev("toast", {
        level: "info",
        text: restored
          ? `rewound · ${restored.written} files restored, ${restored.deleted} removed`
          : "rewound the conversation (no snapshot for that turn)",
      }));
      return;
    }

    case "session.dropGroup": {
      await ctx.sessions.rewrite(intent.sessionId, (e) => groupOf(e) !== intent.groupId);
      await pruneSnapshots(ctx.root, intent.sessionId, intent.groupId);
      const meta = await ctx.sessions.readMeta(intent.sessionId);
      await ctx.sessions.writeMeta({
        ...meta,
        snapshots: meta.snapshots.filter((s) => s.groupId !== intent.groupId),
      });
      await sendSession(ctx, intent.sessionId);
      return;
    }

    case "session.dropToolOutput": {
      // Keep the summaries — the shape of what happened is the useful part — and drop
      // the captured output files that made the group expensive.
      const entries = await ctx.sessions.read(intent.sessionId);
      for (const e of entries) {
        if (e.t === "tool" && e.id === intent.groupId && e.outputPath) {
          await rm(join(ctx.root, e.outputPath), { force: true }).catch(() => {});
        }
      }
      const rewritten = entries.map((e) =>
        e.t === "tool" && e.id === intent.groupId
          ? { ...e, outputPath: null, tokens: 0 }
          : e);
      await ctx.sessions.replaceLog(intent.sessionId, rewritten);
      await sendSession(ctx, intent.sessionId);
      ctx.broadcast(ev("toast", { level: "info", text: "dropped tool output" }));
      return;
    }

    case "session.compact":
      throw new Error(`${intent.type} arrives with the agent loop`);

    case "options.set":
      throw new Error("options.set arrives with the options modal (M2)");

    case "job.kill": {
      if (!ctx.loop.jobs.kill(intent.jobId)) {
        ctx.send(ev("toast", { level: "info", text: "that job is not running" }));
      }
      return;
    }

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

    case "folders.list": {
      // Directories only, and never the dot-directories — this is for picking a repo,
      // not browsing a filesystem.
      const base = intent.under ?? homedir();
      const recents = await readRecents();
      const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
      const here = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => join(base, e.name))
        .sort();
      const known = await Promise.all(
        here.map(async (p) => ({
          path: p,
          recent: false,
          known: await stat(join(p, ".aicommander")).then(() => true).catch(() => false),
        })),
      );
      ctx.send(ev("folders.listed", {
        intentId: intent.id,
        folders: [
          ...recents.map((p) => ({ path: p, recent: true, known: true })),
          ...known,
        ],
        under: base,
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
      ctx.send(ev("workspace", { workspace: await ctx.workspace.load() }));
      return;
    }
    case "workspace.set": {
      // Merged and debounced by the store; the broadcast is immediate so a second
      // client sees the change without waiting for the disk write.
      const next = await ctx.workspace.set(intent.patch);
      ctx.broadcast(ev("workspace", { workspace: next }));
      return;
    }

    case "viewer.list":
    case "viewer.install":
      throw new Error(`${intent.type} arrives with the viewer registry (M4)`);
  }
}

/**
 * git is shelled out to, per §1 — reliability over libraries.
 *
 * `env` exists for the snapshot plumbing, which sets GIT_INDEX_FILE so staging happens
 * in a private index and the user's own `git add` is never disturbed.
 */
export async function git(
  root: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  try {
    const { stdout, stderr } = await run("git", args, {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return stdout || stderr;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error((e.stderr || e.stdout || e.message).trim());
  }
}

/** Send a session's replayed state to every client. */
export async function sendSession(ctx: Ctx, sessionId: string): Promise<void> {
  const meta = await ctx.sessions.readMeta(sessionId);
  const entries = await ctx.sessions.read(sessionId);
  ctx.broadcast(ev("session.events", {
    sessionId, meta,
    groups: SessionStore.toGroups(sessionId, entries),
    touched: SessionStore.touchedFiles(entries),
  }));
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


export { basename };
