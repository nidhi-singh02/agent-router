import { describe, expect, it } from "vitest";
import { detectPrRefs } from "../../src/enrich/ref-detector.js";

describe("detectPrRefs", () => {
  it("detects the explicit PR forms", () => {
    expect(detectPrRefs("refactor PR 9")).toEqual([9]);
    expect(detectPrRefs("refactor pr #9")).toEqual([9]);
    expect(detectPrRefs("refactor PR#9")).toEqual([9]);
    expect(detectPrRefs("look at pr 1234567")).toEqual([1234567]);
  });

  it("ignores a bare issue reference", () => {
    expect(detectPrRefs("fixes #9")).toEqual([]);
    expect(detectPrRefs("see #9 and #10")).toEqual([]);
  });

  it("returns refs in order, deduplicated", () => {
    expect(detectPrRefs("compare PR 10 with PR 9 and PR 10 again")).toEqual([10, 9]);
  });

  it("rejects values outside the integer bound", () => {
    expect(detectPrRefs("PR 12345678")).toEqual([]);
    expect(detectPrRefs("PR 0")).toEqual([]);
  });

  it("does not match inside a longer word", () => {
    expect(detectPrRefs("SUPR 9")).toEqual([]);
    expect(detectPrRefs("PRE 9")).toEqual([]);
  });

  it("returns an empty array for text with no reference", () => {
    expect(detectPrRefs("add a dark mode toggle")).toEqual([]);
  });
});
