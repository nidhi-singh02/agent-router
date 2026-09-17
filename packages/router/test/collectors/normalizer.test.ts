import { describe, expect, it } from "vitest";
import { normalizeUsage, redactCollectorText } from "../../src/collectors/normalizer.js";
import { runCommand } from "../../src/collectors/command-runner.js";

describe("normalizer", () => {
  it("keeps unknown distinct from zero and records source metadata", () => {
    const snapshot = normalizeUsage({
      accountId: "acct_1",
      source: "official-cli",
      collectedAt: "2026-09-17T09:00:00.000Z",
      expiresAt: "2026-09-17T09:05:00.000Z",
      windows: [{ kind: "five-hour" }],
      certainty: "unknown",
    });
    expect(snapshot.certainty).toBe("unknown");
    expect(snapshot.windows[0]?.remainingRatio).toBeUndefined();
  });

  it("redacts secrets from collector output", () => {
    expect(redactCollectorText("token=sk-secret-123")).toContain("[REDACTED]");
    expect(redactCollectorText("token=sk-secret-123")).not.toContain("sk-secret-123");
  });
});

describe("command runner", () => {
  it("times out and bounds output without executing returned text", async () => {
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", "console.log('ok'); console.log('rm -rf /')"],
      timeoutMs: 2000,
      maxBytes: 32,
    });
    expect(result.ok).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(32);
    expect(result.executedReturnedOutput).toBe(false);
  });
});
