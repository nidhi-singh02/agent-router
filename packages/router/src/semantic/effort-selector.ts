import { choice } from "@typesafe-ai/sdk";
import type { ReasoningEffort } from "../domain/model-profile.js";
import { isTopTier } from "../live-effort/levels.js";

export function effortQuestion(supported: ReasoningEffort[], topTierUnlocked: boolean) {
  const allowed = supported.filter((effort) => !isTopTier(effort) || topTierUnlocked);
  const criteria = Object.fromEntries(
    allowed.map((effort) => [effort, `Use ${effort} reasoning for this task.`]),
  );
  return choice("Which supported reasoning effort should be used?", criteria);
}
