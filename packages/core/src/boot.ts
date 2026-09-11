import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveInRoot, toRepoPath } from "./paths.js";

/**
 * §7 layers 2 and 3 — the project's own instructions, and the index of what skills exist.
 */

export interface BootFile {
  /** Repo-relative, as the model should refer to it. */
  path: string;
  content: string;
}

/** AGENTS.md and CLAUDE.md say the same kind of thing; loading both is duplication. */
const EQUIVALENT = ["AGENTS.md", "CLAUDE.md"];

/**
 * Load the boot sequence named by `config.boot`, in order.
 *
 * A trailing slash means a directory: every file inside is loaded, alphabetically, so
 * the order does not depend on the filesystem. Missing entries are skipped silently —
 * the default list names five things most projects will not have.
 */
export async function loadBoot(root: string, boot: readonly string[]): Promise<BootFile[]> {
  // §7: AGENTS or CLAUDE, first found — unless the user listed both deliberately, which
  // says they mean different things in this project.
  const listedEquivalents = boot.filter((b) => EQUIVALENT.includes(b));
  const bothListedDeliberately = listedEquivalents.length > 1
    && !EQUIVALENT.every((e) => boot.includes(e) && boot.length >= 4);
  let equivalentTaken = false;

  const out: BootFile[] = [];
  for (const entry of boot) {
    const isEquivalent = EQUIVALENT.includes(entry);
    if (isEquivalent && equivalentTaken && !bothListedDeliberately) continue;

    let absolute: string;
    try {
      absolute = await resolveInRoot(root, entry.replace(/\/$/, ""));
    } catch {
      // Outside the root: the same rule as every other path in the harness.
      continue;
    }

    const info = await stat(absolute).catch(() => undefined);
    if (!info) continue;

    if (info.isDirectory()) {
      const names = (await readdir(absolute).catch(() => [])).sort();
      for (const name of names) {
        const file = join(absolute, name);
        if (!(await stat(file).catch(() => undefined))?.isFile()) continue;
        const content = await readFile(file, "utf8").catch(() => undefined);
        if (content !== undefined) out.push({ path: toRepoPath(root, file), content });
      }
      continue;
    }

    const content = await readFile(absolute, "utf8").catch(() => undefined);
    if (content === undefined) continue;
    out.push({ path: toRepoPath(root, absolute), content });
    if (isEquivalent) equivalentTaken = true;
  }
  return out;
}

export interface Skill {
  name: string;
  description: string;
}

export interface SkillScan {
  skills: Skill[];
  /** Skills that could not be indexed, so the user can be told once. */
  skipped: string[];
}

/**
 * Read `skills/*​/SKILL.md` frontmatter.
 *
 * A skill with no frontmatter, or with no description, is skipped rather than guessed
 * at: the index exists so the model can tell when a skill is relevant, and a name alone
 * does not do that. The names are reported so the user hears about it once.
 */
export async function readSkills(root: string): Promise<SkillScan> {
  const dir = join(root, "skills");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const skills: Skill[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const body = await readFile(join(dir, entry.name, "SKILL.md"), "utf8").catch(() => undefined);
    // No SKILL.md at all is not a broken skill; it is not a skill.
    if (body === undefined) continue;

    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
    const description = frontmatter
      ? /^description:\s*(.+)$/m.exec(frontmatter[1]!)?.[1]?.trim()
      : undefined;
    if (!description) {
      skipped.push(entry.name);
      continue;
    }
    const name = frontmatter
      ? /^name:\s*(.+)$/m.exec(frontmatter[1]!)?.[1]?.trim() ?? entry.name
      : entry.name;
    skills.push({ name, description });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, skipped };
}

/** §7 layer 3: one line each, so the whole index costs almost nothing. */
export const skillIndex = (skills: readonly Skill[]): string =>
  skills.map((s) => `${s.name} — ${s.description}`).join("\n");
