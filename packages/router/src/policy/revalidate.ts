import type { ReasoningEffort } from "../domain/model-profile.js";
import { evaluateEligibility, type EligibilityInput, type ExclusionReason } from "./eligibility.js";

export type RevalidationResult =
  { ok: true } | { ok: false; reason: ExclusionReason | "unsupported-effort" };

export function revalidateDecision(
  input: EligibilityInput & { selectedEffort: ReasoningEffort },
): RevalidationResult {
  if (!input.model.supportedEfforts.includes(input.selectedEffort)) {
    return { ok: false, reason: "unsupported-effort" };
  }
  const eligibility = evaluateEligibility(input);
  if (!eligibility.eligible) {
    return { ok: false, reason: eligibility.reason };
  }
  return { ok: true };
}
