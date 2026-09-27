import { describe, expect, it } from "vitest";
import { formatSession } from "../../src/commands/session.js";
import { launchedSession } from "../live-effort/fixtures.js";

describe("formatSession with live effort", () => {
  it("shows the continuation, current level, refusal, and effort history", () => {
    const session = launchedSession({
      agent: "claude-code",
      effort: "medium",
      extras: { continuation: "in-place", liveEffort: "xhigh", liveSwitchUnsupported: true },
    });
    const text = formatSession(session, [
      {
        id: "eff_1",
        sessionId: session.id,
        source: "agent",
        from: "medium",
        to: "xhigh",
        status: "applied",
        reason: "switched",
        confidence: 0.8765,
        turnBreak: false,
        createdAt: "2026-09-26T10:00:00.000Z",
      },
      {
        id: "eff_2",
        sessionId: session.id,
        source: "manual",
        from: "xhigh",
        to: "high",
        status: "failed",
        reason: "cache-warning",
        turnBreak: false,
        createdAt: "2026-09-26T10:05:00.000Z",
      },
    ]);
    expect(text).toContain("Continuation: in place (same pane as the previous session)");
    expect(text).toContain("Current effort: xhigh");
    expect(text).toContain("Live effort switching: unsupported for this pane");
    expect(text).toContain(
      "Effort history:\n" +
        "  2026-09-26T10:00:00.000Z agent: medium -> xhigh applied (switched, confidence 0.88)\n" +
        "  2026-09-26T10:05:00.000Z manual: xhigh -> high failed (cache-warning)",
    );
    // A session at its launch level with no history prints none of these lines.
    const plain = formatSession(
      launchedSession({ agent: "claude-code", effort: "medium", extras: { liveEffort: "medium" } }),
    );
    expect(plain).not.toMatch(/Current effort|Effort history|Continuation|Live effort/);
  });
});
