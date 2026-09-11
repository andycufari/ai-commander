import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { LogEntry } from "@aicommander/protocol";
import { ensureProjectDir } from "../src/config.js";
import { SessionStore, groupOf } from "../src/sessions.js";

const run = promisify(execFile);
const roots: string[] = [];
const makeRepo = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "aic-rw-"));
  roots.push(root);
  await ensureProjectDir(root);
  return root;
};
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const user = (id: string, text: string, ts: number): LogEntry =>
  ({ t: "user", id, ts, text, attachments: [] });
const brain = (id: string, text: string, ts: number): LogEntry =>
  ({ t: "brain", id, ts, text, toolCalls: [] });
const tool = (id: string, ts: number, outputPath: string | null = null): LogEntry =>
  ({ t: "tool", id, ts, callId: `c${ts}`, name: "read_file", args: {}, ok: true,
     summary: "12 lines", outputPath, tokens: 100 });

describe("groupOf", () => {
  it("names the group of every entry that has one", () => {
    expect(groupOf(user("g1", "x", 1))).toBe("g1");
    expect(groupOf(tool("g1", 2))).toBe("g1");
    expect(groupOf({ t: "snapshot", ts: 3, group: "g1", ref: "r" })).toBe("g1");
    expect(groupOf({ t: "cancel", ts: 4, group: "g1" })).toBe("g1");
  });

  it("returns nothing for entries that belong to no group", () => {
    expect(groupOf({ t: "compact", ts: 5, upTo: "g1", summaryPath: "p", before: 1, after: 1 }))
      .toBeUndefined();
  });
});

describe("upTo", () => {
  it("keeps everything through the named group", async () => {
    const store = new SessionStore(await makeRepo());
    const { id } = await store.create();
    for (const e of [user("g1","a",1), brain("g1","A",2), user("g2","b",3), brain("g2","B",4),
                     user("g3","c",5)]) {
      await store.append(id, e);
    }
    const kept = await store.upTo(id, "g2");
    expect(kept.map(groupOf)).toEqual(["g1","g1","g2","g2"]);
  });

  it("includes the whole group, not just its first entry", async () => {
    const store = new SessionStore(await makeRepo());
    const { id } = await store.create();
    for (const e of [user("g1","a",1), tool("g1",2), brain("g1","A",3), user("g2","b",4)]) {
      await store.append(id, e);
    }
    expect((await store.upTo(id, "g1")).length).toBe(3);
  });

  it("returns everything for an unknown group", async () => {
    const store = new SessionStore(await makeRepo());
    const { id } = await store.create();
    await store.append(id, user("g1", "a", 1));
    expect((await store.upTo(id, "nope")).length).toBe(1);
  });
});

describe("fork", () => {
  it("copies the log up to the group into a new session", async () => {
    const store = new SessionStore(await makeRepo());
    const source = await store.create("original", "m1");
    for (const e of [user("g1","a",1), brain("g1","A",2), user("g2","b",3)]) {
      await store.append(source.id, e);
    }
    const forked = await store.fork(source.id, "g1");

    expect(forked.id).not.toBe(source.id);
    expect(forked.forkedFrom).toBe(source.id);
    expect(forked.name).toBe("original (fork)");
    expect((await store.read(forked.id)).map(groupOf)).toEqual(["g1", "g1"]);
    // The original is untouched.
    expect((await store.read(source.id)).length).toBe(3);
  });

  it("carries the model and session options across", async () => {
    const store = new SessionStore(await makeRepo());
    const source = await store.create("s", "qwen3-27b");
    await store.writeMeta({ ...source, specialTools: ["sql"] });
    await store.append(source.id, user("g1", "a", 1));
    const forked = await store.fork(source.id, "g1");
    expect(forked.model).toBe("qwen3-27b");
    expect(forked.specialTools).toEqual(["sql"]);
  });
});

describe("rewrite and replaceLog", () => {
  it("drops one group and leaves the rest", async () => {
    const store = new SessionStore(await makeRepo());
    const { id } = await store.create();
    for (const e of [user("g1","a",1), user("g2","b",2), user("g3","c",3)]) {
      await store.append(id, e);
    }
    await store.rewrite(id, (e) => groupOf(e) !== "g2");
    expect((await store.read(id)).map(groupOf)).toEqual(["g1", "g3"]);
  });

  it("replaceLog can edit entries in place", async () => {
    const store = new SessionStore(await makeRepo());
    const { id } = await store.create();
    await store.append(id, tool("g1", 1, ".aicommander/out/c1.txt"));
    const edited = (await store.read(id)).map((e) =>
      e.t === "tool" ? { ...e, outputPath: null, tokens: 0 } : e);
    await store.replaceLog(id, edited);

    const back = await store.read(id);
    expect(back[0]).toMatchObject({ t: "tool", outputPath: null, tokens: 0 });
    // The summary survives: the shape of what happened is the useful part.
    expect(back[0]).toMatchObject({ summary: "12 lines" });
  });
});

describe("toGroups token counts", () => {
  it("sums what the log recorded rather than estimating", async () => {
    const store = new SessionStore(await makeRepo());
    const { id } = await store.create();
    await store.append(id, user("g1", "a", 1));
    await store.append(id, tool("g1", 2));
    await store.append(id, tool("g1", 3));
    const groups = SessionStore.toGroups(id, await store.read(id));
    expect(groups[0]).toMatchObject({ tokens: 200, toolCount: 2 });
  });
});
