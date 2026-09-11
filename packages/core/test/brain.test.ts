import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainConfig } from "@aicommander/protocol";
import { BrainClient, BrainError } from "../src/brain.js";

/** A fake OpenAI-compatible endpoint, so the client is tested without a live model. */

let server: Server;
let base: string;
let script: string[] = [];
let status = 200;
let lastBody: Record<string, unknown> = {};

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const textChunk = (s: string) => sse({ choices: [{ delta: { content: s } }] });

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      lastBody = JSON.parse(raw || "{}");
      if (status !== 200) {
        res.writeHead(status, { "content-type": "text/plain" });
        res.end("upstream said no");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of script) res.write(frame);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const client = (over: Partial<BrainConfig> = {}) =>
  new BrainClient(BrainConfig.parse({ endpoint: base, model: "test", ...over }));

describe("streaming", () => {
  it("assembles text deltas and reports them live", async () => {
    script = [textChunk("Hel"), textChunk("lo"), sse({ choices: [{ finish_reason: "stop" }] })];
    const seen: string[] = [];
    const turn = await client().complete([{ role: "user", content: "hi" }], [], {
      onText: (d) => seen.push(d),
    });
    expect(turn.text).toBe("Hello");
    expect(seen).toEqual(["Hel", "lo"]);
    expect(turn.finish).toBe("stop");
  });

  it("survives a frame that is not valid json", async () => {
    script = ["data: {bro\n\n", textChunk("ok")];
    expect((await client().complete([], [])).text).toBe("ok");
  });

  it("reads usage when the endpoint sends it", async () => {
    script = [textChunk("x"), sse({ usage: { prompt_tokens: 10, completion_tokens: 3 }, choices: [{}] })];
    expect((await client().complete([], [])).usage).toEqual({ prompt: 10, completion: 3 });
  });
});

describe("native tool calls", () => {
  it("assembles a call streamed in fragments", async () => {
    script = [
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_" } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: '{"pa' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.c"}' } }] } }] }),
      sse({ choices: [{ finish_reason: "tool_calls" }] }),
    ];
    const turn = await client().complete([], []);
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]).toMatchObject({ callId: "c1", name: "read_file", args: { path: "a.c" } });
  });

  it("keeps several parallel calls in index order", async () => {
    script = [
      sse({ choices: [{ delta: { tool_calls: [
        { index: 1, id: "b", function: { name: "grep", arguments: "{}" } },
        { index: 0, id: "a", function: { name: "glob", arguments: "{}" } },
      ] } }] }),
    ];
    expect((await client().complete([], [])).toolCalls.map((c) => c.name)).toEqual(["glob", "grep"]);
  });

  it("repairs malformed streamed arguments", async () => {
    script = [sse({ choices: [{ delta: { tool_calls: [
      { index: 0, id: "c1", function: { name: "read_file", arguments: "{path: 'a.c',}" } },
    ] } }] })];
    expect((await client().complete([], [])).toolCalls[0]!.args).toEqual({ path: "a.c" });
  });

  it("marks an unsalvageable call instead of dropping it (guard 7)", async () => {
    script = [sse({ choices: [{ delta: { tool_calls: [
      { index: 0, id: "c1", function: { name: "read_file", arguments: "{{{garbage" } },
    ] } }] })];
    const call = (await client().complete([], [])).toolCalls[0]!;
    expect(call.name).toBe("read_file");
    expect(call.args.__parseError).toBeTruthy();
  });
});

describe("toolFormat", () => {
  const tools = [{ name: "glob", description: "d", parameters: { type: "object" } }];

  it("auto sends the tools array", async () => {
    script = [textChunk("hi")];
    await client({ toolFormat: "auto" }).complete([], tools);
    expect(lastBody.tools).toBeTruthy();
  });

  it("auto falls back to text tags when the model returns no native call", async () => {
    script = [textChunk('Looking.\n<tool_call>{"name":"glob","arguments":{"pattern":"*.c"}}</tool_call>')];
    const turn = await client({ toolFormat: "auto" }).complete([], tools);
    expect(turn.toolCalls[0]).toMatchObject({ name: "glob", args: { pattern: "*.c" } });
    // the markup is stripped from what the user sees
    expect(turn.text).toBe("Looking.");
  });

  it("text never sends tools and parses tags", async () => {
    script = [textChunk('<tool_call>{"name":"glob","arguments":{"pattern":"*"}}</tool_call>')];
    const turn = await client({ toolFormat: "text" }).complete([], tools);
    expect(lastBody.tools).toBeUndefined();
    expect(turn.toolCalls).toHaveLength(1);
  });

  it("native does not parse text tags", async () => {
    script = [textChunk('<tool_call>{"name":"glob","arguments":{}}</tool_call>')];
    const turn = await client({ toolFormat: "native" }).complete([], tools);
    expect(turn.toolCalls).toEqual([]);
  });
});

describe("failures", () => {
  it("reports an upstream error with its status", async () => {
    status = 500;
    await expect(client().complete([], [])).rejects.toBeInstanceOf(BrainError);
    status = 200;
  });

  it("explains an unreachable endpoint", async () => {
    const dead = new BrainClient(BrainConfig.parse({ endpoint: "http://127.0.0.1:1/v1", model: "m" }));
    await expect(dead.complete([], [])).rejects.toThrow(/cannot reach the brain/);
  });

  it("aborts on signal", async () => {
    script = [textChunk("a")];
    const ac = new AbortController();
    ac.abort();
    await expect(client().complete([], [], { signal: ac.signal })).rejects.toThrow();
  });
});

describe("streaming does not leak tool markup", () => {
  it("holds back a <tool_call> block from the live stream", async () => {
    script = [
      textChunk("Let me look. "),
      textChunk('<tool_call>{"name":"glob",'),
      textChunk('"arguments":{"pattern":"*.md"}}</tool_call>'),
    ];
    const seen: string[] = [];
    const turn = await client({ toolFormat: "auto" }).complete([], [], { onText: (d) => seen.push(d) });
    expect(seen.join("")).toBe("Let me look. ");
    expect(seen.join("")).not.toContain("tool_call");
    expect(turn.text).toBe("Let me look.");
    expect(turn.toolCalls[0]).toMatchObject({ name: "glob" });
  });

  it("does not leak a tag split across deltas", async () => {
    script = [textChunk("hi <to"), textChunk('ol_call>{"name":"glob","arguments":{}}</tool_call>')];
    const seen: string[] = [];
    await client({ toolFormat: "auto" }).complete([], [], { onText: (d) => seen.push(d) });
    expect(seen.join("")).toBe("hi ");
  });

  it("streams ordinary prose unchanged in native mode", async () => {
    script = [textChunk("a"), textChunk("b")];
    const seen: string[] = [];
    await client({ toolFormat: "native" }).complete([], [], { onText: (d) => seen.push(d) });
    expect(seen.join("")).toBe("ab");
  });

  it("streams prose that merely mentions backticks", async () => {
    script = [textChunk("use `make all` to build")];
    const seen: string[] = [];
    await client({ toolFormat: "auto" }).complete([], [], { onText: (d) => seen.push(d) });
    expect(seen.join("")).toBe("use `make all` to build");
  });
});
