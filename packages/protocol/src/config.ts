import { z } from "zod";

/** §9 config schema. Same shape for global (~/.aicommander) and project (.aicommander); project wins. */

export const ToolFormat = z.enum(["auto", "native", "text"]);
export type ToolFormat = z.infer<typeof ToolFormat>;

export const Mode = z.enum(["ask", "auto", "plan"]);
export type Mode = z.infer<typeof Mode>;

export const BrainConfig = z.object({
  endpoint: z.string().url(),
  model: z.string().min(1),
  apiKey: z.string().default(""),
  temperature: z.number().min(0).max(2).default(0.6),
  ctx: z.number().int().positive().default(128_000),
  toolFormat: ToolFormat.default("auto"),
});
export type BrainConfig = z.infer<typeof BrainConfig>;

export const LoopConfig = z.object({
  maxToolCallsPerTurn: z.number().int().positive().default(50),
  maxTurnsPerPrompt: z.number().int().positive().default(20),
  shellTimeoutSec: z.number().int().positive().default(120),
  toolOutputCap: z.number().int().positive().default(8000),
  repeatGuard: z.number().int().positive().default(3),
  errorGuard: z.number().int().positive().default(4),
});
export type LoopConfig = z.infer<typeof LoopConfig>;

export const ContextConfig = z.object({
  autoCompactAt: z.number().min(0).max(1).default(0.75),
  keepLastGroups: z.number().int().nonnegative().default(6),
});
export type ContextConfig = z.infer<typeof ContextConfig>;

export const ComfyUIConfig = z.object({
  endpoint: z.string().url(),
});
export type ComfyUIConfig = z.infer<typeof ComfyUIConfig>;

export const Config = z.object({
  brain: BrainConfig,
  mode: Mode.default("ask"),
  loop: LoopConfig.default({}),
  context: ContextConfig.default({}),
  boot: z.array(z.string()).default(["AGENTS.md", "CLAUDE.md", "BOOT.md", "SOUL.md", "rules/"]),
  tools: z.object({ special: z.array(z.string()).default([]) }).default({}),
  notify: z.boolean().default(true),
  comfyui: ComfyUIConfig.optional(),
});
export type Config = z.infer<typeof Config>;

/**
 * A config file on disk may be partial — every layer is merged before validation,
 * so no single file has to be complete. `Config` validates the merged result.
 */
export const PartialConfig = Config.deepPartial();
export type PartialConfig = z.infer<typeof PartialConfig>;

/** Defaults for a repo with no config anywhere. `brain` has no sensible default; it must be set. */
export const DEFAULT_CONFIG: Omit<Config, "brain"> = {
  mode: "ask",
  loop: LoopConfig.parse({}),
  context: ContextConfig.parse({}),
  boot: ["AGENTS.md", "CLAUDE.md", "BOOT.md", "SOUL.md", "rules/"],
  tools: { special: [] },
  notify: true,
};

/** Scope an options change applies to (§10 options modal). */
export const OptionsScope = z.enum(["session", "project", "global"]);
export type OptionsScope = z.infer<typeof OptionsScope>;
