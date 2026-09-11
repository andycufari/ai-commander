import { describe, expect, it } from "vitest";
import { linkifyMentions, toolPath } from "../src/mentions.js";

const linked = (text: string): string[] =>
  linkifyMentions(text).filter((s) => s.path).map((s) => s.path!);

describe("linkifyMentions", () => {
  it("links an @path", () => {
    expect(linked("see @src/main.c for the loop")).toEqual(["src/main.c"]);
  });

  it("links a bare filename with an extension", () => {
    expect(linked("open @README.md")).toEqual(["README.md"]);
  });

  it("links several mentions in one line", () => {
    expect(linked("@a.c and @b/c.h")).toEqual(["a.c", "b/c.h"]);
  });

  it("keeps the surrounding prose intact", () => {
    const segs = linkifyMentions("see @a.c now");
    expect(segs.map((s) => s.text).join("")).toBe("see @a.c now");
  });

  it("leaves sentence punctuation out of the link", () => {
    expect(linked("look at @src/main.c.")).toEqual(["src/main.c"]);
    expect(linked("(@a.c)")).toEqual(["a.c"]);
    expect(linkifyMentions("look at @src/main.c.").map((s) => s.text).join("")).toBe("look at @src/main.c.");
  });

  it("does not link a bare word that is not path-shaped", () => {
    // @here and @everyone are prose, not files.
    expect(linked("@here @everyone @team")).toEqual([]);
  });

  it("does not link a trailing slash", () => {
    expect(linked("@src/")).toEqual([]);
  });

  it("does not linkify paths that were never mentioned with @", () => {
    // Guessing at pathish words fills prose with dead links.
    expect(linked("edit src/main.c and package.json")).toEqual([]);
  });

  it("returns the whole text when there is nothing to link", () => {
    expect(linkifyMentions("plain prose")).toEqual([{ text: "plain prose" }]);
  });

  it("handles an empty string", () => {
    expect(linkifyMentions("")).toEqual([{ text: "" }]);
  });
});

describe("toolPath", () => {
  it("returns the path for file tools", () => {
    for (const name of ["read_file", "edit_file", "write_file", "open_in_panel"]) {
      expect(toolPath(name, { path: "a.c" })).toBe("a.c");
    }
  });

  it("ignores tools that do not act on one file", () => {
    expect(toolPath("shell", { cmd: "ls" })).toBeUndefined();
    expect(toolPath("glob", { pattern: "**/*" })).toBeUndefined();
    expect(toolPath("grep", { pattern: "x", path: "src" })).toBeUndefined();
  });

  it("ignores a missing or empty path", () => {
    expect(toolPath("read_file", {})).toBeUndefined();
    expect(toolPath("read_file", { path: "" })).toBeUndefined();
    expect(toolPath("read_file", undefined)).toBeUndefined();
  });
});
