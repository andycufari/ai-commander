import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Event } from "@aicommander/protocol";
import { shouldIgnore, watchRepo } from "../src/watcher.js";

const roots: string[] = [];
const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "aic-watch-"));
  roots.push(dir);
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, ".aicommander", "sessions", "s1"), { recursive: true });
  await mkdir(join(dir, ".aicommander", "out"), { recursive: true });
  await mkdir(join(dir, ".git"), { recursive: true });
  await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
  return dir;
};
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("shouldIgnore", () => {
  it("ignores the noisy directories", async () => {
    const root = await makeRepo();
    for (const p of [".git/HEAD", "node_modules/pkg/index.js", "src/deep/node_modules/x"]) {
      expect(shouldIgnore(root, join(root, p)), p).toBe(true);
    }
  });

  it("ignores what this process writes on every turn", async () => {
    const root = await makeRepo();
    expect(shouldIgnore(root, join(root, ".aicommander/sessions/s1/session.jsonl"))).toBe(true);
    expect(shouldIgnore(root, join(root, ".aicommander/out/c1.txt"))).toBe(true);
  });

  it("still watches the rest of .aicommander", async () => {
    const root = await makeRepo();
    // Editing config.json or rules.json by hand should be noticed.
    expect(shouldIgnore(root, join(root, ".aicommander/config.json"))).toBe(false);
    expect(shouldIgnore(root, join(root, ".aicommander/workspace.json"))).toBe(false);
  });

  it("watches ordinary repo files", async () => {
    const root = await makeRepo();
    for (const p of ["src/main.c", "README.md", "docs/NOTES.md"]) {
      expect(shouldIgnore(root, join(root, p)), p).toBe(false);
    }
  });
});

describe("watchRepo", () => {
  it("reports a changed file as a repo-relative path", async () => {
    const root = await makeRepo();
    const events: Event[] = [];
    const w = watchRepo(root, (e) => events.push(e), () => "id", 100);
    await sleep(400);
    await writeFile(join(root, "src", "new.c"), "x");
    await sleep(700);
    await w.close();

    const changed = events.filter((e) => e.type === "fs.changed") as { paths: string[] }[];
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.flatMap((e) => e.paths)).toContain("src/new.c");
  }, 15000);

  it("batches a burst into one event", async () => {
    const root = await makeRepo();
    const events: Event[] = [];
    const w = watchRepo(root, (e) => events.push(e), () => "id", 200);
    await sleep(400);
    // A dozen writes in a row is what `git checkout` looks like.
    for (let i = 0; i < 12; i += 1) await writeFile(join(root, `f${i}.txt`), "x");
    await sleep(900);
    await w.close();

    const changed = events.filter((e) => e.type === "fs.changed") as { paths: string[] }[];
    expect(changed.length).toBeLessThan(4);
    expect(changed.flatMap((e) => e.paths).length).toBeGreaterThanOrEqual(12);
  }, 15000);

  it("says nothing about ignored directories", async () => {
    const root = await makeRepo();
    const events: Event[] = [];
    const w = watchRepo(root, (e) => events.push(e), () => "id", 100);
    await sleep(400);
    await writeFile(join(root, ".git", "COMMIT_EDITMSG"), "x");
    await writeFile(join(root, ".aicommander", "sessions", "s1", "session.jsonl"), "{}");
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "x");
    await sleep(700);
    await w.close();

    const paths = (events.filter((e) => e.type === "fs.changed") as { paths: string[] }[])
      .flatMap((e) => e.paths);
    expect(paths).toEqual([]);
  }, 15000);
});
