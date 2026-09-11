import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { ToolArgs, type Config, type Event, type LogEntry, type ToolResult } from "@aicommander/protocol";
import { resolveInRoot } from "./paths.js";
import { BrainClient, BrainError, type BrainMessage, type ToolSpec } from "./brain.js";
import { projectDir } from "./config.js";
import { runTool, toolSpecs, type ToolCtx } from "./tools.js";
import { SessionStore } from "./sessions.js";

/** §6 the loop. M0 covers streaming, tool calls, Esc cancel and guard 7;
 *  guards 1-6 and permissions land in M2. */

const CORE_ENABLED = [
  "read_file", "write_file", "edit_file", "glob", "grep", "shell", "git",
  "show_files", "list_skills", "read_skill",
] as const;

/** What the UI reports back about one path of a show_files request. */
export interface ShowResult {
  path: string;
  outcome: "opened" | "already-open" | "not-found";
  view?: string;
  side?: "left" | "right";
}



export interface LoopDeps {
  root: string;
  config: Config;
  sessions: SessionStore;
  emit: (event: Event) => void;
}

const ev = <T extends Event["type"]>(type: T, payload: Omit<Extract<Event, { type: T }>, "id" | "type">) =>
  ({ id: randomUUID(), type, ...payload }) as Extract<Event, { type: T }>;

interface Running {
  controller: AbortController;
  startedAt: number;
  toolCount: number;
  /** Guard 5: a message sent while running lands at the next tool boundary. */
  queued: string[];
}

export class Loop {
  private readonly running = new Map<string, Running>();
  /** show_files calls waiting for the UI to report what it did with each path. */
  private readonly showWaits = new Map<string, (r: ShowResult[]) => void>();

  constructor(private readonly deps: LoopDeps) {}

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  /** Esc: cancel the current tool and stop the loop, keeping partial text (§6 guard 5). */
  cancel(sessionId: string): boolean {
    const run = this.running.get(sessionId);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  /** The UI answering a show_files request (§5). */
  resolveShow(requestId: string, results: ShowResult[], side?: "left" | "right"): boolean {
    const waiter = this.showWaits.get(requestId);
    if (!waiter) return false;
    this.showWaits.delete(requestId);
    waiter(results.map((r) => ({ ...r, side })));
    return true;
  }

  /**
   * §5 show_files. The brain names paths; the app decides how each is displayed, so
   * nothing here knows what a .stl or a .kicad_sch is. Existence is checked first, so
   * "not found" is authoritative rather than a UI guess, and the loop still reports
   * something if the UI never answers.
   */
  private async showFiles(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const parsed = ToolArgs.show_files.safeParse(args);
    if (!parsed.success) {
      return {
        ok: false,
        summary: "bad arguments",
        content: `show_files takes { paths: string[] } with 1-5 entries. ${parsed.error.issues[0]?.message ?? ""}`,
        truncated: false,
      };
    }

    const missing: string[] = [];
    const openable: string[] = [];
    for (const path of parsed.data.paths) {
      try {
        const abs = await resolveInRoot(this.deps.root, path);
        const info = await stat(abs);
        if (info.isFile()) openable.push(path);
        else missing.push(path);
      } catch {
        missing.push(path);
      }
    }

    if (openable.length === 0) {
      return {
        ok: false,
        summary: `no such file${missing.length === 1 ? "" : "s"}`,
        content: `Could not show ${missing.join(", ")} — no such file in the repo.`,
        truncated: false,
      };
    }

    const requestId = randomUUID().slice(0, 8);
    const results = await new Promise<ShowResult[]>((resolve) => {
      const fallback = (): ShowResult[] =>
        openable.map((path) => ({ path, outcome: "opened" as const }));
      const timer = setTimeout(() => {
        this.showWaits.delete(requestId);
        resolve(fallback());
      }, 3000);
      const onAbort = (): void => {
        clearTimeout(timer);
        this.showWaits.delete(requestId);
        resolve(fallback());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.showWaits.set(requestId, (r) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(r);
      });
      this.deps.emit(ev("show_files", { paths: openable, target: "other", requestId }));
    });

    const side = results[0]?.side;
    const where = side ? `the ${side} panel` : "the other panel";
    const opened = results.filter((r) => r.outcome === "opened").map((r) => r.path);
    const already = results.filter((r) => r.outcome === "already-open").map((r) => r.path);
    const failed = [...missing, ...results.filter((r) => r.outcome === "not-found").map((r) => r.path)];

    const lines: string[] = [];
    if (opened.length) lines.push(`Showing ${opened.join(", ")} in ${where}.`);
    if (already.length) lines.push(`${already.join(", ")} was already open; brought to the front.`);
    if (failed.length) lines.push(`Could not show ${failed.join(", ")} — no such file.`);
    lines.push("The user can see these now; they do not need you to paste the contents.");

    const shown = opened.length + already.length;
    return {
      ok: shown > 0,
      summary: failed.length
        ? `showed ${shown}, ${failed.length} missing`
        : `showed ${shown} file${shown === 1 ? "" : "s"}`,
      content: lines.join(" "),
      truncated: false,
    };
  }

  /** A message sent while the loop runs is queued, not dropped (§6 guard 5). */
  queue(sessionId: string, text: string): boolean {
    const run = this.running.get(sessionId);
    if (!run) return false;
    run.queued.push(text);
    this.state(sessionId, "running", run);
    return true;
  }

  async send(sessionId: string, text: string): Promise<void> {
    if (this.running.has(sessionId)) {
      this.queue(sessionId, text);
      return;
    }

    const { root, config, sessions, emit } = this.deps;
    const meta = await sessions.readMeta(sessionId);
    const controller = new AbortController();
    const run: Running = { controller, startedAt: Date.now(), toolCount: 0, queued: [] };
    this.running.set(sessionId, run);

    const groupId = `g${Date.now().toString(36)}`;
    const brain = new BrainClient(config.brain);
    const specs: ToolSpec[] = toolSpecs(CORE_ENABLED);

    await sessions.append(sessionId, {
      t: "user", id: groupId, ts: Date.now(), text, attachments: [],
    });
    emit(ev("turn.start", { sessionId, groupId, role: "user" }));
    this.state(sessionId, "running", run);

    // M0 context: system prompt + replayed history. The full §7 assembler lands in M3.
    const messages: BrainMessage[] = [
      { role: "system", content: systemPrompt(root) },
      ...(await replay(sessions, sessionId, groupId)),
      { role: "user", content: text },
    ];

    let cancelled = false;
    try {
      for (let turn = 0; turn < config.loop.maxTurnsPerPrompt; turn += 1) {
        emit(ev("turn.start", { sessionId, groupId, role: "brain" }));

        let streamed = "";
        const result = await brain.complete(messages, specs, {
          signal: controller.signal,
          onText: (delta) => {
            streamed += delta;
            emit(ev("token", { sessionId, groupId, delta }));
          },
        });

        await sessions.append(sessionId, {
          t: "brain", id: groupId, ts: Date.now(), text: result.text, toolCalls: result.toolCalls,
        });

        if (result.toolCalls.length === 0) break;

        messages.push({
          role: "assistant",
          content: result.text,
          tool_calls: result.toolCalls.map((c) => ({
            id: c.callId,
            type: "function" as const,
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        });

        for (const call of result.toolCalls) {
          if (controller.signal.aborted) {
            cancelled = true;
            break;
          }
          if (run.toolCount >= config.loop.maxToolCallsPerTurn) {
            messages.push(toolMessage(call.callId, call.name,
              `Stopped: this turn hit the ${config.loop.maxToolCallsPerTurn} tool call limit.`));
            break;
          }

          run.toolCount += 1;
          emit(ev("tool.start", { sessionId, groupId, callId: call.callId, name: call.name, args: call.args }));

          const ctx: ToolCtx = {
            root,
            config,
            callId: call.callId,
            signal: controller.signal,
            onOutput: (delta) => emit(ev("tool.output", { callId: call.callId, delta })),
            outPath: (id) => join(projectDir(root), "out", `${id}.txt`),
          };

          const res: ToolResult =
            call.name === "show_files"
              ? await this.showFiles(call.args, controller.signal)
              : await runTool(call.name, call.args, ctx);

          emit(ev("tool.end", {
            callId: call.callId,
            ok: res.ok,
            summary: res.summary,
            outputPath: res.outputPath,
            truncated: res.truncated,
          }));
          await sessions.append(sessionId, {
            t: "tool", id: groupId, ts: Date.now(), callId: call.callId, name: call.name,
            args: call.args, ok: res.ok, summary: res.summary,
            outputPath: res.outputPath ?? null, tokens: estimate(res.content),
          });
          messages.push(toolMessage(call.callId, call.name, res.content));
          this.state(sessionId, "running", run);
        }

        if (cancelled || controller.signal.aborted) {
          cancelled = true;
          break;
        }

        // Guard 5: queued messages are injected at the tool boundary, before the next turn.
        while (run.queued.length) {
          messages.push({ role: "user", content: run.queued.shift()! });
        }
      }
    } catch (err) {
      if (controller.signal.aborted || (err as Error).name === "AbortError") {
        cancelled = true;
      } else {
        const message = err instanceof BrainError ? err.message : `loop failed: ${(err as Error).message}`;
        emit(ev("toast", { level: "warning", text: message }));
        emit(ev("error", { message }));
      }
    } finally {
      if (cancelled) {
        await sessions.append(sessionId, { t: "cancel", ts: Date.now(), group: groupId });
      }
      this.running.delete(sessionId);
      this.state(sessionId, cancelled ? "cancelled" : "idle", run);
      // The turn may have touched files; refresh the ⌃⇧P list rather than leaving the
      // UI with what it had at session open.
      try {
        const entries = await sessions.read(sessionId);
        emit(ev("session.events", {
          sessionId,
          meta: await sessions.readMeta(sessionId),
          groups: SessionStore.toGroups(sessionId, entries),
          touched: SessionStore.touchedFiles(entries),
        }));
      } catch {
        // a session deleted mid-turn: nothing to refresh
      }
    }
  }

  private state(sessionId: string, status: "idle" | "running" | "cancelled", run: Running): void {
    this.deps.emit(ev("session.state", {
      sessionId,
      status,
      ctxUsed: 0,
      ctxMax: this.deps.config.brain.ctx,
      toolCount: run.toolCount,
      elapsed: (Date.now() - run.startedAt) / 1000,
      ...(run.queued.length ? { queued: run.queued.join("\n") } : {}),
    }));
  }
}

const toolMessage = (callId: string, name: string, content: string): BrainMessage => ({
  role: "tool",
  tool_call_id: callId,
  name,
  content,
});

/** Rough token estimate until the real accounting lands in M3. */
const estimate = (text: string): number => Math.ceil(text.length / 4);

/** Replay prior groups into API messages. The §7 assembler replaces this in M3. */
async function replay(
  sessions: SessionStore,
  sessionId: string,
  currentGroup: string,
): Promise<BrainMessage[]> {
  const entries = await sessions.read(sessionId);
  const out: BrainMessage[] = [];
  for (const e of entries as LogEntry[]) {
    if ("id" in e && e.id === currentGroup) continue;
    if (e.t === "user") out.push({ role: "user", content: e.text });
    else if (e.t === "brain" && e.text) out.push({ role: "assistant", content: e.text });
  }
  return out;
}

/** M0 placeholder for `.aicommander/system.md` — the real manual ships in M3. */
function systemPrompt(root: string): string {
  return [
    "You are the brain of AI Commander, a local-first harness for iterating on a repo.",
    `The repo root is ${root}. Every path you use is relative to it; you cannot read or write outside it.`,
    "",
    "Use the tools to look before you answer: glob and grep to find things, read_file to read them.",
    "Prefer edit_file over write_file for changes to an existing file.",
    "Keep replies short. The user sees your tool calls, so do not narrate them.",
  ].join("\n");
}

export { CORE_ENABLED };
