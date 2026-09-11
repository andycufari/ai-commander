import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, type Rules } from "@aicommander/protocol";
import { check, isWriting, matchRule, subjectOf } from "../src/permissions.js";

/** §8 permissions. §0 principle 3: danger always blocks. */

const ask = (over: Partial<Parameters<typeof check>[0]> = {}) =>
  check({
    tool: "shell", args: { cmd: "ls" }, rules: DEFAULT_RULES,
    mode: "ask", sessionAllowed: new Set(), ...over,
  });

describe("isWriting", () => {
  it("knows which tools change things", () => {
    expect(isWriting("write_file", {})).toBe(true);
    expect(isWriting("edit_file", {})).toBe(true);
    expect(isWriting("shell", {})).toBe(true);
    expect(isWriting("read_file", {})).toBe(false);
    expect(isWriting("glob", {})).toBe(false);
    expect(isWriting("show_files", {})).toBe(false);
  });

  it("splits git by subcommand", () => {
    expect(isWriting("git", { action: "commit" })).toBe(true);
    expect(isWriting("git", { action: "push" })).toBe(true);
    expect(isWriting("git", { action: "status" })).toBe(false);
    expect(isWriting("git", { action: "diff" })).toBe(false);
  });
});

describe("subjectOf", () => {
  it("reads like what the modal will show", () => {
    expect(subjectOf("shell", { cmd: "rm -rf build" })).toBe("rm -rf build");
    expect(subjectOf("git", { action: "push", remote: "origin" })).toBe("push origin");
    expect(subjectOf("write_file", { path: "a.c", content: "x" })).toBe("a.c");
  });
});

describe("danger rules", () => {
  it("blocks rm -rf in ask mode", () => {
    const d = ask({ args: { cmd: "rm -rf build" } });
    expect(d.kind).toBe("ask");
    if (d.kind === "ask") {
      expect(d.rule.id).toBe("rm-rf");
      expect(d.level).toBe("danger");
    }
  });

  it("blocks rm -rf in auto mode too — no mode bypasses danger", () => {
    const d = ask({ args: { cmd: "rm -rf build" }, mode: "auto" });
    expect(d.kind).toBe("ask");
    if (d.kind === "ask") expect(d.rule.id).toBe("rm-rf");
  });

  it("blocks sudo, force push and reset --hard", () => {
    expect(ask({ args: { cmd: "sudo rm x" }, mode: "auto" }).kind).toBe("ask");
    expect(ask({ tool: "git", args: { action: "push", flags: "--force" }, mode: "auto" }).kind).toBe("ask");
    expect(ask({ tool: "git", args: { action: "reset", flags: "--hard" }, mode: "auto" }).kind).toBe("ask");
  });

  it("raises network access as a warning, not a danger", () => {
    const d = ask({ args: { cmd: "curl https://example.com" }, mode: "auto" });
    expect(d.kind).toBe("ask");
    if (d.kind === "ask") expect(d.level).toBe("warning");
  });

  it("carries the rule's note as the reason shown to the user", () => {
    const d = ask({ args: { cmd: "rm -rf x" } });
    if (d.kind === "ask") expect(d.reason).toBe("recursive delete");
  });

  it("a danger rule allowed for the session stops asking", () => {
    const d = ask({ args: { cmd: "rm -rf build" }, sessionAllowed: new Set(["rm-rf"]) });
    expect(d.kind).toBe("allow");
  });

  it("a danger rule does not match an innocent command", () => {
    expect(ask({ args: { cmd: "rm build/one.o" }, mode: "auto" }).kind).toBe("allow");
  });
});

describe("modes", () => {
  it("ask asks before every write", () => {
    const d = ask({ tool: "write_file", args: { path: "a.c", content: "x" } });
    expect(d.kind).toBe("ask");
    if (d.kind === "ask") expect(d.level).toBe("info");
  });

  it("ask does not ask about reads", () => {
    expect(ask({ tool: "read_file", args: { path: "a.c" } }).kind).toBe("allow");
    expect(ask({ tool: "grep", args: { pattern: "x" } }).kind).toBe("allow");
  });

  it("auto allows routine writes without asking", () => {
    expect(ask({ tool: "write_file", args: { path: "a.c" }, mode: "auto" }).kind).toBe("allow");
    expect(ask({ args: { cmd: "npm test" }, mode: "auto" }).kind).toBe("allow");
  });

  it("plan refuses every write, as a tool error not a modal", () => {
    const d = ask({ tool: "write_file", args: { path: "a.c" }, mode: "plan" });
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") expect(d.reason).toMatch(/plan mode/);
  });

  it("plan still allows reading", () => {
    expect(ask({ tool: "read_file", args: { path: "a.c" }, mode: "plan" }).kind).toBe("allow");
  });

  it("plan refuses a dangerous command as plan, not as a prompt", () => {
    // Read-only means read-only; there is nothing to ask about.
    const d = ask({ args: { cmd: "rm -rf /" }, mode: "plan" });
    expect(d.kind).toBe("deny");
  });
});

describe("allow rules", () => {
  const withAllow: Rules = {
    ...DEFAULT_RULES,
    allow: [{ id: "npm-test", match: "^npm (test|run lint)$", tool: "shell", level: "danger", builtin: false }],
  };

  it("short-circuits ask mode", () => {
    expect(ask({ args: { cmd: "npm test" }, rules: withAllow }).kind).toBe("allow");
  });

  it("does not override a danger rule", () => {
    // An allow entry must never be a way around §0 principle 3.
    const sneaky: Rules = {
      danger: DEFAULT_RULES.danger,
      allow: [{ id: "everything", match: ".*", tool: "shell", level: "danger", builtin: false }],
    };
    expect(ask({ args: { cmd: "rm -rf /" }, rules: sneaky, mode: "auto" }).kind).toBe("ask");
  });

  it("only matches what it names", () => {
    expect(ask({ args: { cmd: "npm run deploy" }, rules: withAllow }).kind).toBe("ask");
  });
});

describe("matchRule", () => {
  it("respects the rule's tool", () => {
    const rule = { id: "x", match: "push", tool: "git" as const, level: "danger" as const, builtin: false };
    expect(matchRule(rule, "git", "push origin")).toBe(true);
    expect(matchRule(rule, "shell", "push origin")).toBe(false);
  });

  it("a rule with no regex never matches on its own", () => {
    const builtin = { id: "outside-root", level: "danger" as const, builtin: true };
    expect(matchRule(builtin, "shell", "anything")).toBe(false);
  });

  it("survives a broken regex rather than throwing", () => {
    const broken = { id: "bad", match: "([", tool: "shell" as const, level: "danger" as const, builtin: false };
    expect(() => matchRule(broken, "shell", "x")).not.toThrow();
    expect(matchRule(broken, "shell", "x")).toBe(false);
  });
});
