import { choice } from "@typesafe-ai/sdk";

export const TASK_FAMILIES = {
  planning: "The user needs a plan, architecture, or approach before implementation.",
  specification: "The user needs a precise spec or acceptance criteria.",
  implementation: "The user wants code written against an approved plan or spec.",
  debugging: "The user is diagnosing a failure or unexpected behavior.",
  review: "The user wants critique, QA, or a second look at existing work.",
  "creative-ideation": "The user wants original ideas, naming, or aesthetic exploration.",
  metadata: "The user wants titles, descriptions, tags, or other packaging text.",
  research: "The user wants comparison, investigation, or evidence gathering.",
  "routine-transformation": "The work is mechanical once the rule or spec is known.",
} as const;

export function taskFamilyQuestion() {
  return choice("Which task family best describes the user's request?", TASK_FAMILIES);
}
