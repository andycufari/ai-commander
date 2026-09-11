import { describe, expect, it } from "vitest";
import { defaultFilter, fuzzyScore, type PickItem } from "../src/Pick.js";

const items: PickItem[] = [
  { id: "1", label: "src/main.c" },
  { id: "2", label: "docs/NOTES.md" },
  { id: "3", label: "README.md" },
  { id: "4", label: "packages/core/src/loop.ts" },
];

describe("fuzzyScore", () => {
  it("matches a subsequence, in order", () => {
    expect(fuzzyScore("ai-commander", "acm")).not.toBeNull();
    expect(fuzzyScore("ai-commander", "aicmd")).not.toBeNull();
    // Out of order is not a subsequence: the m of "commander" follows the c.
    expect(fuzzyScore("ai-commander", "amc")).toBeNull();
    expect(fuzzyScore("ai-commander", "xyz")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("README.md", "readme")).not.toBeNull();
    expect(fuzzyScore("readme.md", "README")).not.toBeNull();
  });

  it("scores contiguous matches above scattered ones", () => {
    const contiguous = fuzzyScore("loop.ts", "loop")!;
    const scattered = fuzzyScore("lots of other prose", "loop")!;
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it("treats an empty query as a match", () => {
    expect(fuzzyScore("anything", "")).toBe(0);
  });
});

describe("defaultFilter", () => {
  it("returns everything for an empty query", () => {
    expect(defaultFilter(items, "")).toHaveLength(4);
    expect(defaultFilter(items, "   ")).toHaveLength(4);
  });

  it("finds a file by a fragment of its name", () => {
    expect(defaultFilter(items, "notes").map((i) => i.label)).toEqual(["docs/NOTES.md"]);
  });

  it("finds a file by a subsequence across the path", () => {
    const found = defaultFilter(items, "loopts").map((i) => i.label);
    expect(found).toContain("packages/core/src/loop.ts");
  });

  it("puts the closest match first", () => {
    // "README.md" should beat the longer paths for the query "readme".
    expect(defaultFilter(items, "readme")[0]!.label).toBe("README.md");
  });

  it("returns nothing when nothing matches", () => {
    expect(defaultFilter(items, "zzzz")).toEqual([]);
  });

  it("matches against detail and keywords too", () => {
    const withDetail: PickItem[] = [{ id: "a", label: "session one", detail: "qwen3", keywords: "brain" }];
    expect(defaultFilter(withDetail, "qwen")).toHaveLength(1);
    expect(defaultFilter(withDetail, "brain")).toHaveLength(1);
  });

  it("does not mutate the input", () => {
    const copy = [...items];
    defaultFilter(items, "main");
    expect(items).toEqual(copy);
  });
});
