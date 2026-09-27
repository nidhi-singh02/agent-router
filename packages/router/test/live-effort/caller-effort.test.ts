import { describe, expect, it } from "vitest";
import { callerClaudeEffort } from "../../src/live-effort/switcher.js";

describe("callerClaudeEffort", () => {
  it("counts CLAUDE_EFFORT only when it is a known level", () => {
    expect(callerClaudeEffort({ CLAUDE_EFFORT: "xhigh" })).toBe("xhigh");
    expect(callerClaudeEffort({ CLAUDE_EFFORT: "HIGH" })).toBeUndefined();
    expect(callerClaudeEffort({})).toBeUndefined();
  });
});
