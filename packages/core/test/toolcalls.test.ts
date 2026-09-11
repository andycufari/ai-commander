import { describe, expect, it } from "vitest";
import {
  extractFirstObject, parseTextToolCalls, repairJson, stripToolMarkup,
} from "../src/toolcalls.js";

/** Guard 7 (§6): malformed tool calls — JSON repair, fenced JSON, XML-ish tags. */

describe("repairJson", () => {
  it("parses clean JSON unchanged", () => {
    expect(repairJson('{"path":"a.c"}')).toEqual({ path: "a.c" });
  });

  it("repairs trailing commas", () => {
    expect(repairJson('{"path":"a.c",}')).toEqual({ path: "a.c" });
    expect(repairJson('{"a":[1,2,],}')).toEqual({ a: [1, 2] });
  });

  it("repairs unquoted keys", () => {
    expect(repairJson('{path: "a.c"}')).toEqual({ path: "a.c" });
  });

  it("repairs single quotes", () => {
    expect(repairJson("{'path': 'a.c'}")).toEqual({ path: "a.c" });
  });

  it("repairs smart quotes", () => {
    expect(repairJson('{“path”: “a.c”}')).toEqual({ path: "a.c" });
  });

  it("repairs python literals", () => {
    expect(repairJson('{"all": True, "x": None, "y": False}')).toEqual({ all: true, x: null, y: false });
  });

  it("repairs several problems at once", () => {
    expect(repairJson("{path: 'a.c', all: True,}")).toEqual({ path: "a.c", all: true });
  });

  it("gives up on genuinely broken input", () => {
    expect(repairJson("{{{not json at all")).toBeUndefined();
  });
});

describe("extractFirstObject", () => {
  it("pulls an object out of surrounding prose", () => {
    expect(extractFirstObject('sure, calling {"path":"a.c"} now')).toBe('{"path":"a.c"}');
  });

  it("ignores braces inside strings", () => {
    expect(extractFirstObject('{"text":"a } b"}')).toBe('{"text":"a } b"}');
  });

  it("handles nesting", () => {
    expect(extractFirstObject('{"a":{"b":1}} tail')).toBe('{"a":{"b":1}}');
  });

  it("returns undefined when there is no object", () => {
    expect(extractFirstObject("no braces here")).toBeUndefined();
  });
});

describe("parseTextToolCalls", () => {
  it("parses a <tool_call> block", () => {
    const calls = parseTextToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"a.c"}}</tool_call>');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "read_file", args: { path: "a.c" } });
  });

  it("parses an array of calls", () => {
    const calls = parseTextToolCalls(
      '<tool_calls>[{"name":"glob","arguments":{"pattern":"*.c"}},{"name":"grep","arguments":{"pattern":"x"}}]</tool_calls>',
    );
    expect(calls.map((c) => c.name)).toEqual(["glob", "grep"]);
  });

  it("parses a <tool name=...> tag", () => {
    const calls = parseTextToolCalls('<tool name="read_file">{"path":"a.c"}</tool>');
    expect(calls[0]).toMatchObject({ name: "read_file", args: { path: "a.c" } });
  });

  it("parses a fenced json block that names a tool", () => {
    const calls = parseTextToolCalls('```json\n{"name":"glob","arguments":{"pattern":"**/*.md"}}\n```');
    expect(calls[0]).toMatchObject({ name: "glob", args: { pattern: "**/*.md" } });
  });

  it("leaves plain fenced JSON alone", () => {
    // Data the model is showing the user must not become a tool call.
    expect(parseTextToolCalls('```json\n{"total": 42}\n```')).toEqual([]);
  });

  it("repairs malformed args inside a tag", () => {
    const calls = parseTextToolCalls("<tool_call>{name: 'read_file', arguments: {path: 'a.c',}}</tool_call>");
    expect(calls[0]).toMatchObject({ name: "read_file", args: { path: "a.c" } });
  });

  it("accepts args, arguments or parameters", () => {
    for (const key of ["args", "arguments", "parameters"]) {
      const calls = parseTextToolCalls(`<tool_call>{"name":"glob","${key}":{"pattern":"*"}}</tool_call>`);
      expect(calls[0]?.args).toEqual({ pattern: "*" });
    }
  });

  it("deduplicates a call that matches two patterns", () => {
    const text = '```tool_call\n{"name":"glob","arguments":{"pattern":"*"}}\n```';
    expect(parseTextToolCalls(text)).toHaveLength(1);
  });

  it("returns nothing for ordinary prose", () => {
    expect(parseTextToolCalls("I'll read the file next.")).toEqual([]);
  });

  it("gives every call a distinct id", () => {
    const calls = parseTextToolCalls(
      '<tool_call>{"name":"glob","arguments":{"pattern":"a"}}</tool_call>' +
      '<tool_call>{"name":"glob","arguments":{"pattern":"b"}}</tool_call>',
    );
    expect(new Set(calls.map((c) => c.callId)).size).toBe(2);
  });
});

describe("stripToolMarkup", () => {
  it("removes tags from the transcript", () => {
    const text = 'Reading it now.\n<tool_call>{"name":"read_file","arguments":{"path":"a.c"}}</tool_call>';
    expect(stripToolMarkup(text)).toBe("Reading it now.");
  });

  it("keeps fenced blocks that are not calls", () => {
    const text = 'Here is the data:\n```json\n{"total": 42}\n```';
    expect(stripToolMarkup(text)).toContain("total");
  });
});
