import { createHash } from "node:crypto";
import type { AgentId, ProviderId } from "../domain/ids.js";
import type { ReasoningEffort } from "../domain/model-profile.js";

export function cacheAffinityKey(input: {
  provider: ProviderId | string;
  modelId: string;
  effort: ReasoningEffort;
  agent: AgentId | string;
  promptPrefix: string;
}): string {
  const prefixHash = createHash("sha256").update(input.promptPrefix).digest("hex").slice(0, 12);
  return [input.provider, input.modelId, input.effort, input.agent, prefixHash].join(":");
}
