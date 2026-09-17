export function estimateTaskCostRatio(input: {
  relativeQuotaCost: number;
  baselineRatio: number;
}): number {
  return input.relativeQuotaCost * input.baselineRatio;
}
