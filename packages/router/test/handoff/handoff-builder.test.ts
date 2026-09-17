import { describe, expect, it } from "vitest";
import {
  buildHandoff,
  formatHandoffPrompt,
  serializeHandoff,
} from "../../src/handoff/handoff-builder.js";

describe("handoff builder", () => {
  it("includes the required structured fields and redacts secrets", () => {
    const handoff = buildHandoff({
      task: "Implement billing with token sk-secret-123",
      approvedSpec: "Use SQLite locally",
      constraints: ["no live deploy"],
      currentPhase: "implementation",
      relevantFiles: ["packages/router/src/store/database.ts"],
      completedChecks: ["unit tests"],
      remainingAcceptanceCriteria: ["dry-run launch"],
    });
    expect(handoff.task).not.toContain("sk-secret-123");
    expect(handoff.phase).toBe("implementation");
    expect(handoff.relevantFiles).toContain("packages/router/src/store/database.ts");
    expect(handoff.constraints).toContain("no live deploy");
    expect(JSON.stringify(handoff)).not.toMatch(/unrelated session history/i);
  });

  it("serializes the complete structured handoff", () => {
    const handoff = buildHandoff({
      task: "Implement the session store",
      approvedSpec: "SQLite locally",
      constraints: ["no live deploy"],
      currentPhase: "implementation",
      relevantFiles: ["packages/router/src/store/database.ts"],
      completedChecks: ["unit tests"],
      remainingAcceptanceCriteria: ["dry-run launch"],
    });
    const serialized = serializeHandoff(handoff);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(parsed.phase).toBe("implementation");
    expect(parsed.task).toMatch(/Implement the session store/);
    expect(parsed.constraints).toEqual(["no live deploy"]);
    expect(parsed.relevantFiles).toEqual(["packages/router/src/store/database.ts"]);
    expect(parsed.completedChecks).toEqual(["unit tests"]);
    expect(parsed.remainingAcceptanceCriteria).toEqual(["dry-run launch"]);
  });

  it("formats a readable prompt for the agent", () => {
    const handoff = buildHandoff({
      task: "Can we get model usage through LangSmith?",
      constraints: ["Do not deploy or consume extra quota."],
      currentPhase: "research",
      relevantFiles: [],
      completedChecks: [],
      remainingAcceptanceCriteria: ["list the options"],
    });
    expect(handoff.task).toBe("Can we get model usage through LangSmith?");
    expect(formatHandoffPrompt(handoff)).toBe(
      [
        "Can we get model usage through LangSmith?",
        "",
        "Phase: research",
        "Constraints:",
        "- Do not deploy or consume extra quota.",
        "Remaining acceptance criteria:",
        "- list the options",
      ].join("\n"),
    );
  });
});
