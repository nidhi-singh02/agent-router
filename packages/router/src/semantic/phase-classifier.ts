import { choice } from "@typesafe-ai/sdk";

export const PHASES = {
  planning: "The workflow is still deciding what to build.",
  specification: "The workflow is writing or tightening the spec.",
  implementation: "The workflow is executing an approved spec or plan.",
  debugging: "The workflow is investigating a defect.",
  review: "The workflow is checking completed work.",
  "creative-ideation": "The workflow is exploring creative options.",
  metadata: "The workflow is producing metadata or packaging.",
  research: "The workflow is gathering information.",
  "routine-transformation": "The workflow is applying a known transformation.",
} as const;

export function phaseQuestion() {
  return choice("Which workflow phase is this request in?", PHASES);
}
