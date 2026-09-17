import { describe, expect, it } from "vitest";
import { buildAgentCommand, cursorModelId } from "../../src/launch/agent-command.js";

describe("agent commands", () => {
  it("encodes Cursor medium effort in --model and omits --thinking and --force", () => {
    expect(cursorModelId("grok-4.6", "medium")).toBe("cursor-grok-4.6-medium");
    expect(
      buildAgentCommand({ agent: "cursor", launchName: "grok-4.6", effort: "medium" }),
    ).toEqual(["agent", "--model", "cursor-grok-4.6-medium"]);
    expect(
      buildAgentCommand({ agent: "cursor", launchName: "grok-4.6", effort: "medium" }),
    ).not.toContain("--thinking");
    expect(
      buildAgentCommand({ agent: "cursor", launchName: "grok-4.6", effort: "medium" }),
    ).not.toContain("--force");
  });

  it("uses an already-qualified Cursor model id as --model", () => {
    expect(
      buildAgentCommand({
        agent: "cursor",
        launchName: "cursor-grok-4.6-medium",
        effort: "medium",
      }),
    ).toEqual(["agent", "--model", "cursor-grok-4.6-medium"]);
  });

  it("launches Cursor models without effort variants by their exact name", () => {
    expect(cursorModelId("composer-2.5", "none")).toBe("composer-2.5");
    expect(
      buildAgentCommand({ agent: "cursor", launchName: "composer-2.5", effort: "none" }),
    ).toEqual(["agent", "--model", "composer-2.5"]);
  });

  it("starts Claude Code with --model and --effort", () => {
    expect(
      buildAgentCommand({ agent: "claude-code", launchName: "sonnet", effort: "high" }),
    ).toEqual(["claude", "--model", "sonnet", "--effort", "high"]);
  });

  it("starts Codex with --model and the chosen reasoning effort", () => {
    expect(
      buildAgentCommand({ agent: "codex", launchName: "gpt-5.6-sol", effort: "medium" }),
    ).toEqual(["codex", "--model", "gpt-5.6-sol", "-c", 'model_reasoning_effort="medium"']);
    expect(
      buildAgentCommand({ agent: "codex", launchName: "gpt-6-astra", effort: "ultra" }).slice(-2),
    ).toEqual(["-c", 'model_reasoning_effort="ultra"']);
    expect(
      buildAgentCommand({ agent: "codex", launchName: "gpt-5.6-sol", effort: "none" }),
    ).toEqual(["codex", "--model", "gpt-5.6-sol"]);
  });

  it("starts OpenCode with --model in provider/model form", () => {
    expect(
      buildAgentCommand({ agent: "opencode", launchName: "openai/gpt", effort: "low" }),
    ).toEqual(["opencode", "--model", "openai/gpt"]);
  });
});
