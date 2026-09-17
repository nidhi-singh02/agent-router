import { describe, expect, it } from "vitest";
import { buildHandoff } from "../../src/handoff/handoff-builder.js";

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
});
