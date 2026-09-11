import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadBoot, readSkills, skillIndex } from "../src/boot.js";

/** §7 layers 2 and 3: the project's own instructions, and what skills exist. */

const roots: string[] = [];
const makeRepo = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "aic-boot-"));
  roots.push(root);
  return root;
};
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const DEFAULT_BOOT = ["AGENTS.md", "CLAUDE.md", "BOOT.md", "SOUL.md", "rules/"];

describe("loadBoot", () => {
  it("loads the files config.boot names, in order", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "BOOT.md"), "boot rules\n");
    await writeFile(join(root, "SOUL.md"), "the soul\n");
    const loaded = await loadBoot(root, ["BOOT.md", "SOUL.md"]);
    expect(loaded.map((f) => f.path)).toEqual(["BOOT.md", "SOUL.md"]);
    expect(loaded[0]!.content).toContain("boot rules");
  });

  it("skips what is not there without complaining", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "SOUL.md"), "only this\n");
    expect((await loadBoot(root, DEFAULT_BOOT)).map((f) => f.path)).toEqual(["SOUL.md"]);
  });

  it("takes AGENTS.md or CLAUDE.md, whichever comes first — not both", async () => {
    // §7: "AGENTS or CLAUDE, first found, unless both listed explicitly".
    const root = await makeRepo();
    await writeFile(join(root, "AGENTS.md"), "agents\n");
    await writeFile(join(root, "CLAUDE.md"), "claude\n");
    const loaded = await loadBoot(root, DEFAULT_BOOT);
    expect(loaded.map((f) => f.path)).toEqual(["AGENTS.md"]);
  });

  it("loads CLAUDE.md when AGENTS.md is absent", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "CLAUDE.md"), "claude\n");
    expect((await loadBoot(root, DEFAULT_BOOT)).map((f) => f.path)).toEqual(["CLAUDE.md"]);
  });

  it("loads both when the user listed both deliberately", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "AGENTS.md"), "agents\n");
    await writeFile(join(root, "CLAUDE.md"), "claude\n");
    const loaded = await loadBoot(root, ["AGENTS.md", "CLAUDE.md"]);
    expect(loaded.map((f) => f.path)).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("expands a directory entry into the files inside it", async () => {
    const root = await makeRepo();
    await mkdir(join(root, "rules"), { recursive: true });
    await writeFile(join(root, "rules", "b.md"), "second\n");
    await writeFile(join(root, "rules", "a.md"), "first\n");
    const loaded = await loadBoot(root, ["rules/"]);
    // Alphabetical, so the order is predictable across machines.
    expect(loaded.map((f) => f.path)).toEqual(["rules/a.md", "rules/b.md"]);
  });

  it("refuses to escape the repo root", async () => {
    const root = await makeRepo();
    expect(await loadBoot(root, ["../../../etc/passwd"])).toEqual([]);
  });

  it("returns nothing for a project with no boot files", async () => {
    expect(await loadBoot(await makeRepo(), DEFAULT_BOOT)).toEqual([]);
  });
});

describe("readSkills", () => {
  const writeSkill = async (root: string, name: string, body: string): Promise<void> => {
    await mkdir(join(root, "skills", name), { recursive: true });
    await writeFile(join(root, "skills", name, "SKILL.md"), body);
  };

  it("reads name and description from the frontmatter", async () => {
    const root = await makeRepo();
    await writeSkill(root, "esp32-lowpower",
      "---\nname: esp32-lowpower\ndescription: deep sleep tuning\n---\n\n# body\n");
    const { skills } = await readSkills(root);
    expect(skills).toEqual([{ name: "esp32-lowpower", description: "deep sleep tuning" }]);
  });

  it("falls back to the directory name when frontmatter omits it", async () => {
    const root = await makeRepo();
    await writeSkill(root, "kicad-review", "---\ndescription: schematic review\n---\n");
    expect((await readSkills(root)).skills[0]).toEqual({
      name: "kicad-review", description: "schematic review",
    });
  });

  it("skips a skill with no frontmatter and reports it", async () => {
    const root = await makeRepo();
    await writeSkill(root, "good", "---\ndescription: fine\n---\n");
    await writeSkill(root, "bare", "# just a heading, no frontmatter\n");
    const { skills, skipped } = await readSkills(root);
    expect(skills.map((s) => s.name)).toEqual(["good"]);
    expect(skipped).toEqual(["bare"]);
  });

  it("skips a skill whose frontmatter has no description", async () => {
    // A name with no description tells the model nothing about when to reach for it.
    const root = await makeRepo();
    await writeSkill(root, "nameless", "---\nname: nameless\n---\n");
    const { skills, skipped } = await readSkills(root);
    expect(skills).toEqual([]);
    expect(skipped).toEqual(["nameless"]);
  });

  it("ignores a directory with no SKILL.md at all", async () => {
    const root = await makeRepo();
    await mkdir(join(root, "skills", "empty"), { recursive: true });
    const { skills, skipped } = await readSkills(root);
    expect(skills).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("returns nothing when there is no skills directory", async () => {
    expect(await readSkills(await makeRepo())).toEqual({ skills: [], skipped: [] });
  });

  it("sorts by name so the index is stable", async () => {
    const root = await makeRepo();
    await writeSkill(root, "zebra", "---\ndescription: z\n---\n");
    await writeSkill(root, "alpha", "---\ndescription: a\n---\n");
    expect((await readSkills(root)).skills.map((s) => s.name)).toEqual(["alpha", "zebra"]);
  });
});

describe("skillIndex", () => {
  it("is one line per skill", () => {
    const text = skillIndex([
      { name: "a", description: "does a" },
      { name: "b", description: "does b" },
    ]);
    expect(text).toBe("a — does a\nb — does b");
  });

  it("is empty when there are no skills", () => {
    expect(skillIndex([])).toBe("");
  });
});
