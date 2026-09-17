import type { WorkflowPhase } from "../domain/session.js";

export function shouldReconsiderRoute(input: {
  currentPhase: WorkflowPhase;
  nextPhase: WorkflowPhase;
  routeStillEligible: boolean;
}): boolean {
  return input.currentPhase !== input.nextPhase || !input.routeStillEligible;
}
