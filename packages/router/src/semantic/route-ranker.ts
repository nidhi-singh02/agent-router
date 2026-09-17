import { choice, type ChoiceCriteria } from "@typesafe-ai/sdk";
import type { SemanticCandidate } from "./candidate.js";

export function routeQuestion(candidates: SemanticCandidate[]) {
  const criteria: ChoiceCriteria = {};
  for (const candidate of candidates) {
    criteria[candidate.opaqueId] = {
      agent: candidate.agent,
      projectedRemainingRatio: candidate.projectedRemainingRatio,
      capabilities: candidate.capabilities,
      supportedEfforts: [...candidate.supportedEfforts],
    };
  }
  return choice(
    "Which eligible candidate is the best quality/cost fit? Choose only from the supplied opaque IDs.",
    criteria,
  );
}
