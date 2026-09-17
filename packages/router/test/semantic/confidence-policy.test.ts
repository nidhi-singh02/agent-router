import { describe, expect, it } from "vitest";
import { applyConfidencePolicy } from "../../src/semantic/decision-engine.js";

describe("confidence policy", () => {
  it("presents the top two eligible routes when a consequential choice is ambiguous", () => {
    const result = applyConfidencePolicy({
      consequenceScore: 3,
      choice: "cand_safe_a",
      confidence: 0.52,
      probabilities: { cand_safe_a: 0.48, cand_safe_b: 0.42, cand_other: 0.1 },
      eligibleIds: ["cand_safe_a", "cand_safe_b"],
    });
    expect(result).toEqual({
      action: "ask-user",
      options: ["cand_safe_a", "cand_safe_b"],
    });
  });

  it("uses the conservative default for low-risk ambiguity", () => {
    const result = applyConfidencePolicy({
      consequenceScore: 0,
      choice: "cand_safe_a",
      confidence: 0.4,
      probabilities: { cand_safe_a: 0.45, cand_safe_b: 0.55 },
      eligibleIds: ["cand_safe_a", "cand_safe_b"],
    });
    expect(result).toEqual({ action: "use-default", option: "cand_safe_a" });
  });
});
