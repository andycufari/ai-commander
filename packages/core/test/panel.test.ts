import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Config, type Event } from "@aicommander/protocol";
import { ensureProjectDir } from "../src/config.js";
import { Loop } from "../src/loop.js";
import { SessionStore } from "../src/sessions.js";

/** §5 open_in_panel: the loop asks the UI and reports back what happened. */

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
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "aic-panel-"));
  roots.push(root);
  await ensureProjectDir(root);
  await writeFile(join(root, "NOTES.md"), "# Notes\n");
  const sessions = new SessionStore(root);
  const meta = await sessions.create("t");
  const events: Event[] = [];
  const config = Config.parse({ brain: { endpoint: base, model: "test" } });
  const loop = new Loop({ root, config, sessions, emit: (e) => events.push(e) });
  calls = 0;
  return { root, loop, events, meta };
};
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

/** Answer the open_in_panel event the way the UI would. */
const answerWhenAsked = (
  loop: Loop,
  events: Event[],
  outcome: "opened" | "already-open" | "not-found",
  side: "left" | "right" = "right",
): void => {
  const timer = setInterval(() => {
    const req = events.find((e) => e.type === "open_in_panel") as { requestId?: string } | undefined;
    if (req?.requestId && loop.resolvePanel(req.requestId, { outcome, side })) clearInterval(timer);
  }, 10);
  setTimeout(() => clearInterval(timer), 4000);
};

describe("open_in_panel", () => {
  it("emits an event and tells the brain it opened", async () => {
    const { loop, events, meta } = await setup();
    script = [[callTool("open_in_panel", { path: "NOTES.md", mode: "view" })], [say("shown")]];
    answerWhenAsked(loop, events, "opened");
    await loop.send(meta.id, "show it");

    const opened = events.find((e) => e.type === "open_in_panel");
    expect(opened).toMatchObject({ path: "NOTES.md", mode: "view", target: "other" });
    const end = events.find((e) => e.type === "tool.end") as { ok: boolean; summary: string };
    expect(end.ok).toBe(true);
    expect(end.summary).toBe("opened NOTES.md");
  }, 15000);

  it("reports already-open rather than claiming a new panel", async () => {
    const { loop, events, meta } = await setup();
    script = [[callTool("open_in_panel", { path: "NOTES.md" })], [say("ok")]];
    answerWhenAsked(loop, events, "already-open", "left");
    await loop.send(meta.id, "show it");
    const end = events.find((e) => e.type === "tool.end") as { ok: boolean; summary: string };
    expect(end.ok).toBe(true);
    expect(end.summary).toMatch(/already open/);
  }, 15000);

  it("refuses a file that does not exist, without asking the UI", async () => {
    const { loop, events, meta } = await setup();
    script = [[callTool("open_in_panel", { path: "nope.md" })], [say("ok")]];
    await loop.send(meta.id, "show it");
    const end = events.find((e) => e.type === "tool.end") as { ok: boolean; summary: string };
    expect(end.ok).toBe(false);
    expect(end.summary).toMatch(/no such file/);
    // The UI was never asked, so no event was emitted.
    expect(events.some((e) => e.type === "open_in_panel")).toBe(false);
  }, 15000);

  it("refuses a path outside the repo root", async () => {
    const { loop, events, meta } = await setup();
    script = [[callTool("open_in_panel", { path: "../../etc/passwd" })], [say("ok")]];
    await loop.send(meta.id, "show it");
    const end = events.find((e) => e.type === "tool.end") as { ok: boolean };
    expect(end.ok).toBe(false);
  }, 15000);

  it("refuses a directory", async () => {
    const { loop, events, meta } = await setup();
    script = [[callTool("open_in_panel", { path: "." })], [say("ok")]];
    await loop.send(meta.id, "show it");
    const end = events.find((e) => e.type === "tool.end") as { ok: boolean; summary: string };
    expect(end.ok).toBe(false);
    expect(end.summary).toMatch(/not a file/);
  }, 15000);

  it("does not wedge the loop when the UI never answers", async () => {
    const { loop, events, meta } = await setup();
    script = [[callTool("open_in_panel", { path: "NOTES.md" })], [say("ok")]];
    // No answerWhenAsked: the request times out and the loop continues.
    await loop.send(meta.id, "show it");
    expect(events.find((e) => e.type === "tool.end")).toBeTruthy();
    const last = events.filter((e) => e.type === "session.state").at(-1);
    expect(last).toMatchObject({ status: "idle" });
  }, 20000);
});
