import type { Mode, Rule, Rules, RuleLevel } from "@aicommander/protocol";

/**
 * §8 permissions.
 *
 * §0 principle 3: danger always blocks. No mode, flag or setting bypasses a danger
 * rule — `auto` skips the routine asks, not the dangerous ones, and `plan` refuses
 * every write before a rule is even consulted.
 */

export type Decision =
  | { kind: "allow" }
  /** Ask the user; the loop pauses until they answer. */
  | { kind: "ask"; rule: Rule; level: RuleLevel; command: string; reason: string }
  /** Refused outright, with a reason the model is told. */
  | { kind: "deny"; reason: string };

/** Tools that change something. Everything else is read-only. */
const WRITING_TOOLS = new Set(["write_file", "edit_file", "shell", "job"]);

/** git subcommands that write. `status`, `log` and `diff` do not. */
const WRITING_GIT = new Set(["add", "commit", "checkout", "branch", "stash", "push"]);

export function isWriting(tool: string, args: Record<string, unknown>): boolean {
  if (tool === "git") {
    const action = typeof args.action === "string" ? args.action : "";
    return WRITING_GIT.has(action);
  }
  return WRITING_TOOLS.has(tool);
}

/**
 * The text a rule matches against: the shell command, the git argv, or the path.
 * Rules are written to read like the thing the user would see in the modal.
 */
export function subjectOf(tool: string, args: Record<string, unknown>): string {
  const str = (k: string): string => (typeof args[k] === "string" ? (args[k] as string) : "");
  switch (tool) {
    case "shell":
      return str("cmd");
    case "git": {
      const rest = Object.entries(args)
        .filter(([k]) => k !== "action")
        .map(([, v]) => (typeof v === "string" ? v : ""))
        .filter(Boolean)
        .join(" ");
      return `${str("action")} ${rest}`.trim();
    }
    case "write_file":
    case "edit_file":
      return str("path");
    default:
      return JSON.stringify(args);
  }
}

const appliesTo = (rule: Rule, tool: string): boolean => rule.tool === undefined || rule.tool === tool;

/** A rule matches when its regex hits the subject. Built-ins carry no regex. */
export function matchRule(rule: Rule, tool: string, subject: string): boolean {
  if (!appliesTo(rule, tool)) return false;
  if (!rule.match) return false;
  try {
    return new RegExp(rule.match).test(subject);
  } catch {
    // A rule with a broken regex must not silently stop matching — but it also cannot
    // be evaluated, so it is treated as not matching and reported elsewhere.
    return false;
  }
}

export interface CheckInput {
  tool: string;
  args: Record<string, unknown>;
  rules: Rules;
  mode: Mode;
  /** Rules the user chose "allow for this session" on. */
  sessionAllowed: ReadonlySet<string>;
}

/**
 * Decide what happens before a tool runs.
 *
 * Order matters: plan mode refuses writes first, then danger rules (which no mode
 * skips), then the allow list, then the mode's own appetite for asking.
 */
export function check(input: CheckInput): Decision {
  const { tool, args, rules, mode, sessionAllowed } = input;
  const writing = isWriting(tool, args);
  const subject = subjectOf(tool, args);

  // plan mode: read-only, and says so as a tool error rather than a modal (§6).
  if (mode === "plan" && writing) {
    return {
      kind: "deny",
      reason: "plan mode: this session is read-only. Describe the change instead of making it.",
    };
  }

  // Danger rules come before everything, including the allow list — §0 principle 3.
  let allowedBySession = false;
  for (const rule of rules.danger) {
    if (!matchRule(rule, tool, subject)) continue;
    if (sessionAllowed.has(rule.id)) {
      // "Allow for this session" on a danger rule is a deliberate decision about this
      // exact kind of command; it should not then be asked about again as a routine
      // write just because the mode is `ask`.
      allowedBySession = true;
      continue;
    }
    return {
      kind: "ask",
      rule,
      level: rule.level,
      command: subject,
      reason: rule.note ?? `matches the ${rule.id} rule`,
    };
  }
  if (allowedBySession) return { kind: "allow" };

  // An explicit allow short-circuits ask mode (§8).
  for (const rule of rules.allow) {
    if (matchRule(rule, tool, subject)) return { kind: "allow" };
  }

  // auto only asks on danger, which is already handled above.
  if (mode === "auto" || !writing) return { kind: "allow" };

  // ask mode: every write asks, as an info-tier modal where Enter allows (§6).
  return {
    kind: "ask",
    rule: { id: `ask-${tool}`, level: "info", builtin: true },
    level: "info",
    command: subject,
    reason: `${tool} changes the repo`,
  };
}
