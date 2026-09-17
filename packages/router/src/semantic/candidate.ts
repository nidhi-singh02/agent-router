import type { AgentId } from "../domain/ids.js";
import type { ReasoningEffort } from "../domain/model-profile.js";

export interface SemanticCandidate {
  opaqueId: string;
  agent: AgentId;
  modelId: string;
  supportedEfforts: readonly ReasoningEffort[];
  projectedRemainingRatio: number;
  capabilities: {
    planning: number;
    coding: number;
    debugging: number;
    creativity: number;
    research: number;
  };
}
