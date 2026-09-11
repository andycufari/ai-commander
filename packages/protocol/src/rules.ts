import { z } from "zod";

/** §8 permissions. rules.json: global merged with project, project wins on same id. */

export const RuleLevel = z.enum(["danger", "warning"]);
export type RuleLevel = z.infer<typeof RuleLevel>;

/** Which tool a rule applies to; omitted means every tool. */
export const RuleTool = z.enum(["shell", "git", "write_file", "edit_file"]);
export type RuleTool = z.infer<typeof RuleTool>;

export const Rule = z.object({
  id: z.string().min(1),
  /** JS regex source, matched against the rule's subject (shell cmd, git args, path). */
  match: z.string().optional(),
  tool: RuleTool.optional(),
  note: z.string().optional(),
  level: RuleLevel.default("danger"),
  /** Built-in rules are enforced in code and cannot be removed (e.g. outside-root). */
  builtin: z.boolean().default(false),
});
export type Rule = z.infer<typeof Rule>;

export const Rules = z.object({
  danger: z.array(Rule).default([]),
  allow: z.array(Rule).default([]),
});
export type Rules = z.infer<typeof Rules>;

/** §8 defaults. `outside-root` is built-in and always enforced. */
export const DEFAULT_RULES: Rules = {
  danger: [
    { id: "rm-rf", match: "\\brm\\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)", tool: "shell", note: "recursive delete", level: "danger", builtin: false },
    { id: "git-force", match: "push\\s+.*--force|push\\s+-f", tool: "git", level: "danger", builtin: false },
    { id: "git-reset-hard", match: "reset\\s+--hard", tool: "git", level: "danger", builtin: false },
    { id: "sudo", match: "^\\s*sudo\\b", tool: "shell", level: "danger", builtin: false },
    { id: "outside-root", level: "danger", builtin: true, note: "path outside the repo root" },
    { id: "network", match: "\\b(curl|wget|nc|ssh|scp)\\b", tool: "shell", level: "warning", builtin: false },
  ],
  allow: [],
};

export const PermissionAnswer = z.enum(["once", "session", "deny"]);
export type PermissionAnswer = z.infer<typeof PermissionAnswer>;
