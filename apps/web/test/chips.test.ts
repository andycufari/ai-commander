import { describe, expect, it } from "vitest";
import { addChips, chipLabel, fileAttachment, removeChip, toChip } from "../src/chips.js";

describe("chip labels", () => {
  it("prefixes by kind, the way the picker writes them", () => {
    expect(chipLabel({ kind: "file", path: "src/main.c", hash: "" })).toBe("@src/main.c");
    expect(chipLabel({ kind: "skill", name: "esp32" })).toBe("/esp32");
    expect(chipLabel({ kind: "tool", name: "sql" })).toBe("#sql");
    expect(chipLabel({ kind: "image", file: "img/pcb-v3.jpg" })).toBe("pcb-v3.jpg");
  });
});

describe("addChips", () => {
  it("adds attachments in order", () => {
    const chips = addChips([], [fileAttachment("a.c"), fileAttachment("b.c")]);
    expect(chips.map((c) => c.label)).toEqual(["@a.c", "@b.c"]);
  });

  it("ignores a file already attached", () => {
    const first = addChips([], [fileAttachment("a.c")]);
    const second = addChips(first, [fileAttachment("a.c"), fileAttachment("b.c")]);
    expect(second.map((c) => c.label)).toEqual(["@a.c", "@b.c"]);
  });

  it("keeps different kinds with the same name apart", () => {
    const chips = addChips([], [{ kind: "skill", name: "x" }, { kind: "tool", name: "x" }]);
    expect(chips).toHaveLength(2);
  });

  it("does not mutate the input", () => {
    const before = addChips([], [fileAttachment("a.c")]);
    addChips(before, [fileAttachment("b.c")]);
    expect(before).toHaveLength(1);
  });
});

describe("removeChip", () => {
  it("removes by key", () => {
    const chips = addChips([], [fileAttachment("a.c"), fileAttachment("b.c")]);
    const left = removeChip(chips, toChip(fileAttachment("a.c")).key);
    expect(left.map((c) => c.label)).toEqual(["@b.c"]);
  });
});
