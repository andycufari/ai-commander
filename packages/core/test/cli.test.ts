import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.js";

describe("parseArgs", () => {
  it("takes a repo path", () => {
    expect(parseArgs(["serve", "/repo"])).toMatchObject({ repo: "/repo", port: 7777 });
  });

  it("takes --port and --brain in any order", () => {
    const a = parseArgs(["serve", "/repo", "--port", "9000", "--brain", "http://box:8080/v1"]);
    const b = parseArgs(["serve", "--brain", "http://box:8080/v1", "--port", "9000", "/repo"]);
    expect(a).toMatchObject({ port: 9000, brain: "http://box:8080/v1" });
    expect(b).toMatchObject(a);
  });

  it("rejects a --brain that is not a URL", () => {
    expect(() => parseArgs(["serve", "/repo", "--brain", "box:8080"])).toThrow(/must be an http\(s\) URL/);
    expect(() => parseArgs(["serve", "/repo", "--brain", "::::"])).toThrow(/must be a URL/);
  });

  it("rejects a bad port", () => {
    expect(() => parseArgs(["serve", "/repo", "--port", "99999"])).toThrow(/0-65535/);
    expect(() => parseArgs(["serve", "/repo", "--port", "abc"])).toThrow(/0-65535/);
  });

  it("rejects a flag with no value", () => {
    expect(() => parseArgs(["serve", "/repo", "--brain"])).toThrow(/needs a value/);
  });

  it("rejects unknown options and commands", () => {
    expect(() => parseArgs(["serve", "/repo", "--wat"])).toThrow(/unknown option/);
    expect(() => parseArgs(["nope", "/repo"])).toThrow(/unknown command/);
  });

  it("needs a repo path", () => {
    expect(() => parseArgs(["serve"])).toThrow(/needs a repo path/);
    expect(() => parseArgs(["serve", "/a", "/b"])).toThrow(/only one repo/);
  });
});
