import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "@aicommander/protocol";
import { loadConfig, mergeRules } from "../src/config.js";

const roots: string[] = [];
const makeRepo = async (project?: unknown): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "aic-c-"));
  roots.push(dir);
  if (project !== undefined) {
    await mkdir(join(dir, ".aicommander"), { recursive: true });
    await writeFile(join(dir, ".aicommander", "config.json"), JSON.stringify(project));
  }
  return dir;
};
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("applies project config over the fallback", async () => {
    const root = await makeRepo({ brain: { endpoint: "http://box:8080/v1", model: "qwen3-27b" }, mode: "auto" });
    const { config } = await loadConfig(root);
    expect(config.brain.model).toBe("qwen3-27b");
    expect(config.mode).toBe("auto");
    expect(config.loop.shellTimeoutSec).toBe(120);
  });

  it("lets --brain win over the project file", async () => {
    const root = await makeRepo({ brain: { endpoint: "http://box:8080/v1", model: "qwen3-27b" } });
    const { config } = await loadConfig(root, { brain: { endpoint: "http://other:9000/v1" } });
    expect(config.brain.endpoint).toBe("http://other:9000/v1");
    // the override touches only the endpoint; the rest of the brain block survives
    expect(config.brain.model).toBe("qwen3-27b");
  });

  it("works with no config file at all", async () => {
    const { config } = await loadConfig(await makeRepo());
    expect(config.mode).toBe("ask");
    expect(config.brain.endpoint).toContain("127.0.0.1");
  });

  it("reports which file is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "aic-c-"));
    roots.push(root);
    await mkdir(join(root, ".aicommander"), { recursive: true });
    await writeFile(join(root, ".aicommander", "config.json"), "{ not json");
    await expect(loadConfig(root)).rejects.toThrow(/config\.json/);
  });
});

describe("mergeRules", () => {
  it("lets the project win on a shared id", () => {
    const merged = mergeRules(DEFAULT_RULES, {
      danger: [{ id: "network", match: "\\bcurl\\b", tool: "shell", level: "danger", builtin: false }],
      allow: [],
    });
    expect(merged.danger.find((r) => r.id === "network")?.level).toBe("danger");
  });

  it("keeps outside-root even if the project drops it", () => {
    const merged = mergeRules({ danger: [], allow: [] }, { danger: [], allow: [] });
    expect(merged.danger.find((r) => r.id === "outside-root")?.builtin).toBe(true);
  });

  it("adds project-only rules", () => {
    const merged = mergeRules(DEFAULT_RULES, {
      danger: [],
      allow: [{ id: "npm-test", match: "^npm (test|run lint)$", tool: "shell", level: "danger", builtin: false }],
    });
    expect(merged.allow.map((r) => r.id)).toContain("npm-test");
  });
});
