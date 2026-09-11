import { describe, expect, it } from "vitest";
import type { FsEntry } from "@aicommander/protocol";
import {
  buildRows, formatDate, formatSize, isHidden, joinPath, parentOf, summarize, visibleEntries,
} from "../src/files.js";

const e = (name: string, dir = false, size = 0, mtime = 0): FsEntry =>
  ({ name, path: name, dir, size, mtime });

describe("visibleEntries", () => {
  it("puts directories first, then files, both alphabetical", () => {
    const rows = visibleEntries([e("zeta.md"), e("src", true), e("alpha.md"), e("apps", true)], false);
    expect(rows.map((r) => r.name)).toEqual(["apps", "src", "alpha.md", "zeta.md"]);
  });

  it("sorts case-insensitively", () => {
    const rows = visibleEntries([e("beta.md"), e("Alpha.md"), e("gamma.md")], false);
    expect(rows.map((r) => r.name)).toEqual(["Alpha.md", "beta.md", "gamma.md"]);
  });

  it("hides dotfiles by default", () => {
    const rows = visibleEntries([e(".env"), e("README.md"), e(".git", true)], false);
    expect(rows.map((r) => r.name)).toEqual(["README.md"]);
  });

  it("shows dotfiles when the toggle is on", () => {
    const rows = visibleEntries([e(".env"), e("README.md")], true);
    expect(rows.map((r) => r.name)).toEqual([".env", "README.md"]);
  });

  it("always shows .aicommander and skills, even with hidden off", () => {
    const rows = visibleEntries(
      [e(".aicommander", true), e(".git", true), e("skills", true), e("README.md")],
      false,
    );
    expect(rows.map((r) => r.name)).toEqual([".aicommander", "skills", "README.md"]);
    expect(rows.map((r) => r.name)).not.toContain(".git");
  });

  it("does not mutate the input", () => {
    const input = [e("b"), e("a")];
    visibleEntries(input, false);
    expect(input.map((r) => r.name)).toEqual(["b", "a"]);
  });
});

describe("isHidden", () => {
  it("treats a leading dot as hidden", () => {
    expect(isHidden(".env")).toBe(true);
    expect(isHidden("env")).toBe(false);
  });
});

describe("formatSize", () => {
  it("writes megabytes, kilobytes and the mockup's leading-dot fraction", () => {
    expect(formatSize(1_258_291, false)).toBe("1.2M");
    expect(formatSize(10035, false)).toBe("9.8k");
    expect(formatSize(307, false)).toBe(".3k");
    expect(formatSize(0, false)).toBe("0");
  });

  it("leaves directories blank", () => {
    expect(formatSize(4096, true)).toBe("");
  });
});

describe("formatDate", () => {
  const now = new Date("2026-09-10T00:00:00Z").getTime();

  it("writes month and day within the current year", () => {
    expect(formatDate(new Date("2026-09-08T12:00:00").getTime(), now)).toBe("sep 08");
  });

  it("writes the year once it is older", () => {
    expect(formatDate(new Date("2024-08-21T12:00:00").getTime(), now)).toBe("aug 2024");
  });

  it("returns nothing for a missing mtime", () => {
    expect(formatDate(0, now)).toBe("");
  });
});

describe("joinPath and parentOf", () => {
  it("joins against the repo root", () => {
    expect(joinPath(".", "src")).toBe("src");
    expect(joinPath("src", "main.c")).toBe("src/main.c");
  });

  it("walks up, stopping at the root", () => {
    expect(parentOf("src/deep/a.c")).toBe("src/deep");
    expect(parentOf("src")).toBe(".");
    expect(parentOf(".")).toBeNull();
  });
});

describe("summarize", () => {
  it("counts dirs and files", () => {
    expect(summarize([e("a", true), e("b", true), e("c")], 0)).toBe("2 dirs · 1 file");
  });

  it("leads with the marked count", () => {
    expect(summarize([e("a")], 2)).toBe("2 marked · 0 dirs · 1 file");
  });
});

describe("formatSize on small files", () => {
  it("shows real bytes rather than a useless .0k", () => {
    // A 22-byte Makefile rounded to ".0k", which reads as empty.
    expect(formatSize(22, false)).toBe("22");
    expect(formatSize(40, false)).toBe("40");
    expect(formatSize(0, false)).toBe("0");
  });

  it("still uses the fraction once it is meaningful", () => {
    expect(formatSize(307, false)).toBe(".3k");
    expect(formatSize(1024, false)).toBe("1.0k");
  });
});

describe("buildRows", () => {
  const dir = (name: string): FsEntry => e(name, true);

  it("puts a parent link first when not at the root", () => {
    const rows = buildRows([e("a.md")], false, new Map(), false);
    expect(rows[0]!.kind).toBe("up");
    expect(rows[1]!.entry?.name).toBe("a.md");
  });

  it("has no parent link at the root", () => {
    const rows = buildRows([e("a.md")], false, new Map(), true);
    expect(rows[0]!.kind).toBe("entry");
  });

  it("inlines an expanded directory's children, indented", () => {
    const rows = buildRows(
      [dir("src"), e("z.md")],
      false,
      new Map([["src", [e("main.c"), e("util.c")]]]),
      true,
    );
    expect(rows.map((r) => r.entry?.name)).toEqual(["src", "main.c", "util.c", "z.md"]);
    expect(rows[1]!.depth).toBe(1);
    expect(rows[0]!.expanded).toBe(true);
  });

  it("leaves a collapsed directory alone", () => {
    const rows = buildRows([dir("src")], false, new Map(), true);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expanded).toBe(false);
  });

  it("nests deeper expansions", () => {
    const rows = buildRows(
      [dir("a")],
      false,
      new Map([["a", [dir("b")]], ["b", [e("c.md")]]]),
      true,
    );
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  it("hides dotfiles inside an expanded directory too", () => {
    const rows = buildRows([dir("src")], false, new Map([["src", [e(".hidden"), e("a.c")]]]), true);
    expect(rows.map((r) => r.entry?.name)).toEqual(["src", "a.c"]);
  });
});
