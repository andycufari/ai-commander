import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_RULES, type Config, type Event } from "@aicommander/protocol";
import { Config as ConfigSchema } from "@aicommander/protocol";
import { ensureProjectDir } from "../src/config.js";
import { handleIntent, type Ctx } from "../src/intents.js";
import { Loop } from "../src/loop.js";
import { SessionStore } from "../src/sessions.js";
import { WorkspaceStore } from "../src/workspace.js";
import { takeSnapshot } from "../src/snapshots.js";

/** The rewind path end to end: snapshot, change, restore. */

const run = promisify(execFile);
const roots: string[] = [];

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "aic-rwi-"));
  roots.push(root);
  await ensureProjectDir(root);
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "t@t"], { cwd: root });
  await run("git", ["config", "user.name", "t"], { cwd: root });
  await writeFile(join(root, "seed.txt"), "seed\n");
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["commit", "-qm", "first"], { cwd: root });

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
  return { root, ctx, sessions, meta, events };
};
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe("rewind", () => {
  it("restores the tree as it was before the group ran", async () => {
    const { root, ctx, sessions, meta } = await setup();

    // Turn 1: snapshot, then create a file.
    const snap1 = await takeSnapshot(root, meta.id, "g1");
    await sessions.append(meta.id, { t: "user", id: "g1", ts: 1, text: "make it", attachments: [] });
    await sessions.append(meta.id, { t: "snapshot", ts: 1, group: "g1", ref: snap1!.ref });
    await sessions.writeMeta({
      ...(await sessions.readMeta(meta.id)),
      snapshots: [{ groupId: "g1", gitRef: snap1!.ref }],
    });
    await writeFile(join(root, "made.txt"), "original\n");

    // Turn 2: snapshot, then wreck it.
    const snap2 = await takeSnapshot(root, meta.id, "g2");
    await sessions.append(meta.id, { t: "user", id: "g2", ts: 2, text: "wreck it", attachments: [] });
    await sessions.append(meta.id, { t: "snapshot", ts: 2, group: "g2", ref: snap2!.ref });
    await sessions.writeMeta({
      ...(await sessions.readMeta(meta.id)),
      snapshots: [
        { groupId: "g1", gitRef: snap1!.ref },
        { groupId: "g2", gitRef: snap2!.ref },
      ],
    });
    await writeFile(join(root, "made.txt"), "destroyed\n");

    // Rewind to g2: the tree goes back to how it was before g2 ran.
    await handleIntent(
      { id: "i1", type: "session.rewind", sessionId: meta.id, groupId: "g2", mode: "truncate" },
      ctx,
    );
    expect(await readFile(join(root, "made.txt"), "utf8")).toBe("original\n");
  }, 20000);

  it("removes a file the rewound turn created", async () => {
    const { root, ctx, sessions, meta } = await setup();
    const snap = await takeSnapshot(root, meta.id, "g1");
    await sessions.append(meta.id, { t: "user", id: "g1", ts: 1, text: "make it", attachments: [] });
    await sessions.writeMeta({
      ...(await sessions.readMeta(meta.id)),
      snapshots: [{ groupId: "g1", gitRef: snap!.ref }],
    });
    await writeFile(join(root, "invented.txt"), "x\n");

    await handleIntent(
      { id: "i1", type: "session.rewind", sessionId: meta.id, groupId: "g1", mode: "truncate" },
      ctx,
    );
    await expect(readFile(join(root, "invented.txt"), "utf8")).rejects.toThrow();
  }, 20000);

  it("keeps the snapshot for the group it rewound to", async () => {
    const { root, ctx, sessions, meta } = await setup();
    const snap1 = await takeSnapshot(root, meta.id, "g1");
    const snap2 = await takeSnapshot(root, meta.id, "g2");
    await sessions.append(meta.id, { t: "user", id: "g1", ts: 1, text: "a", attachments: [] });
    await sessions.append(meta.id, { t: "user", id: "g2", ts: 2, text: "b", attachments: [] });
    await sessions.writeMeta({
      ...(await sessions.readMeta(meta.id)),
      snapshots: [
        { groupId: "g1", gitRef: snap1!.ref },
        { groupId: "g2", gitRef: snap2!.ref },
      ],
    });

    await handleIntent(
      { id: "i1", type: "session.rewind", sessionId: meta.id, groupId: "g1", mode: "truncate" },
      ctx,
    );
    const after = await sessions.readMeta(meta.id);
    // g1 survives so the rewind can be repeated; g2 is gone with its turn.
    expect(after.snapshots.map((s) => s.groupId)).toEqual(["g1"]);
  }, 20000);
});
