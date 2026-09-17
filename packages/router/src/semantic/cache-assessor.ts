import { score } from "@typesafe-ai/sdk";

export function cacheValueQuestion() {
  return score("How valuable is staying on the current model cache versus switching?", [
    "No meaningful cache to preserve.",
    "Some cache exists but a switch is cheap.",
    "Cache is useful; switching needs a structured handoff.",
    "Cache is highly valuable; switching should be rare.",
  ]);
}
