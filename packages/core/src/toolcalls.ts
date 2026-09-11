import { randomUUID } from "node:crypto";
import type { ToolCall } from "@aicommander/protocol";

/**
 * Guard 7 (§6): malformed tool calls.
 *
 * Models without native tool calling emit JSON in prose, and even models with it emit
 * broken JSON under load. Try, in order: strict JSON, then JSON repair (trailing commas,
 * single quotes, unquoted keys, smart quotes), then fenced blocks, then XML-ish tags.
 * On total failure the caller returns a tool error carrying the parse message so the
 * model can retry — and that error counts toward guard 2.
 */

export class ToolParseError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = "ToolParseError";
  }
}

/** Repair the JSON dialects models actually emit. Returns undefined if it still won't parse. */
export function repairJson(input: string): unknown | undefined {
  const attempts = [
    (s: string) => s,
    // Trailing commas before a closing brace or bracket.
    (s: string) => s.replace(/,(\s*[}\]])/g, "$1"),
    // Smart quotes from models that "prettify" their output.
    (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"),
    // Unquoted keys: {path: "a.c"} → {"path": "a.c"}
    (s: string) => s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3'),
    // Single-quoted strings → double, leaving apostrophes inside double-quoted text alone.
    (s: string) => s.replace(/'((?:[^'\\]|\\.)*)'/g, (_m, body: string) => JSON.stringify(body.replace(/\\'/g, "'"))),
    // Python-isms.
    (s: string) => s.replace(/\bNone\b/g, "null").replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false"),
  ];

  // Apply repairs cumulatively — a payload often needs several at once.
  let current = input.trim();
  for (const fix of attempts) {
    current = fix(current);
    try {
      return JSON.parse(current);
    } catch {
      // keep layering repairs
    }
  }
  return undefined;
}

/** Pull the first balanced {...} out of a string, ignoring braces inside strings. */
export function extractFirstObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let quote = "";
  for (let i = start; i < text.length; i += 1) {
    const c = text[i]!;
    const prev = text[i - 1];
    if (inString) {
      if (c === quote && prev !== "\\") inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Arguments as they arrive from a native tool call: a JSON string, or already an object. */
export function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined || raw === "") return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") throw new ToolParseError(`arguments must be an object or JSON string`, String(raw));

  const direct = repairJson(raw);
  if (direct && typeof direct === "object") return direct as Record<string, unknown>;

  const inner = extractFirstObject(raw);
  if (inner) {
    const repaired = repairJson(inner);
    if (repaired && typeof repaired === "object") return repaired as Record<string, unknown>;
  }
  throw new ToolParseError(`could not parse tool arguments as JSON`, raw);
}

/**
 * Text-tag fallback for models with no native tool calling (`toolFormat: "text"`, and the
 * "auto" path when a response carries no native calls). Recognised shapes:
 *
 *   <tool_call>{"name":"read_file","arguments":{...}}</tool_call>
 *   <tool name="read_file">{...}</tool>
 *   ```json {"name":"read_file","arguments":{...}} ```
 *   ```tool_call ... ```
 */
export function parseTextToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const push = (name: string, argsRaw: unknown): void => {
    if (!name) return;
    try {
      calls.push({ callId: randomUUID().slice(0, 8), name, args: parseArgs(argsRaw) });
    } catch {
      // A tag we recognised but whose body is unsalvageable: skip it here and let the
      // caller's "no calls parsed" path report it, rather than inventing empty args.
    }
  };

  // <tool_call>…</tool_call> / <tool_calls>…</tool_calls>
  for (const m of text.matchAll(/<tool_calls?>([\s\S]*?)<\/tool_calls?>/gi)) {
    const body = m[1]!.trim();
    const obj = repairJson(body) ?? repairJson(extractFirstObject(body) ?? "");
    if (Array.isArray(obj)) {
      for (const c of obj) {
        const rec = c as Record<string, unknown>;
        push(String(rec.name ?? rec.tool ?? ""), rec.arguments ?? rec.args ?? rec.parameters ?? {});
      }
    } else if (obj && typeof obj === "object") {
      const rec = obj as Record<string, unknown>;
      push(String(rec.name ?? rec.tool ?? ""), rec.arguments ?? rec.args ?? rec.parameters ?? {});
    }
  }

  // <tool name="read_file">{...}</tool>
  for (const m of text.matchAll(/<tool\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool>/gi)) {
    push(m[1]!, m[2]!.trim());
  }

  // Fenced ```json / ```tool_call blocks that look like a call.
  for (const m of text.matchAll(/```(?:json|tool_call|tool)?\s*\n([\s\S]*?)```/gi)) {
    const obj = repairJson(m[1]!.trim());
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    const rec = obj as Record<string, unknown>;
    const name = rec.name ?? rec.tool;
    // Only treat a fenced block as a call when it actually names a tool — plain JSON
    // the model is showing the user must stay prose.
    if (typeof name === "string" && name) {
      push(name, rec.arguments ?? rec.args ?? rec.parameters ?? {});
    }
  }

  return dedupe(calls);
}

/** The same call can match two patterns (a fenced <tool_call>); keep the first. */
function dedupe(calls: ToolCall[]): ToolCall[] {
  const seen = new Set<string>();
  return calls.filter((c) => {
    const key = `${c.name}:${JSON.stringify(c.args)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Strip recognised tool-call markup so it never reaches the chat transcript. */
export function stripToolMarkup(text: string): string {
  return text
    .replace(/<tool_calls?>[\s\S]*?<\/tool_calls?>/gi, "")
    .replace(/<tool\s+name=["'][^"']+["']\s*>[\s\S]*?<\/tool>/gi, "")
    .replace(/```(?:json|tool_call|tool)?\s*\n[\s\S]*?```/gi, (block) => {
      const obj = repairJson(block.replace(/```(?:json|tool_call|tool)?\s*\n/, "").replace(/```$/, "").trim());
      const rec = obj as Record<string, unknown> | undefined;
      return rec && typeof rec === "object" && (rec.name ?? rec.tool) ? "" : block;
    })
    .trim();
}
