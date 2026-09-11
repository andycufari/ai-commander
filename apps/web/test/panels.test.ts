import { describe, expect, it } from "vitest";
import { clampGutter, GUTTER_MAX, GUTTER_MIN, GUTTER_STEP } from "../src/panels.js";

describe("clampGutter", () => {
  it("keeps a sane fraction untouched", () => {
    expect(clampGutter(0.5)).toBe(0.5);
    expect(clampGutter(0.35)).toBe(0.35);
  });

  it("clamps to the usable range so a panel never vanishes by dragging", () => {
    expect(clampGutter(0)).toBe(GUTTER_MIN);
    expect(clampGutter(-2)).toBe(GUTTER_MIN);
    expect(clampGutter(1)).toBe(GUTTER_MAX);
    expect(clampGutter(99)).toBe(GUTTER_MAX);
  });

  it("rounds away float drift from repeated steps", () => {
    // 0.5 - 0.05 - 0.05 … in binary floats accumulates error; the gutter must not.
    let g = 0.5;
    for (let i = 0; i < 4; i += 1) g = clampGutter(g - GUTTER_STEP);
    expect(g).toBe(0.3);
    for (let i = 0; i < 4; i += 1) g = clampGutter(g + GUTTER_STEP);
    expect(g).toBe(0.5);
  });

  it("steps stay inside the range at the edges", () => {
    let g = GUTTER_MIN;
    g = clampGutter(g - GUTTER_STEP);
    expect(g).toBe(GUTTER_MIN);
    g = GUTTER_MAX;
    g = clampGutter(g + GUTTER_STEP);
    expect(g).toBe(GUTTER_MAX);
  });
});
