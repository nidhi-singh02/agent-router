import type { AgentId } from "../domain/ids.js";
import type { ReasoningEffort } from "../domain/model-profile.js";

const CLAUDE_EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high"]);
// Codex reads model_reasoning_effort from config; `none` keeps the user's Codex default.
const CODEX_EFFORTS: Partial<Record<ReasoningEffort, string>> = {
  low: "low",
  medium: "medium",
  high: "high",
  ultra: "xhigh",
};

export function cursorModelId(launchName: string, effort: ReasoningEffort): string {
  if (effort === "none" || /^cursor-.+-(none|low|medium|high|ultra)$/.test(launchName)) {
    return launchName;
  }
  const base = launchName.replace(/^cursor-/, "");
  return `cursor-${base}-${effort}`;
}

export function herdrAgentKind(agent: AgentId): "cursor" | "claude" | "codex" | "opencode" {
  return agent === "claude-code" ? "claude" : agent;
}

export function buildAgentCommand(input: {
  agent: AgentId;
  launchName: string;
  effort: ReasoningEffort;
}): string[] {
  switch (input.agent) {
    case "cursor":
      return ["agent", "--model", cursorModelId(input.launchName, input.effort)];
    case "claude-code": {
      const args = ["claude", "--model", input.launchName];
      if (CLAUDE_EFFORTS.has(input.effort)) {
        args.push("--effort", input.effort);
      }
      return args;
    }
    case "codex": {
      const args = ["codex", "--model", input.launchName];
      const codexEffort = CODEX_EFFORTS[input.effort];
      if (codexEffort) {
        args.push("-c", `model_reasoning_effort="${codexEffort}"`);
      }
      return args;
    }
    case "opencode":
      return ["opencode", "--model", input.launchName];
  }
}
