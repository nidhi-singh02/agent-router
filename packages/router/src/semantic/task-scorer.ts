import { score } from "@typesafe-ai/sdk";

const LEVELS = [
  "Very low: the work is obvious and tightly bounded.",
  "Moderate: some judgment is needed but the path is mostly clear.",
  "High: multiple reasonable approaches or incomplete information.",
  "Severe: mistakes would be costly or the space is highly ambiguous.",
] as const;

export function complexityQuestion() {
  return score("How complex is this task?", LEVELS);
}

export function creativityQuestion() {
  return score("How much original creative judgment does this task need?", LEVELS);
}

export function consequenceQuestion() {
  return score("How consequential is a wrong model or quota choice?", LEVELS);
}
