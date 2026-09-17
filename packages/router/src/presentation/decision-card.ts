export function formatDecisionCard(input: {
  selected: string;
  phase: string;
  why: string;
  sharedActivity?: string;
  reservePolicy: string;
  cacheDecision: string;
  usageSource: string;
  quota?: string;
  freshness?: string;
  reset?: string;
}): string {
  return [
    `Selected: ${input.selected}`,
    `Phase: ${input.phase}`,
    `Why: ${input.why}`,
    input.sharedActivity ? `Shared activity: ${input.sharedActivity}` : undefined,
    `Reserve policy: ${input.reservePolicy}`,
    `Cache decision: ${input.cacheDecision}`,
    `Usage source: ${input.usageSource}`,
    input.quota ? `Quota: ${input.quota}` : undefined,
    input.freshness ? `Freshness: ${input.freshness}` : undefined,
    input.reset ? `Reset: ${input.reset}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}
