import type { BrainConfig, ToolCall } from "@aicommander/protocol";
import { parseArgs, parseTextToolCalls, stripToolMarkup } from "./toolcalls.js";

/** §1: OpenAI-compatible /v1/chat/completions, streaming, tools. */

export interface BrainMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface BrainTurn {
  text: string;
  toolCalls: ToolCall[];
  /** Why the model stopped, as reported by the endpoint. */
  finish: string | null;
  usage?: { prompt: number; completion: number };
}

export interface StreamHandlers {
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

export class BrainError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "BrainError";
  }
}

const endpointUrl = (base: string, path: string): string =>
  `${base.replace(/\/+$/, "")}${path}`;

export class BrainClient {
  constructor(private readonly config: BrainConfig) {}

  /**
   * One streaming completion. Text deltas arrive through `onText`; tool calls are
   * assembled from the stream and returned at the end.
   *
   * `toolFormat`:
   *   native — always send the tools array, trust tool_calls
   *   text   — never send tools, parse tags out of the text
   *   auto   — send tools; if the model returns none but its text looks like a call,
   *            fall back to tag parsing (§12: "plus text-tag fallback")
   */
  async complete(
    messages: BrainMessage[],
    tools: ToolSpec[],
    handlers: StreamHandlers = {},
  ): Promise<BrainTurn> {
    const format = this.config.toolFormat;
    const sendTools = format !== "text" && tools.length > 0;

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: true,
      temperature: this.config.temperature,
    };
    if (sendTools) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;

    let res: Response;
    try {
      res = await fetch(endpointUrl(this.config.endpoint, "/chat/completions"), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: handlers.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      throw new BrainError(
        `cannot reach the brain at ${this.config.endpoint}: ${(err as Error).message}`,
      );
    }

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new BrainError(
        `brain returned ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 400)}` : ""}`,
        res.status,
      );
    }

    const turn = await this.readStream(res.body, handlers);

    // auto: the model ignored the tools array but described a call in prose.
    if (turn.toolCalls.length === 0 && format !== "native") {
      const parsed = parseTextToolCalls(turn.text);
      if (parsed.length > 0) {
        return { ...turn, text: stripToolMarkup(turn.text), toolCalls: parsed };
      }
    }
    return turn;
  }

  /** Assemble SSE deltas into one turn. Tool calls stream in fragments keyed by index. */
  private async readStream(
    body: ReadableStream<Uint8Array>,
    handlers: StreamHandlers,
  ): Promise<BrainTurn> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    // Text-tag mode streams tool markup inline with prose. Hold deltas back once a tag
    // opens so the user never sees raw <tool_call> JSON scroll past; the final text is
    // stripped anyway, and this keeps the live view matching it.
    const mayHoldMarkup = this.config.toolFormat !== "native";
    let emitted = 0;
    let finish: string | null = null;
    let usage: BrainTurn["usage"];
    const partial = new Map<number, { id?: string; name: string; args: string }>();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        let cut = buffer.indexOf("\n\n");
        while (cut !== -1) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          cut = buffer.indexOf("\n\n");

          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "" || payload === "[DONE]") continue;

            let chunk: Record<string, unknown>;
            try {
              chunk = JSON.parse(payload);
            } catch {
              // A partial frame the endpoint flushed early — skip it; the next read
              // brings the rest. Never fatal.
              continue;
            }

            const choice = (chunk.choices as Record<string, unknown>[] | undefined)?.[0];
            if (chunk.usage) {
              const u = chunk.usage as Record<string, number>;
              usage = { prompt: u.prompt_tokens ?? 0, completion: u.completion_tokens ?? 0 };
            }
            if (!choice) continue;
            if (choice.finish_reason) finish = String(choice.finish_reason);

            const delta = (choice.delta ?? {}) as Record<string, unknown>;
            if (typeof delta.content === "string" && delta.content) {
              text += delta.content;
              if (!mayHoldMarkup) {
                handlers.onText?.(delta.content);
              } else {
                // Emit only up to the start of an opening tag; everything after it is
                // markup until the stream ends and we know what it was.
                const safe = safeEmitLength(text);
                if (safe > emitted) {
                  handlers.onText?.(text.slice(emitted, safe));
                  emitted = safe;
                }
              }
            }

            for (const tc of (delta.tool_calls ?? []) as Record<string, unknown>[]) {
              const idx = typeof tc.index === "number" ? tc.index : 0;
              const slot = partial.get(idx) ?? { name: "", args: "" };
              if (typeof tc.id === "string" && tc.id) slot.id = tc.id;
              const fn = (tc.function ?? {}) as Record<string, unknown>;
              if (typeof fn.name === "string" && fn.name) slot.name += fn.name;
              if (typeof fn.arguments === "string") slot.args += fn.arguments;
              partial.set(idx, slot);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls: ToolCall[] = [];
    for (const [idx, slot] of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
      if (!slot.name) continue;
      // Guard 7: a malformed argument blob must not lose the call — it becomes a call
      // with a marker the loop turns into a tool error the model can act on.
      try {
        toolCalls.push({ callId: slot.id ?? `c${idx}`, name: slot.name, args: parseArgs(slot.args) });
      } catch (err) {
        toolCalls.push({
          callId: slot.id ?? `c${idx}`,
          name: slot.name,
          args: { __parseError: (err as Error).message, __raw: slot.args.slice(0, 2000) },
        });
      }
    }

    return { text, toolCalls, finish, usage };
  }
}

/**
 * How much of `text` is safe to show: everything before the first opening tool tag, or
 * before a trailing fragment that might still become one ("<too", "``"). Without the
 * second case a tag split across two deltas would leak its first half.
 */
export function safeEmitLength(text: string): number {
  const open = /<tool_calls?>|<tool\s+name=|```(?:json|tool_call|tool)?\s*\n/i.exec(text);
  if (open) return open.index;

  // A partial opener at the very end — wait for the next delta before deciding.
  const tail = /(?:<(?:t(?:o(?:o(?:l(?:_(?:c(?:a(?:l(?:ls?)?)?)?)?)?)?)?)?)?|`{1,3}(?:j(?:s(?:o(?:n)?)?)?|t(?:o(?:o(?:l)?)?)?)?)$/i.exec(text);
  return tail && tail.index < text.length ? tail.index : text.length;
}
