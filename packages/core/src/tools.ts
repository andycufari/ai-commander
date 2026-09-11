import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { zodToJsonSchema } from "./jsonschema.js";
import { capText } from "./guards.js";
import type { JobRegistry } from "./jobs.js";
import {
  ToolArgs, TOOL_DESCRIPTIONS, type Config, type ToolResult,
} from "@aicommander/protocol";
import { git } from "./intents.js";
import { resolveInRoot, toRepoPath } from "./paths.js";
import type { ToolSpec } from "./brain.js";

/** §5 core tools. `ask_user`, `open_in_panel` and `job` need the loop's plumbing,
 *  so they are declared here and executed by the loop itself. */

export interface ToolCtx {
  root: string;
  config: Config;
  /** Streams shell output to the UI as it arrives. */
  onOutput?: (delta: string) => void;
  signal?: AbortSignal;
  /** Where over-cap output is written: `.aicommander/out/<callId>.txt`. */
  outPath: (callId: string) => string;
  callId: string;
  /** Guard 4: adopt a timed-out child as a background job, returning its id. */
  adopt?: (child: ChildProcess, cmd: string, existingOutput: string) => string;
  /** The job registry, for the `job` tool. */
  jobs?: JobRegistry;
}

const ok = (summary: string, content: string): ToolResult =>
  ({ ok: true, summary, content, truncated: false });
const fail = (summary: string, content = summary): ToolResult =>
  ({ ok: false, summary, content, truncated: false });

/** Guard 3 (§5/§6): cap output, head 60% / tail 40%, full text to out/<callId>.txt. */
export async function capOutput(
  text: string,
  ctx: ToolCtx,
): Promise<{ content: string; outputPath?: string; truncated: boolean }> {
  const cap = ctx.config.loop.toolOutputCap;
  if (text.length <= cap) return { content: text, truncated: false };

  const head = Math.floor(cap * 0.6);
  const tail = cap - head;
  const path = ctx.outPath(ctx.callId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  const rel = toRepoPath(ctx.root, path);
  const omitted = text.length - head - tail;
  return {
    content:
      `${text.slice(0, head)}\n\n… ${omitted} characters omitted — full output at ${rel} …\n\n${text.slice(-tail)}`,
    outputPath: rel,
    truncated: true,
  };
}

const withCap = async (text: string, summary: string, ctx: ToolCtx): Promise<ToolResult> => {
  const { content, outputPath, truncated } = await capOutput(text, ctx);
  return { ok: true, summary, content, outputPath, truncated };
};

export async function runTool(
  name: string,
  rawArgs: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<ToolResult> {
  // Guard 7: a call the stream could not parse arrives with this marker instead of args.
  if (typeof rawArgs.__parseError === "string") {
    return fail(
      "malformed arguments",
      `Your ${name} call could not be parsed: ${rawArgs.__parseError}. ` +
        `Re-send it as a single valid JSON object.`,
    );
  }

  try {
    switch (name) {
      case "read_file": {
        const a = ToolArgs.read_file.parse(rawArgs);
        const abs = await resolveInRoot(ctx.root, a.path);
        const info = await stat(abs).catch(() => undefined);
        if (!info) return fail(`no such file: ${a.path}`);
        if (info.isDirectory()) return fail(`${a.path} is a directory — use glob`);
        const raw = await readFile(abs, "utf8");
        // A file ending in a newline splits to a trailing empty element that is not a line.
        const lines = raw.split("\n");
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        const from = a.range ? Math.max(1, a.range.start) : 1;
        const to = a.range ? Math.min(lines.length, a.range.end) : lines.length;
        const body = lines
          .slice(from - 1, to)
          .map((l, i) => `${String(from + i).padStart(5)}  ${l}`)
          .join("\n");
        return withCap(body, `${to - from + 1} lines`, ctx);
      }

      case "write_file": {
        const a = ToolArgs.write_file.parse(rawArgs);
        const abs = await resolveInRoot(ctx.root, a.path);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, a.content);
        const parts = a.content.split("\n");
        const n = parts.length > 1 && parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
        return ok(`wrote ${a.path} (${n} lines)`, `Wrote ${n} lines to ${a.path}.`);
      }

      case "edit_file": {
        const a = ToolArgs.edit_file.parse(rawArgs);
        const abs = await resolveInRoot(ctx.root, a.path);
        const before = await readFile(abs, "utf8").catch(() => undefined);
        if (before === undefined) return fail(`no such file: ${a.path}`);
        const count = before.split(a.old).length - 1;
        if (count === 0) {
          return fail(
            `no match in ${a.path}`,
            `The exact text was not found in ${a.path}. Read the file and match it byte for byte.`,
          );
        }
        if (count > 1 && !a.all) {
          return fail(
            `${count} matches in ${a.path}`,
            `Found ${count} occurrences in ${a.path}. Pass a longer unique \`old\`, or set \`all: true\`.`,
          );
        }
        const after = a.all ? before.split(a.old).join(a.new) : before.replace(a.old, a.new);
        await writeFile(abs, after);
        return ok(
          `edited ${a.path} (${a.all ? count : 1} replacement${a.all && count > 1 ? "s" : ""})`,
          `${diff(a.path, before, after)}`,
        );
      }

      case "glob": {
        const a = ToolArgs.glob.parse(rawArgs);
        const hits = await globFiles(ctx.root, a.pattern);
        return withCap(hits.join("\n") || "(no matches)", `${hits.length} files`, ctx);
      }

      case "grep": {
        const a = ToolArgs.grep.parse(rawArgs);
        const text = await grep(ctx, a.pattern, a.path, a.glob);
        const n = text ? text.split("\n").filter(Boolean).length : 0;
        return withCap(text || "(no matches)", `${n} matches`, ctx);
      }

      case "shell": {
        const a = ToolArgs.shell.parse(rawArgs);
        return await runShell(a.cmd, a.cwd, a.timeout, ctx);
      }

      case "job": {
        const a = ToolArgs.job.parse(rawArgs);
        if (!ctx.jobs) return fail("no jobs in this context");
        const job = ctx.jobs.get(a.jobId);
        if (!job) return fail(`no such job: ${a.jobId}`);
        switch (a.action) {
          case "status":
            return ok(
              job.running ? `job ${a.jobId} running` : `job ${a.jobId} exit ${job.exitCode}`,
              job.running
                ? `Job ${a.jobId} (${job.cmd}) is still running after ` +
                  `${Math.round((Date.now() - job.startedAt) / 1000)}s.`
                : `Job ${a.jobId} (${job.cmd}) finished with exit code ${job.exitCode}` +
                  `${job.killed ? " after being killed" : ""}.`,
            );
          case "output": {
            const tail = ctx.jobs.output(a.jobId) ?? "";
            return withCap(tail || "(no output yet)", `${tail.split("\n").length} lines`, ctx);
          }
          case "kill":
            return ctx.jobs.kill(a.jobId)
              ? ok(`killed ${a.jobId}`, `Sent SIGTERM to job ${a.jobId}.`)
              : fail(`job ${a.jobId} is not running`);
          default:
            return fail(`unknown job action`);
        }
      }

      case "git": {
        const a = ToolArgs.git.parse(rawArgs) as { action: string } & Record<string, unknown>;
        const argv = gitArgv(a);
        const text = await git(ctx.root, argv);
        return withCap(text || "(no output)", `git ${a.action}`, ctx);
      }

      case "list_skills": {
        const skills = await listSkills(ctx.root);
        return ok(
          `${skills.length} skills`,
          skills.length ? skills.map((s) => `${s.name} — ${s.description}`).join("\n") : "No skills.",
        );
      }

      case "read_skill": {
        const a = ToolArgs.read_skill.parse(rawArgs);
        const abs = await resolveInRoot(ctx.root, join("skills", a.name, "SKILL.md"));
        const body = await readFile(abs, "utf8").catch(() => undefined);
        if (body === undefined) return fail(`no such skill: ${a.name}`);
        return withCap(body, `skill ${a.name}`, ctx);
      }

      default:
        return fail(`unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message.split("\n")[0] ?? "error", message);
  }
}

/** A readable unified-ish diff for the model and the UI. Full rewrite is fine for v1. */
function diff(path: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: string[] = [`--- ${path}`, `+++ ${path}`];
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j += 1;
  for (const line of a.slice(i, a.length - j)) out.push(`-${line}`);
  for (const line of b.slice(i, b.length - j)) out.push(`+${line}`);
  return out.join("\n");
}

function gitArgv(a: { action: string } & Record<string, unknown>): string[] {
  const s = (k: string): string | undefined => (typeof a[k] === "string" ? (a[k] as string) : undefined);
  switch (a.action) {
    case "status": return ["status", "--short", "--branch"];
    case "log": return ["log", `-n${Number(a.n ?? 20)}`, "--oneline", "--no-color"];
    case "diff": return s("path") ? ["diff", "--no-color", "--", s("path")!] : ["diff", "--no-color"];
    case "add": return ["add", s("path") ?? "-A"];
    case "commit": return ["commit", "-m", s("message") ?? "update"];
    case "checkout": return ["checkout", s("ref") ?? s("branch") ?? "-"];
    case "branch": return s("name") ? ["branch", s("name")!] : ["branch", "--show-current"];
    case "stash": return ["stash", ...(s("sub") ? [s("sub")!] : [])];
    case "push": return ["push", ...(s("remote") ? [s("remote")!] : [])];
    default: throw new Error(`unknown git action: ${a.action}`);
  }
}

/** §5: ripgrep if present, else JS. */
async function grep(ctx: ToolCtx, pattern: string, path?: string, glob?: string): Promise<string> {
  const args = ["--line-number", "--no-heading", "--color=never", pattern];
  if (glob) args.push("--glob", glob);
  args.push(path ?? ".");
  const rg = await tryRun("rg", args, ctx.root);
  if (rg !== undefined) return rg;

  // Fallback: walk and match in JS.
  const re = new RegExp(pattern);
  const files = await globFiles(ctx.root, glob ?? "**/*");
  const out: string[] = [];
  for (const rel of files) {
    if (path && !rel.startsWith(path.replace(/^\.\//, ""))) continue;
    const body = await readFile(join(ctx.root, rel), "utf8").catch(() => undefined);
    if (body === undefined) continue;
    body.split("\n").forEach((line, i) => {
      if (re.test(line)) out.push(`${rel}:${i + 1}:${line}`);
    });
    if (out.length > 5000) return out.join("\n");
  }
  return out.join("\n");
}

const tryRun = (cmd: string, args: string[], cwd: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => resolve(code === 0 || code === 1 ? out : undefined));
  });

const IGNORED = new Set(["node_modules", ".git", "dist", ".aicommander"]);

/** Minimal glob: supports **, * and ? — enough for v1, no dependency. */
export async function globFiles(root: string, pattern: string): Promise<string[]> {
  const re = globToRegExp(pattern);
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (IGNORED.has(e.name)) continue;
      const abs = join(dir, e.name);
      const rel = toRepoPath(root, abs);
      if (e.isDirectory()) await walk(abs);
      else if (re.test(rel)) out.push(rel);
      if (out.length > 20000) return;
    }
  };
  await walk(root);
  return out.sort();
}

export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more directories; bare `**` matches anything.
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if ("\\^$.|+()[]{}".includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

async function listSkills(root: string): Promise<{ name: string; description: string }[]> {
  const dir = join(root, "skills");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: { name: string; description: string }[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const body = await readFile(join(dir, e.name, "SKILL.md"), "utf8").catch(() => undefined);
    if (body === undefined) continue;
    const fm = /^---\n([\s\S]*?)\n---/.exec(body);
    const desc = fm ? /description:\s*(.+)/.exec(fm[1]!)?.[1]?.trim() : undefined;
    out.push({ name: e.name, description: desc ?? "" });
  }
  return out;
}

/**
 * Guard 4 (§6): on timeout the process is NOT killed — it becomes a background job.
 *
 * Killing `npm run dev` after two minutes would be the wrong answer: it was meant to
 * keep running. The loop supplies `adopt`, which re-parents the live child into the
 * job registry and hands back a jobId the model can poll.
 */
export async function runShell(
  cmd: string,
  cwd: string | undefined,
  timeoutSec: number | undefined,
  ctx: ToolCtx,
): Promise<ToolResult> {
  const dir = cwd ? await resolveInRoot(ctx.root, cwd) : ctx.root;
  const limit = (timeoutSec ?? ctx.config.loop.shellTimeoutSec) * 1000;

  return new Promise<ToolResult>((resolve) => {
    const child = spawn(cmd, { cwd: dir, shell: true });
    let out = "";
    let settled = false;

    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const collect = (d: Buffer): void => {
      const s = d.toString();
      out += s;
      ctx.onOutput?.(s);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timer = setTimeout(() => {
      if (!ctx.adopt) {
        // No registry (a bare tool call in a test): report the timeout and stop.
        child.kill("SIGKILL");
        void capOutput(out, ctx).then((c) =>
          finish({
            ok: false,
            summary: `timed out after ${limit / 1000}s`,
            content: `Command timed out after ${limit / 1000}s.\n\n${c.content}`,
            outputPath: c.outputPath,
            truncated: c.truncated,
          }),
        );
        return;
      }
      // Detach: the process keeps running, the tool returns a handle to it.
      child.stdout.off("data", collect);
      child.stderr.off("data", collect);
      const jobId = ctx.adopt(child, cmd, out);
      const tail = out.split("\n").slice(-20).join("\n");
      finish({
        ok: true,
        summary: `still running · job ${jobId}`,
        content:
          `The command is still running after ${limit / 1000}s, so it is now background ` +
          `job ${jobId} — it was not killed. Poll it with job({action:"status",jobId:"${jobId}"}) ` +
          `or job({action:"output",jobId:"${jobId}"}), and stop it with action "kill".\n\n` +
          `Output so far:\n${tail}`,
        truncated: false,
      });
    }, limit);

    const onAbort = (): void => {
      child.kill("SIGKILL");
      finish({ ok: false, summary: "cancelled", content: "Cancelled by the user.", truncated: false });
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => finish({ ok: false, summary: err.message, content: err.message, truncated: false }));

    child.on("close", (code) => {
      void capOutput(out.trim() || "(no output)", ctx).then((c) =>
        finish({
          ok: code === 0,
          summary: code === 0 ? "ok" : `exit ${code}`,
          content: code === 0 ? c.content : `exit ${code}\n\n${c.content}`,
          outputPath: c.outputPath,
          truncated: c.truncated,
        }),
      );
    });
  });
}

/** The tools array sent to the API (§7: schemas go in the tools field, not the prompt). */
export function toolSpecs(enabled: readonly string[]): ToolSpec[] {
  return enabled
    .filter((n): n is keyof typeof ToolArgs => n in ToolArgs)
    .map((name) => ({
      name,
      description: TOOL_DESCRIPTIONS[name],
      parameters: zodToJsonSchema(ToolArgs[name]),
    }));
}
