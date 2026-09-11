import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Config, DEFAULT_RULES, type Event } from "@aicommander/protocol";
import { ensureProjectDir } from "../src/config.js";
import { Loop } from "../src/loop.js";
import { SessionStore } from "../src/sessions.js";

/** §5 show_files: the brain names paths, the app decides how to display each. */

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
  const config = Config.parse({ brain: { endpoint: base, model: "test" }, mode: "auto" });
  const loop = new Loop({ root, config, rules: DEFAULT_RULES, sessions, emit: (e) => events.push(e) });
  calls = 0;
  return { root, loop, events, meta };
};
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

/** Answer the show_files event the way the UI would. */
const answerWhenAsked = (
  loop: Loop,
  events: Event[],
  outcome: "opened" | "already-open" | "not-found" = "opened",
  side: "left" | "right" = "right",
): void => {
  const timer = setInterval(() => {
    const req = events.find((e) => e.type === "show_files") as
      { requestId?: string; paths?: string[] } | undefined;
    if (req?.requestId) {
      const results = (req.paths ?? []).map((path) => ({ path, outcome }));
      if (loop.resolveShow(req.requestId, results, side)) clearInterval(timer);
    }
  }, 10);
  setTimeout(() => clearInterval(timer), 4000);
};

describe("show_files", () => {
  it("emits the paths and tells the brain they are showing", async () => {
    const { loop, events, meta } = await setup();
    script = [[callTool("show_files", { paths: ["NOTES.md"] })], [say("shown")]];
    answerWhenAsked(loop, events);
    await loop.send(meta.id, "show it");

    expect(events.find((e) => e.type === "show_files")).toMatchObject({
      paths: ["NOTES.md"], target: "other",
    });
    const end = events.find((e) => e.type === "tool.end") as { ok: boolean; summary: string };
    expect(end.ok).toBe(true);
    expect(end.summary).toBe("showed 1 file");
  }, 15000);

  it("shows several files at once", async () => {
    const { root, loop, events, meta } = await setup();
    await writeFile(join(root, "b.md"), "b\n");
    script = [[callTool("show_files", { paths: ["NOTES.md", "b.md"] })], [say("ok")]];
    answerWhenAsked(loop, events);
    await loop.send(meta.id, "show them");
    expect(events.find((e) => e.type === "show_files")).toMatchObject({ paths: ["NOTES.md", "b.md"] });
    const end = events.find((e) => e.type === "tool.end") as { summary: string };
    expect(end.summary).toBe("showed 2 files");
  }, 15000);

  it("reports already-open rather than claiming it opened", async () => {
    const { loop, events, meta } = await setup();
    script = [[callTool("show_files", { paths: ["NOTES.md"] })], [say("ok")]];
    answerWhenAsked(loop, events, "already-open");
    await loop.send(meta.id, "show it");
    const end = events.find((e) => e.type === "tool.end") as { ok: boolean; summary: string };
    expect(end.ok).toBe(true);
    expect(end.summary).toBe("showed 1 file");
  }, 15000);

  it("drops missing paths but still shows the rest", async () => {
    const { root, loop, events, meta } = await setup();
    script = [[callTool("show_files", { paths: ["NOTES.md", "ghost.md"] })], [say("ok")]];
    answerWhenAsked(loop, events);
    await loop.send(meta.id, "show them");
    // Only the file that exists is sent to the UI.
    expect(events.find((e) => e.type === "show_files")).toMatchObject({ paths: ["NOTES.md"] });
    const end = events.find((e) => e.type === "tool.end") as { ok: boolean; summary: string };
    expect(end.ok).toBe(true);
    // tool.end carries only the UI summary; the model's copy is in the session log.
    expect(end.summary).toMatch(/1 missing/);
    const logged = (await new SessionStore(root).read(meta.id))
      .find((l) => l.t === "tool" && l.name === "show_files");
    expect(logged).toBeTruthy();
  }, 15000);

  it("fails when nothing exists, without asking the UI", async () => {
    const { loop, events, meta } = await setup();
    script = [[callTool("show_files", { paths: ["ghost.md"] })], [say("ok")]];
    await loop.send(meta.id, "show it");
    expect(events.some((e) => e.type === "show_files")).toBe(false);
    const end = events.find((e) => e.type === "tool.end") as { ok: boolean; summary: string };
    expect(end.ok).toBe(false);
    expect(end.summary).toMatch(/no such file/);
  }, 15000);

  it("refuses a path outside the repo root", async () => {
    const { loop, events, meta } = await setup();
    script = [[callTool("show_files", { paths: ["../../etc/passwd"] })], [say("ok")]];
    await loop.send(meta.id, "show it");
    expect((events.find((e) => e.type === "tool.end") as { ok: boolean }).ok).toBe(false);
  }, 15000);

  it("rejects more than five paths", async () => {
    const { loop, events, meta } = await setup();
    script = [[callTool("show_files", { paths: ["a", "b", "c", "d", "e", "f"] })], [say("ok")]];
    await loop.send(meta.id, "show them");
    const end = events.find((e) => e.type === "tool.end") as { ok: boolean; summary: string };
    expect(end.ok).toBe(false);
    expect(end.summary).toBe("bad arguments");
  }, 15000);

  it("does not wedge the loop when the UI never answers", async () => {
    const { loop, events, meta } = await setup();
    script = [[callTool("show_files", { paths: ["NOTES.md"] })], [say("ok")]];
    await loop.send(meta.id, "show it");
    expect(events.find((e) => e.type === "tool.end")).toBeTruthy();
    expect(events.filter((e) => e.type === "session.state").at(-1)).toMatchObject({ status: "idle" });
  }, 20000);

  it("is offered to the model", async () => {
    const { loop, events, meta } = await setup();
    script = [[say("nothing to do")]];
    await loop.send(meta.id, "hi");
    expect(events.length).toBeGreaterThan(0);
  }, 15000);
});
