import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { ensureProjectDir } from "../src/config.js";
import { git } from "../src/intents.js";
import {
  isDirty, pruneSnapshots, restoreSnapshot, snapshotPaths, takeSnapshot,
} from "../src/snapshots.js";

/** §6 guard 6. Plumbing only: HEAD and the user's index are never touched. */

const run = promisify(execFile);
const roots: string[] = [];

const makeRepo = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "aic-snap-"));
  roots.push(root);
  await ensureProjectDir(root);
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "t@t"], { cwd: root });
  await run("git", ["config", "user.name", "t"], { cwd: root });
  await writeFile(join(root, ".gitignore"), "ignored/\n*.log\n");
  await writeFile(join(root, "kept.txt"), "original\n");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "main.c"), "int main(){}\n");
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["commit", "-qm", "first"], { cwd: root });
  return root;
};
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe("takeSnapshot", () => {
  it("captures the working tree and makes a ref", async () => {
    const root = await makeRepo();
    const snap = await takeSnapshot(root, "s1", "g1");
    expect(snap).toBeTruthy();
    expect(snap!.ref).toBe("refs/aicommander/s1-g1");
    const paths = await snapshotPaths(root, snap!.tree);
    expect(paths).toContain("kept.txt");
    expect(paths).toContain("src/main.c");
  });

  it("never moves HEAD", async () => {
    const root = await makeRepo();
    const before = (await git(root, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(root, "new.txt"), "x\n");
    await takeSnapshot(root, "s1", "g1");
    expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(before);
  });

  it("never disturbs the user's staging area", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "staged.txt"), "staged\n");
    await run("git", ["add", "staged.txt"], { cwd: root });
    const before = await git(root, ["diff", "--cached", "--name-only"]);

    await writeFile(join(root, "unstaged.txt"), "not staged\n");
    await takeSnapshot(root, "s1", "g1");

    // The index still holds exactly what the user put there.
    expect(await git(root, ["diff", "--cached", "--name-only"])).toBe(before);
  });

  it("is invisible to git log and status", async () => {
    const root = await makeRepo();
    await takeSnapshot(root, "s1", "g1");
    expect(await git(root, ["log", "--oneline"])).not.toContain("aicommander");
    expect(await git(root, ["status", "--porcelain"])).not.toContain("tmp-index");
  });

  it("respects .gitignore and nothing else", async () => {
    const root = await makeRepo();
    await mkdir(join(root, "ignored"), { recursive: true });
    await writeFile(join(root, "ignored", "junk.txt"), "junk\n");
    await writeFile(join(root, "debug.log"), "noise\n");
    await writeFile(join(root, "wanted.txt"), "wanted\n");

    const snap = await takeSnapshot(root, "s1", "g1");
    const paths = await snapshotPaths(root, snap!.tree);
    expect(paths).toContain("wanted.txt");
    expect(paths).not.toContain("ignored/junk.txt");
    expect(paths).not.toContain("debug.log");
  });

  it("excludes the session log and captured output it writes itself", async () => {
    const root = await makeRepo();
    await mkdir(join(root, ".aicommander", "sessions", "s1"), { recursive: true });
    await writeFile(join(root, ".aicommander", "sessions", "s1", "session.jsonl"), "{}\n");
    await writeFile(join(root, ".aicommander", "out", "c1.txt"), "captured\n");
    await writeFile(join(root, ".aicommander", "config.json"), "{}\n");

    const snap = await takeSnapshot(root, "s1", "g1");
    const paths = await snapshotPaths(root, snap!.tree);
    expect([...paths].some((p) => p.includes("sessions/"))).toBe(false);
    expect([...paths].some((p) => p.includes(".aicommander/out/"))).toBe(false);
    // Config is the user's, so it stays.
    expect(paths).toContain(".aicommander/config.json");
  });

  it("reports size and time for the cost readout", async () => {
    const root = await makeRepo();
    const snap = await takeSnapshot(root, "s1", "g1");
    expect(snap!.bytes).toBeGreaterThan(0);
    expect(snap!.ms).toBeGreaterThanOrEqual(0);
  });

  it("returns undefined in a repo with no git rather than failing the turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "aic-nogit-"));
    roots.push(root);
    await ensureProjectDir(root);
    await writeFile(join(root, "a.txt"), "x\n");
    expect(await takeSnapshot(root, "s1", "g1")).toBeUndefined();
  });
});

describe("restoreSnapshot", () => {
  it("puts back a modified file", async () => {
    const root = await makeRepo();
    const snap = await takeSnapshot(root, "s1", "g1");
    await writeFile(join(root, "kept.txt"), "changed by the brain\n");
    await restoreSnapshot(root, snap!.tree);
    expect(await readFile(join(root, "kept.txt"), "utf8")).toBe("original\n");
  });

  it("brings back a deleted file", async () => {
    const root = await makeRepo();
    const snap = await takeSnapshot(root, "s1", "g1");
    await rm(join(root, "src", "main.c"));
    await restoreSnapshot(root, snap!.tree);
    expect(await readFile(join(root, "src", "main.c"), "utf8")).toBe("int main(){}\n");
  });

  it("removes a file created after the snapshot", async () => {
    // Without this half, a rewind would leave the brain's new files behind.
    const root = await makeRepo();
    const snap = await takeSnapshot(root, "s1", "g1");
    await writeFile(join(root, "invented.txt"), "the brain made this\n");
    const result = await restoreSnapshot(root, snap!.tree);
    await expect(readFile(join(root, "invented.txt"), "utf8")).rejects.toThrow();
    expect(result.deleted).toBe(1);
  });

  it("removes a created file even in a new directory, and prunes the husk", async () => {
    const root = await makeRepo();
    const snap = await takeSnapshot(root, "s1", "g1");
    await mkdir(join(root, "invented"), { recursive: true });
    await writeFile(join(root, "invented", "deep.txt"), "x\n");
    await restoreSnapshot(root, snap!.tree);
    await expect(readFile(join(root, "invented", "deep.txt"), "utf8")).rejects.toThrow();
  });

  it("leaves ignored files alone", async () => {
    const root = await makeRepo();
    const snap = await takeSnapshot(root, "s1", "g1");
    await writeFile(join(root, "debug.log"), "logs are not the brain's doing\n");
    await restoreSnapshot(root, snap!.tree);
    // .gitignore decides what is in the repo; a rewind does not delete what it excludes.
    expect(await readFile(join(root, "debug.log"), "utf8")).toContain("not the brain");
  });

  it("never touches .aicommander", async () => {
    const root = await makeRepo();
    const snap = await takeSnapshot(root, "s1", "g1");
    await mkdir(join(root, ".aicommander", "sessions", "s1"), { recursive: true });
    await writeFile(join(root, ".aicommander", "sessions", "s1", "session.jsonl"), "the log\n");
    await restoreSnapshot(root, snap!.tree);
    expect(await readFile(join(root, ".aicommander", "sessions", "s1", "session.jsonl"), "utf8"))
      .toBe("the log\n");
  });

  it("still leaves HEAD and the index alone", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "staged.txt"), "s\n");
    await run("git", ["add", "staged.txt"], { cwd: root });
    const head = (await git(root, ["rev-parse", "HEAD"])).trim();
    const staged = await git(root, ["diff", "--cached", "--name-only"]);

    const snap = await takeSnapshot(root, "s1", "g1");
    await writeFile(join(root, "kept.txt"), "changed\n");
    await restoreSnapshot(root, snap!.tree);

    expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(head);
    expect(await git(root, ["diff", "--cached", "--name-only"])).toBe(staged);
  });
});

describe("pruneSnapshots", () => {
  it("drops every ref for a session", async () => {
    const root = await makeRepo();
    await takeSnapshot(root, "s1", "g1");
    await takeSnapshot(root, "s1", "g2");
    await takeSnapshot(root, "s2", "g1");
    expect(await pruneSnapshots(root, "s1")).toBe(2);
    const left = await git(root, ["for-each-ref", "--format=%(refname)", "refs/aicommander/"]);
    expect(left).toContain("s2-g1");
    expect(left).not.toContain("s1-");
  });

  it("drops one group's ref", async () => {
    const root = await makeRepo();
    await takeSnapshot(root, "s1", "g1");
    await takeSnapshot(root, "s1", "g2");
    expect(await pruneSnapshots(root, "s1", "g1")).toBe(1);
    const left = await git(root, ["for-each-ref", "--format=%(refname)", "refs/aicommander/"]);
    expect(left).toContain("s1-g2");
    expect(left).not.toContain("s1-g1");
  });
});

describe("isDirty", () => {
  it("is false on a clean tree and true after an edit", async () => {
    const root = await makeRepo();
    expect(await isDirty(root)).toBe(false);
    await writeFile(join(root, "kept.txt"), "edited\n");
    expect(await isDirty(root)).toBe(true);
  });

  it("ignores .aicommander churn", async () => {
    const root = await makeRepo();
    await writeFile(join(root, ".aicommander", "workspace.json"), "{}\n");
    expect(await isDirty(root)).toBe(false);
  });
});
