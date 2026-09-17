import { choice } from "@typesafe-ai/sdk";
import type { ReasoningEffort } from "../domain/model-profile.js";

export function effortQuestion(supported: ReasoningEffort[], userRequestedUltra: boolean) {
  const allowed = supported.filter((effort) => effort !== "ultra" || userRequestedUltra);
  const criteria = Object.fromEntries(
    allowed.map((effort) => [effort, `Use ${effort} reasoning for this task.`]),
  );
  return choice("Which supported reasoning effort should be used?", criteria);
}
