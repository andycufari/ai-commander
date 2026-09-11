import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import {
  ToolArgs, type Config, type Event, type LogEntry, type Rules, type ToolResult,
} from "@aicommander/protocol";
import { check } from "./permissions.js";
import { ErrorGuard, RepeatGuard } from "./guards.js";
import { JobRegistry } from "./jobs.js";
import { takeSnapshot } from "./snapshots.js";
import { resolveInRoot } from "./paths.js";
import { BrainClient, BrainError, type BrainMessage, type ToolSpec } from "./brain.js";
import { projectDir } from "./config.js";
import { runTool, toolSpecs, type ToolCtx } from "./tools.js";
import { SessionStore } from "./sessions.js";

/** §6 the loop. M0 covers streaming, tool calls, Esc cancel and guard 7;
 *  guards 1-6 and permissions land in M2. */

const CORE_ENABLED = [
  "read_file", "write_file", "edit_file", "glob", "grep", "shell", "job", "git",
  "show_files", "ask_user", "list_skills", "read_skill",
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
  rules: Rules;
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
  /** Rules the user answered "allow for this session" on (§8). */
  allowedRules: Set<string>;
  /** Guard 1: identical calls in a row. */
  repeat: RepeatGuard;
  /** Guard 2: failures in a row. */
  errors: ErrorGuard;
}

/** The user's answer to a permission ask. */
export interface PermissionReply {
  answer: "once" | "session" | "deny";
  /** Set when the user rewrote the command before allowing it. */
  editedCommand?: string;
}

export class Loop {
  private readonly running = new Map<string, Running>();
  /** Permission asks waiting for the user (§8). */
  private readonly permissionWaits = new Map<string, (a: PermissionReply) => void>();
  /** "Allow for this session" survives between turns of the same session. */
  private readonly sessionAllowances = new Map<string, Set<string>>();
  /** ask_user and guard pauses waiting for an answer. */
  private readonly askWaits = new Map<string, (choice: string) => void>();
  /** Guard 4: background jobs, keyed by id. Shared across sessions. */
  readonly jobs: JobRegistry;
  /** Sessions already told their snapshots are slow; said once, never nagged. */
  private readonly slowSnapshotWarned = new Set<string>();
  /** show_files calls waiting for the UI to report what it did with each path. */
  private readonly showWaits = new Map<string, (r: ShowResult[]) => void>();

  constructor(private readonly deps: LoopDeps) {
    this.jobs = new JobRegistry(deps.emit);
  }

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

  /** The user answering ask_user, or a guard pause (§6). */
  resolveAsk(requestId: string, choice: string): boolean {
    const waiter = this.askWaits.get(requestId);
    if (!waiter) return false;
    this.askWaits.delete(requestId);
    waiter(choice);
    return true;
  }

  /**
   * Put a question to the user and wait. This is `ask_user` (§5) and also how guards 1
   * and 2 pause — a stuck loop and a model that wants a decision are the same event as
   * far as the user is concerned, so they use the same modal.
   */
  private async ask(
    sessionId: string,
    question: string,
    options: string[],
    signal: AbortSignal,
  ): Promise<string> {
    const requestId = randomUUID().slice(0, 8);
    return new Promise<string>((resolve) => {
      const onAbort = (): void => {
        this.askWaits.delete(requestId);
        // Cancelling a pause means stop, which is the conservative reading.
        resolve(options[options.length - 1] ?? "stop");
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.askWaits.set(requestId, (choice) => {
        signal.removeEventListener("abort", onAbort);
        resolve(choice);
      });
      this.deps.emit(ev("ask.request", { requestId, sessionId, question, options }));
    });
  }

  /** The user answering a permission ask (§8). */
  resolvePermission(requestId: string, reply: PermissionReply): boolean {
    const waiter = this.permissionWaits.get(requestId);
    if (!waiter) return false;
    this.permissionWaits.delete(requestId);
    waiter(reply);
    return true;
  }

  /**
   * §8: decide whether a call may run, asking the user when a rule says so.
   *
   * A pending ask holds the loop — that is the point — but Esc must still cancel it,
   * so the abort signal resolves the wait as a denial rather than leaving it hanging.
   */
  private async permit(
    sessionId: string,
    run: Running,
    call: { callId: string; name: string; args: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<{ ok: true; args: Record<string, unknown> } | { ok: false; reason: string }> {
    const decision = check({
      tool: call.name,
      args: call.args,
      rules: this.deps.rules,
      mode: this.deps.config.mode,
      sessionAllowed: run.allowedRules,
    });

    if (decision.kind === "allow") return { ok: true, args: call.args };
    if (decision.kind === "deny") return { ok: false, reason: decision.reason };

    const requestId = randomUUID().slice(0, 8);
    this.deps.emit(ev("permission.request", {
      requestId,
      sessionId,
      tool: call.name,
      command: decision.command,
      rule: decision.rule.id,
      reason: decision.reason,
      level: decision.level,
    }));

    const reply = await new Promise<PermissionReply>((resolve) => {
      const onAbort = (): void => {
        this.permissionWaits.delete(requestId);
        resolve({ answer: "deny" });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.permissionWaits.set(requestId, (r) => {
        signal.removeEventListener("abort", onAbort);
        resolve(r);
      });
    });

    await this.deps.sessions.append(sessionId, {
      t: "permission", ts: Date.now(), callId: call.callId,
      rule: decision.rule.id, answer: reply.answer,
    });

    if (reply.answer === "deny") {
      // The model is told the rule's own words, so it can choose a different approach
      // rather than retrying the same blocked command (§8).
      return { ok: false, reason: `Denied by the user: ${decision.reason}.` };
    }
    if (reply.answer === "session") run.allowedRules.add(decision.rule.id);

    // "edit" hands back a command the user rewrote; run that instead.
    const args = reply.editedCommand !== undefined && call.name === "shell"
      ? { ...call.args, cmd: reply.editedCommand }
      : call.args;
    return { ok: true, args };
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

  /** §5 ask_user: the model asks, the loop pauses, the answer comes back as a result. */
  private async askUser(
    sessionId: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const parsed = ToolArgs.ask_user.safeParse(args);
    if (!parsed.success) {
      return {
        ok: false, summary: "bad arguments", truncated: false,
        content: "ask_user takes { question: string, options: string[] }.",
      };
    }
    const choice = await this.ask(sessionId, parsed.data.question, parsed.data.options, signal);
    return {
      ok: true,
      summary: `answered: ${choice}`,
      content: `The user chose: ${choice}`,
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
    const run: Running = {
      controller, startedAt: Date.now(), toolCount: 0, queued: [],
      // Session allowances persist across turns within one session.
      allowedRules: this.sessionAllowances.get(sessionId) ?? new Set(),
      // Guard counters are per group: a new user turn is a fresh start.
      repeat: new RepeatGuard(config.loop.repeatGuard),
      errors: new ErrorGuard(config.loop.errorGuard),
    };
    this.sessionAllowances.set(sessionId, run.allowedRules);
    this.running.set(sessionId, run);

    const groupId = `g${Date.now().toString(36)}`;
    const brain = new BrainClient(config.brain);
    const specs: ToolSpec[] = toolSpecs(CORE_ENABLED);

    await sessions.append(sessionId, {
      t: "user", id: groupId, ts: Date.now(), text, attachments: [],
    });
    emit(ev("turn.start", { sessionId, groupId, role: "user" }));
    this.state(sessionId, "running", run);

    // Guard 6: snapshot before the brain touches anything, so this turn can be undone.
    const snap = await takeSnapshot(root, sessionId, groupId);
    if (snap) {
      await sessions.append(sessionId, {
        t: "snapshot", ts: Date.now(), group: groupId, ref: snap.ref,
      });
      const meta = await sessions.readMeta(sessionId);
      await sessions.writeMeta({
        ...meta,
        snapshots: [...meta.snapshots, { groupId, gitRef: snap.ref }],
      });
      emit(ev("snapshot", {
        sessionId, groupId, ref: snap.ref, bytes: snap.bytes, ms: snap.ms,
      }));
      // A slow snapshot means something large is being captured that probably should
      // not be. Said once per session — a repeated nag would just be noise.
      if (snap.ms > 2000 && !this.slowSnapshotWarned.has(sessionId)) {
        this.slowSnapshotWarned.add(sessionId);
        emit(ev("toast", {
          level: "warning",
          text: `snapshots are taking ${(snap.ms / 1000).toFixed(1)}s — a .gitignore entry for large or generated files would speed this up`,
        }));
      }
    }

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

          // Guard 1: the same call, over and over, is not progress.
          if (run.repeat.record(call.name, call.args)) {
            const choice = await this.ask(
              sessionId,
              `${call.name} has been called ${run.repeat.repeats} times with the same arguments. ` +
                `The loop may be stuck.`,
              ["continue", "stop", "tell it something"],
              controller.signal,
            );
            run.repeat.forgive();
            if (choice === "stop") { cancelled = true; break; }
            if (choice.startsWith("tell")) {
              const note = await this.ask(
                sessionId, "What should it do instead?", ["__input"], controller.signal,
              );
              messages.push({ role: "user", content: note });
              break;
            }
          }
          if (run.toolCount >= config.loop.maxToolCallsPerTurn) {
            messages.push(toolMessage(call.callId, call.name,
              `Stopped: this turn hit the ${config.loop.maxToolCallsPerTurn} tool call limit.`));
            break;
          }

          // §8: permission before anything runs.
          const permitted = await this.permit(sessionId, run, call, controller.signal);
          if (!permitted.ok) {
            emit(ev("tool.end", {
              callId: call.callId, ok: false, summary: "blocked", truncated: false,
            }));
            await sessions.append(sessionId, {
              t: "tool", id: groupId, ts: Date.now(), callId: call.callId, name: call.name,
              args: call.args, ok: false, summary: "blocked", outputPath: null, tokens: 0,
            });
            messages.push(toolMessage(call.callId, call.name, permitted.reason));
            continue;
          }
          const args = permitted.args;

          run.toolCount += 1;
          emit(ev("tool.start", { sessionId, groupId, callId: call.callId, name: call.name, args }));

          const ctx: ToolCtx = {
            root,
            config,
            callId: call.callId,
            signal: controller.signal,
            onOutput: (delta) => emit(ev("tool.output", { callId: call.callId, delta })),
            outPath: (id) => join(projectDir(root), "out", `${id}.txt`),
            // Guard 4: a timed-out shell becomes a job rather than a corpse.
            adopt: (child, cmd, existing) => this.jobs.adopt(child, cmd, sessionId, existing),
            jobs: this.jobs,
          };

          const res: ToolResult =
            call.name === "show_files"
              ? await this.showFiles(args, controller.signal)
              : call.name === "ask_user"
                ? await this.askUser(sessionId, args, controller.signal)
                : await runTool(call.name, args, ctx);

          emit(ev("tool.end", {
            callId: call.callId,
            ok: res.ok,
            summary: res.summary,
            outputPath: res.outputPath,
            truncated: res.truncated,
          }));
          await sessions.append(sessionId, {
            t: "tool", id: groupId, ts: Date.now(), callId: call.callId, name: call.name,
            args, ok: res.ok, summary: res.summary,
            outputPath: res.outputPath ?? null, tokens: estimate(res.content),
          });
          messages.push(toolMessage(call.callId, call.name, res.content));
          this.state(sessionId, "running", run);

          // Guard 2: a run of failures means the model is not learning from them.
          if (run.errors.record(res.ok)) {
            const choice = await this.ask(
              sessionId,
              `${run.errors.errors} tool calls in a row have failed. The loop may be stuck.`,
              ["continue", "stop", "tell it something"],
              controller.signal,
            );
            run.errors.forgive();
            if (choice === "stop") { cancelled = true; break; }
            if (choice.startsWith("tell")) {
              const note = await this.ask(
                sessionId, "What should it do instead?", ["__input"], controller.signal,
              );
              messages.push({ role: "user", content: note });
              break;
            }
          }
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
