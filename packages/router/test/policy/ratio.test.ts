import { describe, expect, it } from "vitest";
import { roundRatio } from "../../src/policy/ratio.js";

describe("roundRatio", () => {
  it("stabilizes binary-float sums at six decimals by default", () => {
    expect(roundRatio(0.1 + 0.2)).toBe(0.3);
  });

  it("leaves already-rounded six-decimal values unchanged", () => {
    expect(roundRatio(0.41)).toBe(0.41);
  });

  it("honors a custom decimal count", () => {
    expect(roundRatio(0.4167, 2)).toBe(0.42);
  });

  it("rounds negative remaining (over-quota) the same way", () => {
    expect(roundRatio(-0.1234567)).toBe(-0.123457);
  });
});
