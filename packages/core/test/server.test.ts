import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Event, Intent } from "@aicommander/protocol";
import { serve, type Serving } from "../src/server.js";

const run = promisify(execFile);

let root: string;
let serving: Serving;
let ws: WebSocket;
const inbox: Event[] = [];

/**
 * Wait for an event matching `pred`, scanning from `cursor` so a match left behind by an
 * earlier test is never mistaken for this one's. Tests never depend on event order.
 */
let cursor = 0;
const waitFor = (pred: (e: Event) => boolean, ms = 4000): Promise<Event> =>
  new Promise((resolve, reject) => {
    const scan = (): Event | undefined => {
      for (; cursor < inbox.length; cursor += 1) {
        const e = inbox[cursor]!;
        if (pred(e)) {
          cursor += 1;
          return e;
        }
      }
      return undefined;
    };
    const hit = scan();
    if (hit) return resolve(hit);
    const timer = setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error(`timed out waiting for event; saw: ${inbox.map((e) => e.type).join(", ")}`));
    }, ms);
    function onMsg() {
      const found = scan();
      if (found) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve(found);
      }
    }
    ws.on("message", onMsg);
  });

const send = (intent: Intent): void => ws.send(JSON.stringify(intent));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aic-srv-"));
  await writeFile(join(root, "README.md"), "# hello\n");
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "t@t"], { cwd: root });
  await run("git", ["config", "user.name", "t"], { cwd: root });

  serving = await serve({ root, port: 0, brain: "http://override:1234/v1" });

  ws = new WebSocket(`ws://127.0.0.1:${serving.port}/ws`);
  ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString()) as Event));
  await new Promise((r) => ws.once("open", r));
}, 20000);

afterAll(async () => {
  ws?.close();
  await serving?.close();
  await rm(root, { recursive: true, force: true });
});

describe("serve", () => {
  it("creates .aicommander on first open", async () => {
    const cfg = await readFile(join(root, ".aicommander", "config.json"), "utf8");
    expect(cfg.trim()).toBe("{}");
  });

  it("applies --brain over the config file", () => {
    expect(serving.config.brain.endpoint).toBe("http://override:1234/v1");
  });

  it("answers /health", async () => {
    const res = await fetch(`http://127.0.0.1:${serving.port}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("serves a repo file from /file", async () => {
    const res = await fetch(`http://127.0.0.1:${serving.port}/file?path=README.md`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# hello\n");
  });

  it("refuses /file outside the repo root", async () => {
    const res = await fetch(`http://127.0.0.1:${serving.port}/file?path=../../etc/passwd`);
    expect(res.status).toBe(403);
  });

  it("404s a missing file", async () => {
    const res = await fetch(`http://127.0.0.1:${serving.port}/file?path=nope.txt`);
    expect(res.status).toBe(404);
  });

  it("sends config and session.list on connect", async () => {
    expect(await waitFor((e) => e.type === "config")).toBeTruthy();
    expect(await waitFor((e) => e.type === "session.list")).toBeTruthy();
  });

  it("errors on a malformed intent without dropping the socket", async () => {
    ws.send("{ not json");
    const e = await waitFor((x) => x.type === "error" && x.message.includes("bad intent"));
    expect(e).toBeTruthy();
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("creates a session and replays it on open", async () => {
    send({ id: "i-create", type: "session.create", name: "first" });
    const created = await waitFor((e) => e.type === "session.events");
    const sessionId = (created as Extract<Event, { type: "session.events" }>).sessionId;

    send({ id: "i-open", type: "session.open", sessionId });
    const state = await waitFor((e) => e.type === "session.state");
    expect(state).toMatchObject({ status: "idle", ctxMax: serving.config.brain.ctx });
  });

  it("lists the repo with directories first", async () => {
    send({ id: "i-list", type: "fs.list", path: "." });
    const e = (await waitFor((x) => x.type === "fs.listed")) as Extract<Event, { type: "fs.listed" }>;
    const names = e.entries.map((x) => x.name);
    expect(names).toContain("README.md");
    expect(names).toContain(".aicommander");
    const firstFile = e.entries.findIndex((x) => !x.dir);
    const lastDir = e.entries.map((x) => x.dir).lastIndexOf(true);
    expect(lastDir).toBeLessThan(firstFile);
  });

  it("round-trips a file through fs.read and fs.write", async () => {
    send({ id: "i-read", type: "fs.read", path: "README.md" });
    const read = (await waitFor((x) => x.type === "fs.content")) as Extract<Event, { type: "fs.content" }>;
    expect(read.content).toBe("# hello\n");

    send({ id: "i-write", type: "fs.write", path: "NOTES.md", content: "notes\n", baseHash: null });
    await waitFor((x) => x.type === "fs.changed" && x.paths.includes("NOTES.md"));
    expect(await readFile(join(root, "NOTES.md"), "utf8")).toBe("notes\n");
  });

  it("reports repo-relative paths even when the root is behind a symlink", async () => {
    // macOS tmpdir lives under /var → /private/var, so this is the default case here.
    send({ id: "i-rel", type: "fs.write", path: "sub/deep.md", content: "x\n", baseHash: null });
    const e = (await waitFor((x) => x.type === "fs.changed")) as Extract<Event, { type: "fs.changed" }>;
    expect(e.paths).toEqual(["sub/deep.md"]);
    for (const p of e.paths) expect(p.startsWith("..")).toBe(false);
  });

  it("refuses a write whose baseHash is stale", async () => {
    send({ id: "i-stale", type: "fs.write", path: "README.md", content: "x", baseHash: "deadbeef" });
    const e = await waitFor((x) => x.type === "error" && x.intentId === "i-stale");
    expect((e as Extract<Event, { type: "error" }>).message).toMatch(/changed on disk/);
  });

  it("refuses an fs intent that escapes the root", async () => {
    send({ id: "i-esc", type: "fs.write", path: "../evil.txt", content: "x", baseHash: null });
    const e = await waitFor((x) => x.type === "error" && x.intentId === "i-esc");
    expect((e as Extract<Event, { type: "error" }>).message).toMatch(/escapes the repo root/);
  });

  it("refuses to delete .aicommander", async () => {
    send({ id: "i-del", type: "fs.delete", path: ".aicommander", confirm: "delete" });
    const e = await waitFor((x) => x.type === "error" && x.intentId === "i-del");
    expect((e as Extract<Event, { type: "error" }>).message).toMatch(/refusing/);
  });

  it("returns git status with the action echoed", async () => {
    send({ id: "i-git", type: "git.status" });
    const e = (await waitFor((x) => x.type === "git.result")) as Extract<Event, { type: "git.result" }>;
    expect(e.action).toBe("status");
    expect(e.intentId).toBe("i-git");
  });

  it("broadcasts a workspace change immediately", async () => {
    send({ id: "i-ws", type: "workspace.set", patch: { gutter: 0.35, focus: "right" } });
    const e = (await waitFor((x) => x.type === "workspace")) as Extract<Event, { type: "workspace" }>;
    expect(e.workspace).toMatchObject({ gutter: 0.35, focus: "right" });
  });

  it("writes the workspace to disk after the debounce", async () => {
    send({ id: "i-ws2", type: "workspace.set", patch: { gutter: 0.4 } });
    await waitFor((x) => x.type === "workspace");
    // 300ms debounce; a disk write per keystroke of the prompt draft would be silly.
    await new Promise((r) => setTimeout(r, 600));
    const onDisk = JSON.parse(await readFile(join(root, ".aicommander", "workspace.json"), "utf8"));
    expect(onDisk.gutter).toBe(0.4);
  }, 10000);

  it("sends the workspace on connect, before anything else", async () => {
    // The UI holds its first paint until this arrives, so a restored layout never
    // flashes the default one.
    const second = new WebSocket(`ws://127.0.0.1:${serving.port}/ws`);
    const seen: string[] = [];
    second.on("message", (raw) => seen.push((JSON.parse(raw.toString()) as Event).type));
    await new Promise((r) => second.once("open", r));
    await new Promise((r) => setTimeout(r, 400));
    second.close();
    expect(seen[0]).toBe("workspace");
    expect(seen).toContain("config");
  }, 10000);

  it("reports an unimplemented intent instead of dying", async () => {
    send({ id: "i-todo", type: "session.compact", sessionId: "whatever" });
    const e = await waitFor((x) => x.type === "error" && x.intentId === "i-todo");
    expect((e as Extract<Event, { type: "error" }>).message).toMatch(/agent loop/);
  });
});
