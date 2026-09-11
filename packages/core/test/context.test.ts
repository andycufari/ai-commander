import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Config as ConfigSchema, type Attachment, type LogEntry } from "@aicommander/protocol";
import { ensureProjectDir } from "../src/config.js";
import { assembleContext, hashContent } from "../src/context.js";
import { SessionStore } from "../src/sessions.js";

/** §7 context assembly: built fresh every turn, each layer a separate block. */

const roots: string[] = [];
const makeRepo = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "aic-ctx-"));
  roots.push(root);
  await ensureProjectDir(root);
  return root;
};
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const config = ConfigSchema.parse({ brain: { endpoint: "http://x/v1", model: "m" } });

const assemble = async (root: string, sessionId: string, over: Record<string, unknown> = {}) => {
  const sessions = new SessionStore(root);
  return assembleContext({ root, config, sessions, sessionId, ...over } as never);
};

describe("layer order", () => {
  it("sends exactly one system message, at the start", async () => {
    // A local chat template raised "System message must be at the beginning" on the
    // second one; a context layout that only works on some endpoints is not one.
    const root = await makeRepo();
    await writeFile(join(root, "CLAUDE.md"), "rules\n");
    const sessions = new SessionStore(root);
    const { id } = await sessions.create();
    await sessions.append(id, { t: "user", id: "g1", ts: 1, text: "hi", attachments: [] });
    const { messages } = await assemble(root, id);
    expect(messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(messages[0]!.role).toBe("system");
  });

  it("puts the harness manual first, then project boot, then skills", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "CLAUDE.md"), "project rules here\n");
    await mkdir(join(root, "skills", "s1"), { recursive: true });
    await writeFile(join(root, "skills", "s1", "SKILL.md"), "---\ndescription: a skill\n---\n");
    const sessions = new SessionStore(root);
    const { id } = await sessions.create();

    const { messages, layers } = await assemble(root, id);
    expect(layers.map((l) => l.name)).toEqual([
      "harness manual", "project boot", "skills index", "git state", "session",
    ]);
    // §7 order: the manual explains the harness before the project explains itself.
    const system = messages.filter((m) => m.role === "system").map((m) => String(m.content));
    // One system message: strict chat templates reject a second one.
    expect(system).toHaveLength(1);
    expect(system[0]!.indexOf("AI Commander")).toBeLessThan(system[0]!.indexOf("project rules here"));
    expect(system[0]).toContain("s1 — a skill");
  });

  it("omits a layer that has nothing in it", async () => {
    const root = await makeRepo();
    const sessions = new SessionStore(root);
    const { id } = await sessions.create();
    const { layers } = await assemble(root, id);
    expect(layers.map((l) => l.name)).not.toContain("project boot");
    expect(layers.map((l) => l.name)).not.toContain("skills index");
  });
});

describe("attachments", () => {
  it("puts a file above the turn that mentioned it, as a file block", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "main.c"), "int main(){}\n");
    const sessions = new SessionStore(root);
    const { id } = await sessions.create();
    const attachment: Attachment = { kind: "file", path: "main.c", hash: "" };
    await sessions.append(id, { t: "user", id: "g1", ts: 1, text: "look", attachments: [attachment] });

    const { messages } = await assemble(root, id);
    const text = messages.map((m) => String(m.content)).join("\n");
    expect(text).toContain('<file path="main.c"');
    expect(text).toContain("int main(){}");
    // The block comes before the message that referenced it.
    expect(text.indexOf("<file")).toBeLessThan(text.lastIndexOf("look"));
  });

  it("replaces an unchanged re-attachment with a reference, not the content", async () => {
    // §7: attaching a skill or file twice should not pay for it twice.
    const root = await makeRepo();
    await writeFile(join(root, "big.txt"), "the whole content\n");
    const sessions = new SessionStore(root);
    const { id } = await sessions.create();
    const hash = hashContent("the whole content\n");
    const a: Attachment = { kind: "file", path: "big.txt", hash };
    await sessions.append(id, { t: "user", id: "g1", ts: 1, text: "first", attachments: [a] });
    await sessions.append(id, { t: "user", id: "g2", ts: 2, text: "second", attachments: [a] });

    const { messages } = await assemble(root, id);
    const text = messages.map((m) => String(m.content)).join("\n");
    expect(text.match(/the whole content/g)).toHaveLength(1);
    expect(text).toContain('<file path="big.txt" unchanged/>');
  });

  it("sends the content again when the file has changed since", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "moving.txt"), "version two\n");
    const sessions = new SessionStore(root);
    const { id } = await sessions.create();
    await sessions.append(id, {
      t: "user", id: "g1", ts: 1, text: "first",
      attachments: [{ kind: "file", path: "moving.txt", hash: hashContent("version one\n") }],
    });
    await sessions.append(id, {
      t: "user", id: "g2", ts: 2, text: "second",
      attachments: [{ kind: "file", path: "moving.txt", hash: hashContent("version two\n") }],
    });
    const { messages } = await assemble(root, id);
    expect(messages.map((m) => String(m.content)).join("\n")).toContain("version two");
  });

  it("inserts a skill as a skill block", async () => {
    const root = await makeRepo();
    await mkdir(join(root, "skills", "esp32"), { recursive: true });
    await writeFile(join(root, "skills", "esp32", "SKILL.md"),
      "---\ndescription: sleep\n---\n\nhold the pins low\n");
    const sessions = new SessionStore(root);
    const { id } = await sessions.create();
    await sessions.append(id, {
      t: "user", id: "g1", ts: 1, text: "help",
      attachments: [{ kind: "skill", name: "esp32" }],
    });
    const text = (await assemble(root, id)).messages.map((m) => String(m.content)).join("\n");
    expect(text).toContain('<skill name="esp32">');
    expect(text).toContain("hold the pins low");
  });

  it("says so rather than failing when an attached file is gone", async () => {
    const root = await makeRepo();
    const sessions = new SessionStore(root);
    const { id } = await sessions.create();
    await sessions.append(id, {
      t: "user", id: "g1", ts: 1, text: "look",
      attachments: [{ kind: "file", path: "ghost.txt", hash: "abc" }],
    });
    const text = (await assemble(root, id)).messages.map((m) => String(m.content)).join("\n");
    expect(text).toContain("ghost.txt");
    expect(text).toContain("no longer");
  });
});

describe("compaction", () => {
  it("swaps the summary in for the groups it replaced", async () => {
    const root = await makeRepo();
    await writeFile(join(root, ".aicommander", "out", "compact-1.md"), "the summary\n");
    const sessions = new SessionStore(root);
    const { id } = await sessions.create();
    const entries: LogEntry[] = [
      { t: "user", id: "g1", ts: 1, text: "old one", attachments: [] },
      { t: "user", id: "g2", ts: 2, text: "old two", attachments: [] },
      { t: "compact", ts: 3, upTo: "g2", summaryPath: ".aicommander/out/compact-1.md",
        before: 900, after: 100 },
      { t: "user", id: "g3", ts: 4, text: "recent", attachments: [] },
    ];
    for (const e of entries) await sessions.append(id, e);

    const text = (await assemble(root, id)).messages.map((m) => String(m.content)).join("\n");
    expect(text).toContain("the summary");
    expect(text).not.toContain("old one");
    expect(text).toContain("recent");
  });
});

describe("layers report", () => {
  it("names each layer and its size, for the inspector", async () => {
    const root = await makeRepo();
    const sessions = new SessionStore(root);
    const { id } = await sessions.create();
    const { layers } = await assemble(root, id);
    for (const layer of layers) {
      expect(layer.name).toBeTruthy();
      expect(layer.chars).toBeGreaterThan(0);
    }
  });
});
