/** Quota share one routed task is assumed to use at relative cost 1. */
export const TASK_BASELINE_RATIO = 0.02;

export function estimateTaskCostRatio(input: {
  relativeQuotaCost: number;
  baselineRatio: number;
}): number {
  return input.relativeQuotaCost * input.baselineRatio;
}
