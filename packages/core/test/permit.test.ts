import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Config, DEFAULT_RULES, type Event } from "@aicommander/protocol";
import { ensureProjectDir } from "../src/config.js";
import { Loop } from "../src/loop.js";
import { SessionStore } from "../src/sessions.js";

/** §8 in the loop: a blocked call never runs, and the model is told why. */

let server: Server;
let base: string;
let script: string[][] = [];
let calls = 0;

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const say = (s: string) => sse({ choices: [{ delta: { content: s } }] });
const callTool = (name: string, args: unknown) =>
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name, arguments: JSON.stringify(args) } }] } }] });

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
const setup = async (mode: "ask" | "auto" | "plan" = "auto") => {
  const root = await mkdtemp(join(tmpdir(), "aic-perm-"));
  roots.push(root);
  await ensureProjectDir(root);
  await writeFile(join(root, "victim.txt"), "still here\n");
  const sessions = new SessionStore(root);
  const meta = await sessions.create("t");
  const events: Event[] = [];
  const config = Config.parse({ brain: { endpoint: base, model: "test" }, mode });
  const loop = new Loop({ root, config, rules: DEFAULT_RULES, sessions, emit: (e) => events.push(e) });
  calls = 0;
  return { root, loop, events, meta };
};
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

/** Answer a permission request the way the user would. */
const answer = (
  loop: Loop,
  events: Event[],
  reply: "once" | "session" | "deny",
  editedCommand?: string,
): void => {
  const timer = setInterval(() => {
    const req = events.find((e) => e.type === "permission.request") as { requestId?: string } | undefined;
    if (req?.requestId && loop.resolvePermission(req.requestId, { answer: reply, editedCommand })) {
      clearInterval(timer);
    }
  }, 10);
  setTimeout(() => clearInterval(timer), 5000);
};

describe("permission in the loop", () => {
  it("asks before rm -rf even in auto mode, and denying stops it", async () => {
    const { root, loop, events, meta } = await setup("auto");
    script = [[callTool("shell", { cmd: "rm -rf victim.txt" })], [say("blocked, then")]];
    answer(loop, events, "deny");
    await loop.send(meta.id, "delete it");

    const req = events.find((e) => e.type === "permission.request");
    expect(req).toMatchObject({ rule: "rm-rf", level: "danger", tool: "shell" });
    // The file is untouched: the command never ran.
    expect(await readFile(join(root, "victim.txt"), "utf8")).toBe("still here\n");
    const end = events.find((e) => e.type === "tool.end") as { ok: boolean; summary: string };
    expect(end).toMatchObject({ ok: false, summary: "blocked" });
  }, 20000);

  it("allowing once lets it through", async () => {
    const { root, loop, events, meta } = await setup("auto");
    script = [[callTool("shell", { cmd: "rm -rf victim.txt" })], [say("gone")]];
    answer(loop, events, "once");
    await loop.send(meta.id, "delete it");
    await expect(readFile(join(root, "victim.txt"), "utf8")).rejects.toThrow();
  }, 20000);

  it("records the answer in the session log", async () => {
    const { loop, events, meta, root } = await setup("auto");
    script = [[callTool("shell", { cmd: "sudo whoami" })], [say("ok")]];
    answer(loop, events, "deny");
    await loop.send(meta.id, "run it");
    const log = await new SessionStore(root).read(meta.id);
    expect(log.find((e) => e.t === "permission")).toMatchObject({ rule: "sudo", answer: "deny" });
  }, 20000);

  it("tells the model why, in the rule's own words", async () => {
    const { loop, events, meta, root } = await setup("auto");
    script = [[callTool("shell", { cmd: "rm -rf victim.txt" })], [say("understood")]];
    answer(loop, events, "deny");
    await loop.send(meta.id, "delete it");
    // The reason reaches the model as the tool result, so it can try something else.
    expect(calls).toBe(2);
    const log = await new SessionStore(root).read(meta.id);
    expect(log.some((e) => e.t === "tool" && !e.ok)).toBe(true);
  }, 20000);

  it("runs an edited command instead of the original", async () => {
    const { root, loop, events, meta } = await setup("auto");
    script = [[callTool("shell", { cmd: "rm -rf victim.txt" })], [say("ok")]];
    answer(loop, events, "once", "echo spared > spared.txt");
    await loop.send(meta.id, "delete it");
    // The dangerous command was replaced, so the victim survives.
    expect(await readFile(join(root, "victim.txt"), "utf8")).toBe("still here\n");
    expect(await readFile(join(root, "spared.txt"), "utf8")).toContain("spared");
  }, 20000);

  it("allow-for-session stops asking again", async () => {
    const { loop, events, meta } = await setup("auto");
    script = [
      [callTool("shell", { cmd: "sudo echo one" })],
      [callTool("shell", { cmd: "sudo echo two" })],
      [say("both done")],
    ];
    answer(loop, events, "session");
    await loop.send(meta.id, "run both");
    // Two sudo calls, one ask.
    expect(events.filter((e) => e.type === "permission.request")).toHaveLength(1);
  }, 20000);

  it("plan mode refuses a write without asking anyone", async () => {
    const { root, loop, events, meta } = await setup("plan");
    script = [[callTool("write_file", { path: "new.txt", content: "x" })], [say("cannot")]];
    await loop.send(meta.id, "write it");
    expect(events.some((e) => e.type === "permission.request")).toBe(false);
    await expect(readFile(join(root, "new.txt"), "utf8")).rejects.toThrow();
    const end = events.find((e) => e.type === "tool.end") as { ok: boolean };
    expect(end.ok).toBe(false);
  }, 20000);

  it("Esc during a permission ask denies it rather than hanging", async () => {
    const { loop, events, meta } = await setup("auto");
    script = [[callTool("shell", { cmd: "rm -rf victim.txt" })], [say("ok")]];
    // Nobody answers; cancel instead.
    setTimeout(() => loop.cancel(meta.id), 600);
    await loop.send(meta.id, "delete it");
    const last = events.filter((e) => e.type === "session.state").at(-1);
    expect(last).toMatchObject({ status: "cancelled" });
  }, 20000);

  it("never asks about a read", async () => {
    const { loop, events, meta } = await setup("ask");
    script = [[callTool("read_file", { path: "victim.txt" })], [say("read it")]];
    await loop.send(meta.id, "read it");
    expect(events.some((e) => e.type === "permission.request")).toBe(false);
  }, 20000);
});
