import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_RULES, Config as ConfigSchema, type Config, type Event } from "@aicommander/protocol";
import { ensureProjectDir, projectDir } from "../src/config.js";
import { handleIntent, type Ctx } from "../src/intents.js";
import { Loop } from "../src/loop.js";
import { SessionStore } from "../src/sessions.js";
import { WorkspaceStore } from "../src/workspace.js";

/**
 * §13: anything reachable through handleIntent gets an integration test driving the
 * real intent. system.md is read and written through fs.read / fs.write like any file,
 * so F4 editing it is the same path — this covers that it exists to be edited at all.
 */

const roots: string[] = [];
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "aic-sys-"));
  roots.push(root);
  await ensureProjectDir(root);
  const sessions = new SessionStore(root);
  const events: Event[] = [];
  const config: Config = ConfigSchema.parse({ brain: { endpoint: "http://x/v1", model: "m" } });
  const loop = new Loop({ root, config, rules: DEFAULT_RULES, sessions, emit: (e) => events.push(e) });
  const ctx: Ctx = {
    root, config, rules: DEFAULT_RULES, sessions, loop,
    workspace: new WorkspaceStore(root),
    broadcast: (e) => events.push(e),
    send: (e) => events.push(e),
  };
  return { root, ctx, events };
};
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe("system.md", () => {
  it("is created on first open", async () => {
    const { root } = await setup();
    const text = await readFile(join(projectDir(root), "system.md"), "utf8");
    expect(text).toContain("AI Commander");
    expect(text).toContain("show_files");
  });

  it("is not overwritten when it already exists", async () => {
    // The user edits it with F4; a later open must not throw that away.
    const root = await mkdtemp(join(tmpdir(), "aic-sys2-"));
    roots.push(root);
    await ensureProjectDir(root);
    await writeFile(join(projectDir(root), "system.md"), "# mine\n");
    await ensureProjectDir(root);
    expect(await readFile(join(projectDir(root), "system.md"), "utf8")).toBe("# mine\n");
  });

  it("is readable through fs.read, which is how F4 opens it", async () => {
    const { ctx, events } = await setup();
    await handleIntent({ id: "i1", type: "fs.read", path: ".aicommander/system.md" }, ctx);
    const reply = events.find((e) => e.type === "fs.content") as { content: string } | undefined;
    expect(reply?.content).toContain("You are the brain inside AI Commander");
  });

  it("is writable through fs.write, which is how F4 saves it", async () => {
    const { root, ctx, events } = await setup();
    await handleIntent({ id: "i1", type: "fs.read", path: ".aicommander/system.md" }, ctx);
    const read = events.find((e) => e.type === "fs.content") as { hash: string };

    await handleIntent({
      id: "i2", type: "fs.write", path: ".aicommander/system.md",
      content: "# edited by the user\n", baseHash: read.hash,
    }, ctx);
    expect(await readFile(join(projectDir(root), "system.md"), "utf8")).toBe("# edited by the user\n");
  });

  it("refuses a stale write, so two editors cannot clobber each other", async () => {
    const { ctx } = await setup();
    await expect(handleIntent({
      id: "i1", type: "fs.write", path: ".aicommander/system.md",
      content: "x", baseHash: "not-the-current-hash",
    }, ctx)).rejects.toThrow(/changed on disk/);
  });
});
