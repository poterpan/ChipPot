import { describe, expect, it } from "vitest";
import { renderTemplate } from "../../src/core/templates";

describe("renderTemplate", () => {
  it("replaces known {keys} and leaves unknown ones untouched", () => {
    expect(renderTemplate("嗨 {name}，{period} 欠 {total}", { name: "小明", period: "2026-06", total: "1,258" }))
      .toBe("嗨 小明，2026-06 欠 1,258");
    expect(renderTemplate("{a}{b}", { a: "X" })).toBe("X{b}"); // unknown {b} kept
  });

  it("replaces every occurrence of a key", () => {
    expect(renderTemplate("{x}-{x}", { x: "7" })).toBe("7-7");
  });
});
