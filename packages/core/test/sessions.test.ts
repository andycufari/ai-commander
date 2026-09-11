import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureProjectDir } from "../src/config.js";
import { SessionStore } from "../src/sessions.js";

const roots: string[] = [];
const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "aic-s-"));
  roots.push(dir);
  await ensureProjectDir(dir);
  return dir;
};
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("creates, lists and reads back a session", async () => {
    const store = new SessionStore(await makeRepo());
    const meta = await store.create("firmware", "qwen3-27b");
    expect(meta.name).toBe("firmware");
    const list = await store.list();
    expect(list.map((m) => m.id)).toEqual([meta.id]);
    expect((await store.readMeta(meta.id)).model).toBe("qwen3-27b");
  });

  it("appends and replays the log", async () => {
    const store = new SessionStore(await makeRepo());
    const { id } = await store.create();
    await store.append(id, { t: "user", id: "g1", ts: 1, text: "hi", attachments: [] });
    await store.append(id, { t: "brain", id: "g1", ts: 2, text: "ok", toolCalls: [] });
    const back = await store.read(id);
    expect(back.map((e) => e.t)).toEqual(["user", "brain"]);
  });

  it("survives a truncated trailing line", async () => {
    const root = await makeRepo();
    const store = new SessionStore(root);
    const { id } = await store.create();
    await store.append(id, { t: "user", id: "g1", ts: 1, text: "hi", attachments: [] });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(root, ".aicommander", "sessions", id, "session.jsonl"), '{"t":"brai');
    expect((await store.read(id)).length).toBe(1);
  });

  it("deletes a session", async () => {
    const store = new SessionStore(await makeRepo());
    const { id } = await store.create();
    await store.delete(id);
    expect(await store.list()).toEqual([]);
  });

  it("returns no sessions for a repo that has none", async () => {
    expect(await new SessionStore(await makeRepo()).list()).toEqual([]);
  });
});

describe("toGroups", () => {
  it("folds a log into groups in order", () => {
    const groups = SessionStore.toGroups("s1", [
      { t: "user", id: "g1", ts: 1, text: "list files", attachments: [] },
      { t: "brain", id: "g1", ts: 2, text: "sure", toolCalls: [] },
      { t: "tool", id: "g1", ts: 3, callId: "c1", name: "glob", args: {}, ok: true, summary: "8", outputPath: null, tokens: 120 },
      { t: "tool", id: "g1", ts: 4, callId: "c2", name: "read_file", args: {}, ok: true, summary: "212", outputPath: null, tokens: 1400 },
      { t: "user", id: "g2", ts: 5, text: "thanks", attachments: [] },
    ]);
    expect(groups.length).toBe(2);
    expect(groups[0]).toMatchObject({ id: "g1", userText: "list files", toolCount: 2, tokens: 1520 });
    expect(groups[1]).toMatchObject({ id: "g2", userText: "thanks", toolCount: 0 });
  });

  it("concatenates several brain turns in one group", () => {
    const [g] = SessionStore.toGroups("s1", [
      { t: "user", id: "g1", ts: 1, text: "x", attachments: [] },
      { t: "brain", id: "g1", ts: 2, text: "first ", toolCalls: [] },
      { t: "brain", id: "g1", ts: 3, text: "second", toolCalls: [] },
    ]);
    expect(g!.brainText).toBe("first second");
  });

  it("marks a cancelled group", () => {
    const [g] = SessionStore.toGroups("s1", [
      { t: "user", id: "g1", ts: 1, text: "x", attachments: [] },
      { t: "cancel", ts: 2, group: "g1" },
    ]);
    expect(g!.cancelled).toBe(true);
  });
});

describe("clear", () => {
  it("empties the log but keeps the session", async () => {
    const root = await makeRepo();
    const store = new SessionStore(root);
    const { id } = await store.create("keep my name");
    await store.append(id, { t: "user", id: "g1", ts: 1, text: "hi", attachments: [] });
    await store.clear(id);

    expect(await store.read(id)).toEqual([]);
    // The session itself survives — "clear" forgets the conversation, not the session.
    const meta = await store.readMeta(id);
    expect(meta.name).toBe("keep my name");
    expect((await store.list()).map((m) => m.id)).toContain(id);
  });

  it("drops snapshots, whose groups are gone", async () => {
    const root = await makeRepo();
    const store = new SessionStore(root);
    const meta = await store.create();
    await store.writeMeta({ ...meta, snapshots: [{ groupId: "g1", gitRef: "refs/x" }] });
    await store.clear(meta.id);
    expect((await store.readMeta(meta.id)).snapshots).toEqual([]);
  });

  it("is safe on an already empty session", async () => {
    const store = new SessionStore(await makeRepo());
    const { id } = await store.create();
    await store.clear(id);
    expect(await store.read(id)).toEqual([]);
  });
});
