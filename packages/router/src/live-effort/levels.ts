import type { ReasoningEffort } from "../domain/model-profile.js";

/** Levels only the user can unlock: the root task says "ultra", or the manual override. */
export const TOP_TIER: ReadonlySet<ReasoningEffort> = new Set(["max", "ultra"]);

export function isTopTier(effort: ReasoningEffort): boolean {
  return TOP_TIER.has(effort);
}

/**
 * Models whose running session can change effort in place. Hardcoded on purpose: the
 * switch drives each agent's TUI, verified against Claude Code 2.1.283 and codex-cli
 * 0.156.1, so a new model needs its own verification before it joins this list.
 */
export const LIVE_EFFORT_MODELS: ReadonlySet<string> = new Set([
  "anthropic:claude-opus",
  "openai:gpt-6-astra",
]);

/** Every level from least to most reasoning; compares any two levels, top tier included. */
export const EFFORT_ORDER: readonly ReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

export function effortRank(effort: ReasoningEffort): number {
  return EFFORT_ORDER.indexOf(effort);
}

/**
 * The levels an in-place switch may target, which is also the Claude slider's order from
 * its first position. Top-tier levels are never reached in place.
 */
export const LIVE_LEVELS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

/**
 * Claude Code sets CLAUDECODE for its tools, and Codex sets CODEX_THREAD_ID or CODEX_SANDBOX.
 * These are guards against an agent acting in the user's name by mistake, not a security
 * boundary: an agent with a shell can unset them.
 */
export function runsInsideAgent(env: NodeJS.Dict<string>): boolean {
  return Boolean(env.CLAUDECODE || env.CODEX_THREAD_ID || env.CODEX_SANDBOX);
}

/** The root `router run` task unlocks the top tier for its whole session chain. */
export function taskUnlocksTopTier(task: string): boolean {
  return /\bultra\b/i.test(task);
}
