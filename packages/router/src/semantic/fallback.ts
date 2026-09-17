import type { SemanticCandidate } from "./candidate.js";
import type { ReasoningEffort } from "../domain/model-profile.js";
import type { WorkflowPhase } from "../domain/session.js";

export function deterministicFallback(input: {
  family: string;
  candidates: SemanticCandidate[];
}): { candidateOpaqueId: string; effort: ReasoningEffort; phase: WorkflowPhase } | undefined {
  if (input.family !== "routine-transformation" && input.family !== "metadata") {
    return undefined;
  }
  const candidate = input.candidates[0];
  if (!candidate) {
    return undefined;
  }
  const effort = candidate.supportedEfforts.includes("low")
    ? "low"
    : (candidate.supportedEfforts[0] ?? "medium");
  return {
    candidateOpaqueId: candidate.opaqueId,
    effort,
    phase: input.family as WorkflowPhase,
  };
}
