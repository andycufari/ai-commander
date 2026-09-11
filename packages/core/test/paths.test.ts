import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PathEscapeError, resolveInRoot, toRepoPath } from "../src/paths.js";

/** §13: "Never write outside the repo root from any tool. Add a test that proves it." */

const roots: string[] = [];
const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "aic-"));
  roots.push(dir);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "main.c"), "int main(){}\n");
  return dir;
};

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe("resolveInRoot", () => {
  it("resolves a relative path inside the repo", async () => {
    const root = await makeRepo();
    const abs = await resolveInRoot(root, "src/main.c");
    expect(abs.endsWith("/src/main.c")).toBe(true);
  });

  it("allows a file that does not exist yet", async () => {
    const root = await makeRepo();
    const abs = await resolveInRoot(root, "docs/new/NOTES.md");
    expect(abs.endsWith("/docs/new/NOTES.md")).toBe(true);
  });

  it("rejects ../ escapes", async () => {
    const root = await makeRepo();
    for (const bad of ["../outside.txt", "src/../../outside.txt", "../../etc/passwd", "src/../.."]) {
      await expect(resolveInRoot(root, bad)).rejects.toBeInstanceOf(PathEscapeError);
    }
  });

  it("rejects an absolute path outside the repo", async () => {
    const root = await makeRepo();
    await expect(resolveInRoot(root, "/etc/passwd")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("accepts an absolute path inside the repo", async () => {
    const root = await makeRepo();
    const abs = await resolveInRoot(root, join(root, "src/main.c"));
    expect(abs.endsWith("/src/main.c")).toBe(true);
  });

  it("rejects a symlink pointing out of the repo", async () => {
    const root = await makeRepo();
    await symlink("/etc", join(root, "escape"));
    await expect(resolveInRoot(root, "escape/passwd")).rejects.toBeInstanceOf(PathEscapeError);
    await expect(resolveInRoot(root, "escape")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects a symlinked file pointing out of the repo", async () => {
    const root = await makeRepo();
    const outside = await mkdtemp(join(tmpdir(), "aic-out-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.txt"), "s");
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    await expect(resolveInRoot(root, "link.txt")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("allows a symlink that stays inside the repo", async () => {
    const root = await makeRepo();
    await symlink(join(root, "src"), join(root, "alias"));
    const abs = await resolveInRoot(root, "alias/main.c");
    expect(abs.endsWith("/src/main.c")).toBe(true);
  });

  it("allows the root itself", async () => {
    const root = await makeRepo();
    expect(await resolveInRoot(root, ".")).toBe(await resolveInRoot(root, ""));
  });

  it("is not fooled by a sibling directory sharing the root's prefix", async () => {
    const root = await makeRepo();
    await expect(resolveInRoot(root, `${root}-evil/x`)).rejects.toBeInstanceOf(PathEscapeError);
  });
});

describe("toRepoPath", () => {
  it("returns a forward-slash relative path", async () => {
    const root = await makeRepo();
    expect(toRepoPath(root, join(root, "src", "main.c"))).toBe("src/main.c");
    expect(toRepoPath(root, root)).toBe(".");
  });

  it("copes with a root and a path spelled differently", async () => {
    // resolveInRoot returns realpath'd absolutes; on macOS /var is a symlink to
    // /private/var, so an unresolved root used to produce a string of ../ instead.
    const root = await makeRepo();
    const resolved = await resolveInRoot(root, "src/main.c");
    expect(toRepoPath(root, resolved)).toBe("src/main.c");
    expect(toRepoPath(resolved.slice(0, resolved.indexOf("/src")), resolved)).toBe("src/main.c");
  });
});
