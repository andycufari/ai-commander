import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_RULES, Config as ConfigSchema, type Config, type Event } from "@aicommander/protocol";
import { ensureProjectDir, projectDir } from "../src/config.js";
import { handleIntent, type Ctx } from "../src/intents.js";
import { Loop } from "../src/loop.js";
import { SessionStore } from "../src/sessions.js";
import { WorkspaceStore } from "../src/workspace.js";

/** §13: driving the real intents the picker sends. */

const roots: string[] = [];
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "aic-pick-"));
  roots.push(root);
  await ensureProjectDir(root);
  const sessions = new SessionStore(root);
  const meta = await sessions.create("t");
  const events: Event[] = [];
  const config: Config = ConfigSchema.parse({ brain: { endpoint: "http://x/v1", model: "m" } });
  const loop = new Loop({ root, config, rules: DEFAULT_RULES, sessions, emit: (e) => events.push(e) });
  const ctx: Ctx = {
    root, config, rules: DEFAULT_RULES, sessions, loop,
    workspace: new WorkspaceStore(root),
    broadcast: (e) => events.push(e),
    send: (e) => events.push(e),
  };
  return { root, ctx, events, meta };
};
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe("skills.list", () => {
  it("returns name and description for the / tab", async () => {
    const { root, ctx, events } = await setup();
    await mkdir(join(root, "skills", "esp32"), { recursive: true });
    await writeFile(join(root, "skills", "esp32", "SKILL.md"),
      "---\nname: esp32\ndescription: deep sleep\n---\n");
    await handleIntent({ id: "i1", type: "skills.list" }, ctx);
    const reply = events.find((e) => e.type === "skills.listed") as
      { skills: { name: string }[]; skipped: string[] };
    expect(reply.skills).toEqual([{ name: "esp32", description: "deep sleep" }]);
    expect(reply.skipped).toEqual([]);
  });

  it("reports skills it had to skip", async () => {
    const { root, ctx, events } = await setup();
    await mkdir(join(root, "skills", "bare"), { recursive: true });
    await writeFile(join(root, "skills", "bare", "SKILL.md"), "no frontmatter here\n");
    await handleIntent({ id: "i1", type: "skills.list" }, ctx);
    const reply = events.find((e) => e.type === "skills.listed") as { skipped: string[] };
    expect(reply.skipped).toEqual(["bare"]);
  });

  it("is empty in a project with no skills", async () => {
    const { ctx, events } = await setup();
    await handleIntent({ id: "i1", type: "skills.list" }, ctx);
    expect((events.find((e) => e.type === "skills.listed") as { skills: unknown[] }).skills)
      .toEqual([]);
  });
});

describe("image.add", () => {
  // A 1x1 png, the smallest thing that is genuinely an image.
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("saves into the session's img directory", async () => {
    const { root, ctx, events, meta } = await setup();
    await handleIntent({
      id: "i1", type: "image.add", sessionId: meta.id, name: "shot.png", data: PNG,
    }, ctx);
    const reply = events.find((e) => e.type === "image.added") as { file: string };
    expect(reply.file).toMatch(/^img\//);
    const bytes = await readFile(join(projectDir(root), "sessions", meta.id, reply.file));
    expect(bytes.length).toBeGreaterThan(0);
    // A real PNG, not the base64 text.
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  });

  it("does not let a name escape the session directory", async () => {
    const { ctx, meta } = await setup();
    await expect(handleIntent({
      id: "i1", type: "image.add", sessionId: meta.id,
      name: "../../../escaped.png", data: PNG,
    }, ctx)).rejects.toThrow();
  });

  it("keeps both images when two share a name", async () => {
    const { ctx, events, meta } = await setup();
    await handleIntent({ id: "i1", type: "image.add", sessionId: meta.id, name: "a.png", data: PNG }, ctx);
    await handleIntent({ id: "i2", type: "image.add", sessionId: meta.id, name: "a.png", data: PNG }, ctx);
    const added = events.filter((e) => e.type === "image.added") as { file: string }[];
    expect(added[0]!.file).not.toBe(added[1]!.file);
  });

  it("refuses something that is not an image", async () => {
    const { ctx, meta } = await setup();
    await expect(handleIntent({
      id: "i1", type: "image.add", sessionId: meta.id, name: "notes.txt", data: "aGVsbG8=",
    }, ctx)).rejects.toThrow(/image/i);
  });
});
