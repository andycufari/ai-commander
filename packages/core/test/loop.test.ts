import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Config, type Event } from "@aicommander/protocol";
import { ensureProjectDir } from "../src/config.js";
import { Loop } from "../src/loop.js";
import { SessionStore } from "../src/sessions.js";

/** The loop against a scripted endpoint: streaming, tool round trips, Esc, guard 7. */

let server: Server;
let base: string;
/** Each element is one response, in order; the loop may call several times per turn. */
let responses: string[][] = [];
let calls = 0;

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const say = (s: string) => sse({ choices: [{ delta: { content: s } }] });
const callTool = (id: string, name: string, args: unknown) =>
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] });

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const script = responses[calls] ?? [say("done")];
      calls += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const f of script) res.write(f);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const roots: string[] = [];
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "aic-loop-"));
  roots.push(root);
  await ensureProjectDir(root);
  await writeFile(join(root, "README.md"), "# demo\nsecond line\n");
  const sessions = new SessionStore(root);
  const meta = await sessions.create("t");
  const events: Event[] = [];
  const config = Config.parse({ brain: { endpoint: base, model: "test" } });
  const loop = new Loop({ root, config, sessions, emit: (e) => events.push(e) });
  calls = 0;
  return { root, sessions, loop, events, meta, config };
};
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe("loop", () => {
  it("streams text and ends idle", async () => {
    const { loop, events, meta } = await setup();
    responses = [[say("Hel"), say("lo")]];
    await loop.send(meta.id, "hi");

    const tokens = events.filter((e) => e.type === "token").map((e) => (e as { delta: string }).delta);
    expect(tokens.join("")).toBe("Hello");
    const last = events.filter((e) => e.type === "session.state").at(-1);
    expect(last).toMatchObject({ status: "idle" });
  });

  it("runs a tool call and feeds the result back", async () => {
    const { loop, events, meta } = await setup();
    responses = [
      [callTool("c1", "read_file", { path: "README.md" })],
      [say("It says demo.")],
    ];
    await loop.send(meta.id, "what is in the readme?");

    const start = events.find((e) => e.type === "tool.start") as { name: string } | undefined;
    const end = events.find((e) => e.type === "tool.end") as { ok: boolean; summary: string } | undefined;
    expect(start?.name).toBe("read_file");
    expect(end?.ok).toBe(true);
    expect(end?.summary).toBe("2 lines");
    expect(calls).toBe(2);
  });

  it("writes the whole exchange to session.jsonl", async () => {
    const { loop, sessions, meta } = await setup();
    responses = [[callTool("c1", "glob", { pattern: "*.md" })], [say("found it")]];
    await loop.send(meta.id, "list markdown");

    const log = await sessions.read(meta.id);
    expect(log.map((e) => e.t)).toEqual(["user", "brain", "tool", "brain"]);
    const groups = SessionStore.toGroups(meta.id, log);
    expect(groups[0]).toMatchObject({ userText: "list markdown", toolCount: 1 });
  });

  it("reloads the history into the next turn", async () => {
    const { loop, sessions, meta } = await setup();
    responses = [[say("first")], [say("second")]];
    await loop.send(meta.id, "one");
    await loop.send(meta.id, "two");
    const log = await sessions.read(meta.id);
    expect(log.filter((e) => e.t === "user")).toHaveLength(2);
  });

  it("cancels mid-loop, keeps partial text and marks the group", async () => {
    const { loop, sessions, events, meta } = await setup();
    // A slow shell command gives Esc something to interrupt.
    responses = [[say("working "), callTool("c1", "shell", { cmd: "sleep 5" })], [say("never")]];

    const turn = loop.send(meta.id, "run it");
    // Wait for the tool to actually start before cancelling.
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (events.some((e) => e.type === "tool.start")) {
          clearInterval(t);
          resolve();
        }
      }, 10);
    });
    expect(loop.cancel(meta.id)).toBe(true);
    await turn;

    const last = events.filter((e) => e.type === "session.state").at(-1);
    expect(last).toMatchObject({ status: "cancelled" });

    const log = await sessions.read(meta.id);
    expect(log.some((e) => e.t === "cancel")).toBe(true);
    // partial text survives
    expect(log.find((e) => e.t === "brain" && e.text.includes("working "))).toBeTruthy();
    // and the loop did not continue to the second response
    expect(calls).toBe(1);
  }, 15000);

  it("reports cancel on an idle session as nothing to do", async () => {
    const { loop, meta } = await setup();
    expect(loop.cancel(meta.id)).toBe(false);
  });

  it("queues a message sent while running (guard 5)", async () => {
    const { loop, events, meta } = await setup();
    responses = [[callTool("c1", "shell", { cmd: "sleep 0.4" })], [say("after")]];
    const turn = loop.send(meta.id, "start");
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (events.some((e) => e.type === "tool.start")) {
          clearInterval(t);
          resolve();
        }
      }, 10);
    });
    expect(loop.queue(meta.id, "also this")).toBe(true);
    const queued = events.filter((e) => e.type === "session.state").find((e) => "queued" in e);
    expect(queued).toBeTruthy();
    await turn;
  }, 15000);

  it("turns a malformed tool call into an error the model can retry (guard 7)", async () => {
    const { loop, events, meta } = await setup();
    responses = [
      [sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: "{{broken" } }] } }] })],
      [say("I will retry.")],
    ];
    await loop.send(meta.id, "read it");
    const end = events.find((e) => e.type === "tool.end") as { ok: boolean; summary: string } | undefined;
    expect(end?.ok).toBe(false);
    expect(end?.summary).toMatch(/malformed arguments/);
    // the model got another turn to fix it
    expect(calls).toBe(2);
  });

  it("parses a text-tag call from a model with no native tools (toolFormat auto)", async () => {
    const { loop, events, meta } = await setup();
    responses = [
      [say('Let me look.\n<tool_call>{"name":"glob","arguments":{"pattern":"*.md"}}</tool_call>')],
      [say("README.md")],
    ];
    await loop.send(meta.id, "list markdown");
    const start = events.find((e) => e.type === "tool.start") as { name: string } | undefined;
    expect(start?.name).toBe("glob");
  });

  it("surfaces a brain failure as an error event, not a crash", async () => {
    const { sessions, meta } = await setup();
    const events: Event[] = [];
    const config = Config.parse({ brain: { endpoint: "http://127.0.0.1:1/v1", model: "m" } });
    const loop = new Loop({ root: roots.at(-1)!, config, sessions, emit: (e) => events.push(e) });
    await loop.send(meta.id, "hi");
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.filter((e) => e.type === "session.state").at(-1)).toMatchObject({ status: "idle" });
  });

  it("stops after maxTurnsPerPrompt", async () => {
    const { sessions, meta, root } = await setup();
    const events: Event[] = [];
    const config = Config.parse({
      brain: { endpoint: base, model: "test" },
      loop: { maxTurnsPerPrompt: 2 },
    });
    const loop = new Loop({ root, config, sessions, emit: (e) => events.push(e) });
    // Always ask for another tool — the cap is what must stop it.
    responses = Array.from({ length: 10 }, () => [callTool("c1", "glob", { pattern: "*" })]);
    await loop.send(meta.id, "go");
    expect(calls).toBe(2);
  });
});
