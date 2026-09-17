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

  it("starts Claude Code with --model and --effort", () => {
    expect(
      buildAgentCommand({ agent: "claude-code", launchName: "sonnet", effort: "high" }),
    ).toEqual(["claude", "--model", "sonnet", "--effort", "high"]);
  });

  it("starts Codex with --model and no unverified reasoning flag", () => {
    expect(buildAgentCommand({ agent: "codex", launchName: "codex", effort: "medium" })).toEqual([
      "codex",
      "--model",
      "codex",
    ]);
  });

  it("starts OpenCode with --model in provider/model form", () => {
    expect(
      buildAgentCommand({ agent: "opencode", launchName: "openai/gpt", effort: "low" }),
    ).toEqual(["opencode", "--model", "openai/gpt"]);
  });
});
