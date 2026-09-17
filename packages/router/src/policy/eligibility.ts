import type { Account } from "../domain/account.js";
import type { ModelProfile } from "../domain/model-profile.js";
import type { UsageSnapshot } from "../domain/usage.js";
import { isFresh } from "./freshness.js";
import { projectedRemainingRatio } from "./quota.js";

export type ExclusionReason =
  "account-disabled" | "stale-usage" | "unknown-usage" | "below-reserve" | "model-not-enabled";

export type EligibilityResult =
  | { eligible: true; projectedRemainingRatio: number }
  | { eligible: false; reason: ExclusionReason; projectedRemainingRatio?: number };

export interface EligibilityInput {
  account: Account;
  model: ModelProfile;
  usage: UsageSnapshot;
  estimatedCostRatio: number;
  now: Date;
}

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  if (!input.account.enabled) {
    return { eligible: false, reason: "account-disabled" };
  }
  if (!input.account.enabledModels.includes(input.model.id)) {
    return { eligible: false, reason: "model-not-enabled" };
  }
  if (!isFresh(input.usage, input.now)) {
    return { eligible: false, reason: "stale-usage" };
  }
  const projected = projectedRemainingRatio(input.usage, input.estimatedCostRatio);
  if (projected === undefined) {
    if (input.account.ownership === "shared") {
      return { eligible: false, reason: "unknown-usage" };
    }
    return { eligible: true, projectedRemainingRatio: Number.NaN };
  }
  const roundedProjected = Math.round(projected * 1e6) / 1e6;
  if (input.account.ownership === "shared" && roundedProjected < input.account.reserveFloor) {
    return { eligible: false, reason: "below-reserve", projectedRemainingRatio: roundedProjected };
  }
  return { eligible: true, projectedRemainingRatio: roundedProjected };
}
