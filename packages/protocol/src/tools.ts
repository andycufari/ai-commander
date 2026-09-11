import { z } from "zod";

/** §5 tools. Each entry carries the zod schema for its args; the brain client converts
 *  them to JSON Schema for the API `tools` field (schemas never go in the prompt). */

export const CORE_TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
  "shell",
  "job",
  "git",
  "show_files",
  "ask_user",
  "list_skills",
  "read_skill",
] as const;
export const CoreToolName = z.enum(CORE_TOOL_NAMES);
export type CoreToolName = z.infer<typeof CoreToolName>;

export const SPECIAL_TOOL_NAMES = ["sql", "comfyui", "cad_render", "circuit_export"] as const;
export const SpecialToolName = z.enum(SPECIAL_TOOL_NAMES);
export type SpecialToolName = z.infer<typeof SpecialToolName>;

/** A viewer may contribute tools (§10), so a tool name is not a closed set at runtime. */
export const ToolName = z.string().min(1);
export type ToolName = string;

export const LineRange = z.object({
  start: z.number().int().positive(),
  end: z.number().int().positive(),
});
export type LineRange = z.infer<typeof LineRange>;

export const GitAction = z.enum([
  "status", "log", "diff", "add", "commit", "checkout", "branch", "stash", "push",
]);
export type GitAction = z.infer<typeof GitAction>;

export const JobAction = z.enum(["status", "output", "kill"]);
export type JobAction = z.infer<typeof JobAction>;

export const PanelMode = z.enum(["view", "edit"]);
export type PanelMode = z.infer<typeof PanelMode>;

export const ToolArgs = {
  read_file: z.object({ path: z.string(), range: LineRange.optional() }),
  write_file: z.object({ path: z.string(), content: z.string() }),
  edit_file: z.object({
    path: z.string(),
    old: z.string(),
    new: z.string(),
    all: z.boolean().optional(),
  }),
  glob: z.object({ pattern: z.string() }),
  grep: z.object({ pattern: z.string(), path: z.string().optional(), glob: z.string().optional() }),
  shell: z.object({
    cmd: z.string(),
    cwd: z.string().optional(),
    timeout: z.number().int().positive().optional(),
  }),
  job: z.object({ action: JobAction, jobId: z.string() }),
  git: z.object({ action: GitAction }).passthrough(),
  show_files: z.object({
    paths: z.array(z.string()).min(1).max(5),
  }),
  ask_user: z.object({ question: z.string(), options: z.array(z.string()).min(1) }),
  list_skills: z.object({}),
  read_skill: z.object({ name: z.string() }),
  sql: z.object({ query: z.string() }),
  comfyui: z.object({ workflow: z.string(), inputs: z.record(z.unknown()).default({}) }),
  cad_render: z.object({ path: z.string(), format: z.enum(["stl", "png"]) }),
  circuit_export: z.object({ path: z.string() }),
} as const;

export type ToolArgsMap = { [K in keyof typeof ToolArgs]: z.infer<(typeof ToolArgs)[K]> };

/** Descriptions live with the schemas so the brain client has one source for the API payload. */
export const TOOL_DESCRIPTIONS: Record<keyof typeof ToolArgs, string> = {
  read_file: "Read a file from the repo. Returns content with line numbers. Large files are truncated and the full text written to a path you can read in ranges.",
  write_file: "Write a file, creating parent directories. Refuses paths outside the repo root.",
  edit_file: "Replace an exact string in a file. Returns a unified diff. Set `all` to replace every occurrence.",
  glob: "List repo files matching a glob pattern.",
  grep: "Search file contents by regex, optionally scoped to a path or glob.",
  shell: "Run a shell command in the repo. On timeout the process keeps running as a background job and you get a jobId.",
  job: "Inspect or kill a background shell job.",
  git: "Run a git action: status, log, diff, add, commit, checkout, branch, stash, push.",
  show_files:
    "Put files in front of the user. Call this whenever you want them to LOOK at " +
    "something: a file you just changed, an image or diagram you are discussing, data " +
    "you want them to check. The app picks the right way to display each one — rendered " +
    "markdown, an image, a 3D model, a schematic, a table — so just give the paths and " +
    "do not worry about how. Files appear beside the conversation without interrupting " +
    "what the user is typing. Up to 5 at once.",
  ask_user: "Ask the user a question with a fixed set of choices. The loop pauses until they answer.",
  list_skills: "List available skills with their descriptions.",
  read_skill: "Read the full text of a skill by name.",
  sql: "Run SQL against the project data database. DDL allowed. Returns up to 200 rows.",
  comfyui: "Run a ComfyUI workflow. Outputs are saved into the repo and opened in a panel.",
  cad_render: "Render a CAD source file to STL or PNG.",
  circuit_export: "Export a KiCad schematic to SVG.",
};

/** What a tool call produces: `summary` is for the UI, `content` for the model (§5). */
export const ToolResult = z.object({
  ok: z.boolean(),
  summary: z.string(),
  content: z.string(),
  /** Set when output exceeded `loop.toolOutputCap` and the full text went to `out/<callId>.txt`. */
  outputPath: z.string().optional(),
  truncated: z.boolean().default(false),
});
export type ToolResult = z.infer<typeof ToolResult>;

export const ToolCall = z.object({
  callId: z.string(),
  name: ToolName,
  args: z.record(z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCall>;
