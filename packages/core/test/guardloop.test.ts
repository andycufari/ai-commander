import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Config, DEFAULT_RULES, type Event } from "@aicommander/protocol";
import { ensureProjectDir } from "../src/config.js";
import { Loop } from "../src/loop.js";
import { SessionStore } from "../src/sessions.js";

/** §6 guards 1, 2 and 4, inside the loop. */

let server: Server;
let base: string;
let script: string[][] = [];
let calls = 0;

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const say = (s: string) => sse({ choices: [{ delta: { content: s } }] });
const callTool = (name: string, args: unknown, id = "c1") =>
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] });

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const frames = script[calls] ?? [say("done")];
      calls += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const f of frames) res.write(f);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const roots: string[] = [];
const setup = async (loopOver: Record<string, number> = {}) => {
  const root = await mkdtemp(join(tmpdir(), "aic-guard-"));
  roots.push(root);
  await ensureProjectDir(root);
  await writeFile(join(root, "a.txt"), "content\n");
  const sessions = new SessionStore(root);
  const meta = await sessions.create("t");
  const events: Event[] = [];
  const config = Config.parse({
    brain: { endpoint: base, model: "test" },
    mode: "auto",
    loop: { shellTimeoutSec: 1, ...loopOver },
  });
  const loop = new Loop({ root, config, rules: DEFAULT_RULES, sessions, emit: (e) => events.push(e) });
  calls = 0;
  return { root, loop, events, meta };
};
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 200));
});

/** Answer whatever the loop asks, the way the user would. */
const answerAsk = (loop: Loop, events: Event[], choice: string): void => {
  const seen = new Set<string>();
  const timer = setInterval(() => {
    for (const e of events) {
      if (e.type !== "ask.request") continue;
      const req = e as { requestId: string };
      if (seen.has(req.requestId)) continue;
      seen.add(req.requestId);
      loop.resolveAsk(req.requestId, choice);
    }
  }, 10);
  setTimeout(() => clearInterval(timer), 8000);
};

describe("guard 1 — repeat calls", () => {
  it("pauses after N identical calls and can be stopped", async () => {
    const { loop, events, meta } = await setup({ repeatGuard: 3 });
    script = Array.from({ length: 8 }, () => [callTool("glob", { pattern: "**/*" })]);
    answerAsk(loop, events, "stop");
    await loop.send(meta.id, "look around");

    const ask = events.find((e) => e.type === "ask.request") as { question: string; options: string[] };
    expect(ask).toBeTruthy();
    expect(ask.question).toMatch(/3 times with the same arguments/);
    expect(ask.options).toEqual(["continue", "stop", "tell it something"]);
  }, 20000);

  it("counts whitespace variants as the same call", async () => {
    const { loop, events, meta } = await setup({ repeatGuard: 3 });
    script = [
      [callTool("shell", { cmd: "echo hi" })],
      [callTool("shell", { cmd: "echo  hi" })],
      [callTool("shell", { cmd: " echo hi " })],
      [say("done")],
    ];
    answerAsk(loop, events, "stop");
    await loop.send(meta.id, "go");
    expect(events.some((e) => e.type === "ask.request")).toBe(true);
  }, 20000);

  it("does not pause when the calls differ", async () => {
    const { loop, events, meta } = await setup({ repeatGuard: 3 });
    script = [
      [callTool("glob", { pattern: "*.a" })],
      [callTool("glob", { pattern: "*.b" })],
      [callTool("glob", { pattern: "*.c" })],
      [say("done")],
    ];
    await loop.send(meta.id, "go");
    expect(events.some((e) => e.type === "ask.request")).toBe(false);
  }, 20000);

  it("continue lets it carry on", async () => {
    const { loop, events, meta } = await setup({ repeatGuard: 3, maxTurnsPerPrompt: 6 });
    script = [
      ...Array.from({ length: 4 }, () => [callTool("glob", { pattern: "**/*" })]),
      [say("finished")],
    ];
    answerAsk(loop, events, "continue");
    await loop.send(meta.id, "go");
    // It kept going past the pause instead of stopping.
    expect(calls).toBeGreaterThan(3);
  }, 20000);
});

describe("guard 2 — consecutive errors", () => {
  it("pauses after N failures in a row", async () => {
    const { loop, events, meta } = await setup({ errorGuard: 3 });
    script = Array.from({ length: 8 }, (_, i) =>
      [callTool("read_file", { path: `ghost${i}.txt` })]);
    answerAsk(loop, events, "stop");
    await loop.send(meta.id, "read them");
    const ask = events.find((e) => e.type === "ask.request") as { question: string };
    expect(ask?.question).toMatch(/3 tool calls in a row have failed/);
  }, 20000);

  it("a success in between clears the run", async () => {
    const { loop, events, meta } = await setup({ errorGuard: 3 });
    script = [
      [callTool("read_file", { path: "ghost1.txt" })],
      [callTool("read_file", { path: "ghost2.txt" })],
      [callTool("read_file", { path: "a.txt" })],
      [callTool("read_file", { path: "ghost3.txt" })],
      [say("done")],
    ];
    await loop.send(meta.id, "read them");
    expect(events.some((e) => e.type === "ask.request")).toBe(false);
  }, 20000);

  it("counts a malformed call (guard 7) as an error", async () => {
    const { loop, events, meta } = await setup({ errorGuard: 2 });
    const broken = sse({ choices: [{ delta: { tool_calls: [
      { index: 0, id: "c1", function: { name: "read_file", arguments: "{{{garbage" } },
    ] } }] });
    script = [[broken], [broken], [say("done")]];
    answerAsk(loop, events, "stop");
    await loop.send(meta.id, "go");
    expect(events.some((e) => e.type === "ask.request")).toBe(true);
  }, 20000);
});

describe("guard 4 — timeout becomes a job", () => {
  it("detaches instead of killing, and tells the model the job id", async () => {
    const { loop, events, meta } = await setup({ shellTimeoutSec: 1 });
    script = [[callTool("shell", { cmd: "echo starting; sleep 4; echo finished" })], [say("noted")]];
    await loop.send(meta.id, "run it");

    const start = events.find((e) => e.type === "job.start") as { jobId: string; cmd: string };
    expect(start).toBeTruthy();
    const end = events.find((e) => e.type === "tool.end") as { ok: boolean; summary: string };
    // The tool succeeded — the command is running, not dead.
    expect(end.ok).toBe(true);
    expect(end.summary).toMatch(/still running · job/);

    // And it really is still going.
    expect(loop.jobs.get(start.jobId)?.running).toBe(true);
    await new Promise((r) => setTimeout(r, 3800));
    expect(loop.jobs.get(start.jobId)).toMatchObject({ running: false, exitCode: 0, killed: false });
    expect(loop.jobs.output(start.jobId)).toContain("finished");
    loop.jobs.killAll();
  }, 25000);

  it("the model can poll and kill it", async () => {
    const { loop, events, meta } = await setup({ shellTimeoutSec: 1 });
    script = [
      [callTool("shell", { cmd: "sleep 20" })],
      [say("checking")],
    ];
    await loop.send(meta.id, "run it");
    const start = events.find((e) => e.type === "job.start") as { jobId: string };
    expect(loop.jobs.get(start.jobId)?.running).toBe(true);
    expect(loop.jobs.kill(start.jobId)).toBe(true);
    await new Promise((r) => setTimeout(r, 900));
    expect(loop.jobs.get(start.jobId)?.running).toBe(false);
    loop.jobs.killAll();
  }, 25000);
});

describe("ask_user", () => {
  it("pauses the loop and returns the choice as the tool result", async () => {
    const { loop, events, meta } = await setup();
    script = [
      [callTool("ask_user", { question: "Which one?", options: ["left", "right"] })],
      [say("going left")],
    ];
    answerAsk(loop, events, "left");
    await loop.send(meta.id, "ask me");

    const ask = events.find((e) => e.type === "ask.request") as { question: string; options: string[] };
    expect(ask).toMatchObject({ question: "Which one?", options: ["left", "right"] });
    const end = events.find((e) => e.type === "tool.end") as { ok: boolean; summary: string };
    expect(end).toMatchObject({ ok: true, summary: "answered: left" });
  }, 20000);
});
