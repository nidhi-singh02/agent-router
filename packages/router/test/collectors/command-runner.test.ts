import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/collectors/command-runner.js";

describe("runCommand", () => {
  it("reports the exit code and that it did not time out", async () => {
    const result = await runCommand({
      command: "node",
      args: ["-e", "process.exit(3)"],
      timeoutMs: 2_000,
      maxBytes: 1024,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it("runs in the requested cwd", async () => {
    const result = await runCommand({
      command: "node",
      args: ["-e", "process.stdout.write(process.cwd())"],
      timeoutMs: 2_000,
      maxBytes: 4096,
      cwd: "/tmp",
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("tmp");
  });

  it("flags a timeout", async () => {
    const result = await runCommand({
      command: "node",
      args: ["-e", "setTimeout(() => {}, 5000)"],
      timeoutMs: 150,
      maxBytes: 1024,
    });
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
  });
});
