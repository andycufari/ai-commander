import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Config } from "@aicommander/protocol";
import { capOutput, globToRegExp, runTool, toolSpecs, type ToolCtx } from "../src/tools.js";
import { CORE_ENABLED } from "../src/loop.js";

const roots: string[] = [];
const config = Config.parse({ brain: { endpoint: "http://x/v1", model: "m" } });

const makeCtx = async (): Promise<ToolCtx> => {
  const root = await mkdtemp(join(tmpdir(), "aic-t-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "main.c"), "int main(){\n  return 0;\n}\n");
  await writeFile(join(root, "README.md"), "# hello\nworld\n");
  return {
    root, config, callId: "c1",
    outPath: (id) => join(root, ".aicommander", "out", `${id}.txt`),
  };
};
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe("read_file", () => {
  it("returns numbered lines", async () => {
    const ctx = await makeCtx();
    const res = await runTool("read_file", { path: "src/main.c" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.content).toContain("    1  int main(){");
    expect(res.summary).toBe("3 lines");
  });

  it("honours a range", async () => {
    const ctx = await makeCtx();
    const res = await runTool("read_file", { path: "src/main.c", range: { start: 2, end: 2 } }, ctx);
    expect(res.content.trim()).toMatch(/^2\s+return 0;$/);
  });

  it("reports a missing file without throwing", async () => {
    const ctx = await makeCtx();
    const res = await runTool("read_file", { path: "nope.c" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/no such file/);
  });

  it("refuses to escape the repo root", async () => {
    const ctx = await makeCtx();
    const res = await runTool("read_file", { path: "../../etc/passwd" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/escapes the repo root/);
  });
});

describe("write_file and edit_file", () => {
  it("writes, creating directories", async () => {
    const ctx = await makeCtx();
    const res = await runTool("write_file", { path: "a/b/c.md", content: "hi\n" }, ctx);
    expect(res.ok).toBe(true);
    expect(await readFile(join(ctx.root, "a/b/c.md"), "utf8")).toBe("hi\n");
  });

  it("edits an exact match and returns a diff", async () => {
    const ctx = await makeCtx();
    const res = await runTool("edit_file", { path: "README.md", old: "world", new: "there" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.content).toContain("-world");
    expect(res.content).toContain("+there");
    expect(await readFile(join(ctx.root, "README.md"), "utf8")).toBe("# hello\nthere\n");
  });

  it("refuses when the text is not found", async () => {
    const ctx = await makeCtx();
    const res = await runTool("edit_file", { path: "README.md", old: "absent", new: "x" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/not found/);
  });

  it("refuses an ambiguous edit unless all is set", async () => {
    const ctx = await makeCtx();
    await writeFile(join(ctx.root, "dup.txt"), "x\nx\n");
    const one = await runTool("edit_file", { path: "dup.txt", old: "x", new: "y" }, ctx);
    expect(one.ok).toBe(false);
    expect(one.summary).toMatch(/2 matches/);
    const all = await runTool("edit_file", { path: "dup.txt", old: "x", new: "y", all: true }, ctx);
    expect(all.ok).toBe(true);
    expect(await readFile(join(ctx.root, "dup.txt"), "utf8")).toBe("y\ny\n");
  });
});

describe("glob and grep", () => {
  it("globs by pattern", async () => {
    const ctx = await makeCtx();
    const res = await runTool("glob", { pattern: "**/*.c" }, ctx);
    expect(res.content).toContain("src/main.c");
    expect(res.content).not.toContain("README.md");
  });

  it("greps for a pattern", async () => {
    const ctx = await makeCtx();
    const res = await runTool("grep", { pattern: "return" }, ctx);
    expect(res.content).toContain("src/main.c");
  });
});

describe("globToRegExp", () => {
  it("matches ** across directories and * within one", () => {
    expect(globToRegExp("**/*.c").test("a/b/main.c")).toBe(true);
    expect(globToRegExp("**/*.c").test("main.c")).toBe(true);
    expect(globToRegExp("*.c").test("a/main.c")).toBe(false);
    expect(globToRegExp("src/*.c").test("src/main.c")).toBe(true);
  });

  it("escapes regex metacharacters in literals", () => {
    expect(globToRegExp("a.b").test("a.b")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("shell", () => {
  it("captures stdout", async () => {
    const ctx = await makeCtx();
    const res = await runTool("shell", { cmd: "echo hello" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.content).toContain("hello");
  });

  it("reports a non-zero exit", async () => {
    const ctx = await makeCtx();
    const res = await runTool("shell", { cmd: "exit 3" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toBe("exit 3");
  });

  it("streams output as it arrives", async () => {
    const ctx = await makeCtx();
    const seen: string[] = [];
    const res = await runTool("shell", { cmd: "echo a; echo b" }, { ...ctx, onOutput: (d) => seen.push(d) });
    expect(res.ok).toBe(true);
    expect(seen.join("")).toContain("a");
  });

  it("times out and kills the process", async () => {
    const ctx = await makeCtx();
    const res = await runTool("shell", { cmd: "sleep 5", timeout: 1 }, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/timed out/);
  });
});

describe("capOutput", () => {
  it("passes short output through", async () => {
    const ctx = await makeCtx();
    const r = await capOutput("short", ctx);
    expect(r.truncated).toBe(false);
    expect(r.outputPath).toBeUndefined();
  });

  it("caps long output head/tail and writes the full text out", async () => {
    const ctx = await makeCtx();
    const long = "x".repeat(20000);
    const r = await capOutput(long, ctx);
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBeLessThan(long.length);
    expect(r.outputPath).toBe(".aicommander/out/c1.txt");
    expect((await readFile(join(ctx.root, r.outputPath!), "utf8")).length).toBe(20000);
    expect(r.content).toContain("characters omitted");
  });
});

describe("guard 7 fallout", () => {
  it("turns an unparsable call into a tool error the model can act on", async () => {
    const ctx = await makeCtx();
    const res = await runTool("read_file", { __parseError: "unexpected token", __raw: "{path:" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/could not be parsed/);
    expect(res.content).toMatch(/valid JSON object/);
  });

  it("reports an unknown tool", async () => {
    const ctx = await makeCtx();
    const res = await runTool("teleport", {}, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/unknown tool/);
  });

  it("reports bad args instead of throwing", async () => {
    const ctx = await makeCtx();
    const res = await runTool("read_file", { wrong: true }, ctx);
    expect(res.ok).toBe(false);
  });
});

describe("toolSpecs", () => {
  it("builds JSON Schema for every core tool", () => {
    const specs = toolSpecs(CORE_ENABLED);
    expect(specs).toHaveLength(CORE_ENABLED.length);
    const read = specs.find((s) => s.name === "read_file")!;
    expect(read.parameters).toMatchObject({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
    expect(read.description).toBeTruthy();
  });

  it("marks optional fields as not required", () => {
    const grep = toolSpecs(["grep"])[0]!;
    expect((grep.parameters as { required: string[] }).required).toEqual(["pattern"]);
  });
});
