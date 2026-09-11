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
  "open_in_panel", "list_skills", "read_skill",
] as const;

/** What the UI reports back about an open_in_panel request. */
export interface PanelOutcome {
  outcome: "opened" | "already-open" | "not-found";
  side?: "left" | "right";
  view?: string;
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
  /** open_in_panel calls waiting for the UI to say what it did. */
  private readonly panelWaits = new Map<string, (r: PanelOutcome) => void>();

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

  /** The UI answering an open_in_panel request (§5). */
  resolvePanel(requestId: string, outcome: PanelOutcome): boolean {
    const waiter = this.panelWaits.get(requestId);
    if (!waiter) return false;
    this.panelWaits.delete(requestId);
    waiter(outcome);
    return true;
  }

  /**
   * open_in_panel runs here rather than in tools.ts: only the UI knows which panel is
   * focused and what is already open, so the tool emits an event and waits for the
   * answer. A UI that never replies must not wedge the loop, hence the timeout.
   */
  private async openInPanel(
    sessionId: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const parsed = ToolArgs.open_in_panel.safeParse(args);
    if (!parsed.success) {
      return { ok: false, summary: "bad arguments", content: parsed.error.message, truncated: false };
    }
    const { path, mode, viewer } = parsed.data;

    // Check the file before asking the UI, so "not found" is authoritative.
    try {
      const abs = await resolveInRoot(this.deps.root, path);
      const info = await stat(abs);
      if (!info.isFile()) {
        return { ok: false, summary: `${path} is not a file`, content: `${path} is a directory.`, truncated: false };
      }
    } catch (err) {
      return {
        ok: false,
        summary: `no such file: ${path}`,
        content: err instanceof Error ? err.message : `Cannot open ${path}.`,
        truncated: false,
      };
    }

    const requestId = randomUUID().slice(0, 8);
    const outcome = await new Promise<PanelOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.panelWaits.delete(requestId);
        resolve({ outcome: "opened" });
      }, 3000);
      const onAbort = (): void => {
        clearTimeout(timer);
        this.panelWaits.delete(requestId);
        resolve({ outcome: "opened" });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.panelWaits.set(requestId, (r) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(r);
      });
      this.deps.emit(ev("open_in_panel", { path, mode: mode ?? "view", viewer, target: "other", requestId }));
    });

    const where = outcome.side ? `the ${outcome.side} panel` : "the other panel";
    switch (outcome.outcome) {
      case "already-open":
        return {
          ok: true,
          summary: `${path} already open`,
          content: `${path} was already open in ${where}; brought it to the front.`,
          truncated: false,
        };
      case "not-found":
        return {
          ok: false,
          summary: `could not open ${path}`,
          content: `The user interface could not open ${path}.`,
          truncated: false,
        };
      default:
        return {
          ok: true,
          summary: `opened ${path}`,
          content: `${path} is now showing in ${where}. The user can see it.`,
          truncated: false,
        };
    }
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
            call.name === "open_in_panel"
              ? await this.openInPanel(sessionId, call.args, controller.signal)
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
