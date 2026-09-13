import { describe, expect, it } from "vitest";
import { isRecord } from "../../src/utils/type-guards.js";

describe("utils/type-guards", () => {
  it("returns true for plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("treats arrays as records (typeof check semantics)", () => {
    expect(isRecord([])).toBe(true);
  });

  it("returns false for non-object values", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord("str")).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(Symbol("x"))).toBe(false);
  });
});
