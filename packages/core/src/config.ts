import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Config, DEFAULT_RULES, PartialConfig, Rules } from "@aicommander/protocol";

/** §9: global (~/.aicommander) merged with project (.aicommander); project wins. */

export const globalDir = (): string => join(homedir(), ".aicommander");
export const projectDir = (root: string): string => join(root, ".aicommander");

/** The brain has no safe default — a config with no endpoint anywhere is an error,
 *  unless `serve --brain` supplies one. */
const FALLBACK_BRAIN = { endpoint: "http://127.0.0.1:8080/v1", model: "local", apiKey: "" };

const readJson = async (path: string): Promise<unknown | undefined> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${path}: ${(err as Error).message}`);
  }
};

/** Deep merge where a later source's defined leaves win. Arrays replace, never concat. */
const merge = (...sources: unknown[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      if (v === undefined) continue;
      const prev = out[k];
      out[k] =
        v && typeof v === "object" && !Array.isArray(v) && prev && typeof prev === "object" && !Array.isArray(prev)
          ? merge(prev, v)
          : v;
    }
  }
  return out;
};

export interface LoadedConfig {
  config: Config;
  rules: Rules;
  /** Where each layer came from, for the options modal's session/project/global labels. */
  sources: { global?: PartialConfig; project?: PartialConfig; override?: PartialConfig };
}

/**
 * `override` is the CLI layer (`serve --brain <url>`); it wins over both files
 * but is never written back to disk.
 */
export async function loadConfig(root: string, override?: PartialConfig): Promise<LoadedConfig> {
  const g = await readJson(join(globalDir(), "config.json"));
  const p = await readJson(join(projectDir(root), "config.json"));

  const globalCfg = g ? PartialConfig.parse(g) : undefined;
  const projectCfg = p ? PartialConfig.parse(p) : undefined;

  const merged = merge({ brain: FALLBACK_BRAIN }, globalCfg, projectCfg, override);
  const config = Config.parse(merged);

  const gr = await readJson(join(globalDir(), "rules.json"));
  const pr = await readJson(join(projectDir(root), "rules.json"));
  const rules = mergeRules(
    gr ? Rules.parse(gr) : DEFAULT_RULES,
    pr ? Rules.parse(pr) : { danger: [], allow: [] },
  );

  return { config, rules, sources: { global: globalCfg, project: projectCfg, override } };
}

/** §8: project wins on same id; the built-in outside-root rule always survives. */
export function mergeRules(base: Rules, project: Rules): Rules {
  const pick = (a: Rules["danger"], b: Rules["danger"]) => {
    const byId = new Map(a.map((r) => [r.id, r]));
    for (const r of b) byId.set(r.id, r);
    return [...byId.values()];
  };
  const danger = pick(base.danger, project.danger);
  if (!danger.some((r) => r.id === "outside-root")) {
    danger.push(DEFAULT_RULES.danger.find((r) => r.id === "outside-root")!);
  }
  return { danger, allow: pick(base.allow, project.allow) };
}

/** Create `.aicommander/` on first open (§4 layout). Returns true if it was created. */
export async function ensureProjectDir(root: string): Promise<boolean> {
  const dir = projectDir(root);
  const existed = (await readJson(join(dir, "config.json"))) !== undefined;
  for (const sub of ["sessions", "out", "snapshots", "viewers"]) {
    await mkdir(join(dir, sub), { recursive: true });
  }
  if (!existed) {
    try {
      await writeFile(join(dir, "config.json"), "{}\n", { flag: "wx" });
    } catch {
      // already there — another process won the race, fine
    }
  }
  return !existed;
}
