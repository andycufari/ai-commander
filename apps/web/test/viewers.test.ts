import { describe, expect, it } from "vitest";
import { extensionOf, ViewerRegistry } from "../src/viewers.js";

describe("extensionOf", () => {
  it("reads the extension", () => {
    expect(extensionOf("a/b/main.c")).toBe("c");
    expect(extensionOf("IMAGE.PNG")).toBe("png");
  });

  it("treats a leading dot as part of the name, not an extension", () => {
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("Makefile")).toBe("");
  });
});

describe("ViewerRegistry", () => {
  const reg = new ViewerRegistry();

  it("routes markdown to a rendered editor view", () => {
    expect(reg.resolve("docs/BUILDME.md")).toMatchObject({ name: "markdown", view: "editor", mode: "view" });
  });

  it("routes images to the viewer", () => {
    for (const p of ["a.png", "b/c.JPEG", "icon.svg"]) {
      expect(reg.resolve(p).view).toBe("viewer");
    }
  });

  it("routes code to the editor in edit mode", () => {
    expect(reg.resolve("src/main.c")).toMatchObject({ name: "text", mode: "edit" });
  });

  it("claims known bare filenames", () => {
    expect(reg.resolve("Makefile").name).toBe("text");
    expect(reg.resolve("Dockerfile").name).toBe("text");
  });

  it("falls back to text for an unknown extension rather than refusing", () => {
    expect(reg.resolve("firmware.bin").name).toBe("text");
    expect(reg.resolve("noextension").name).toBe("text");
  });

  it("lets a registered viewer take over an extension by priority", () => {
    const custom = new ViewerRegistry();
    custom.register({
      name: "gcode", view: "viewer", extensions: ["gcode", "png"], mode: "view", priority: 100,
    });
    expect(custom.resolve("part.gcode").name).toBe("gcode");
    // higher priority beats the built-in image viewer on a shared extension
    expect(custom.resolve("shot.png").name).toBe("gcode");
  });

  it("replaces an entry registered under the same name", () => {
    const custom = new ViewerRegistry();
    custom.register({ name: "x", view: "viewer", extensions: ["q"], mode: "view", priority: 5 });
    custom.register({ name: "x", view: "editor", extensions: ["q"], mode: "edit", priority: 5 });
    expect(custom.list().filter((e) => e.name === "x")).toHaveLength(1);
    expect(custom.resolve("a.q").view).toBe("editor");
  });
});
