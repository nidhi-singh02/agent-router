import { describe, expect, it } from "vitest";
import { createHerdrClient } from "../../src/launch/herdr-client.js";
import { launchRoutedAgent } from "../../src/launch/herdr-launcher.js";

describe("herdr launcher", () => {
  it("errors clearly outside Herdr", async () => {
    const result = await launchRoutedAgent({
      env: {},
      agent: "cursor",
      launchName: "grok-4.6",
      effort: "medium",
      handoff: "task",
      dryRun: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/HERDR_ENV/i);
    }
  });

  it("prints a redacted dry run with the verified Cursor model id and without creating a pane", async () => {
    const calls: string[][] = [];
    const result = await launchRoutedAgent({
      env: { HERDR_ENV: "1" },
      agent: "cursor",
      launchName: "grok-4.6",
      effort: "medium",
      handoff: "fix token sk-secret-123",
      dryRun: true,
      herdr: createHerdrClient(async (argv) => {
        calls.push([...argv]);
        return { ok: true, code: 0, stdout: "", stderr: "" };
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.paneCreated).toBe(false);
      expect(result.printed).toContain("cursor-grok-4.6-medium");
      expect(result.printed).not.toContain("--thinking");
      expect(result.printed).not.toContain("--force");
      expect(result.printed).not.toContain("sk-secret-123");
    }
    expect(calls).toEqual([]);
  });

  it("reuses a launch token instead of splitting a second pane", async () => {
    const calls: string[][] = [];
    const herdr = createHerdrClient(async (argv) => {
      calls.push([...argv]);
      return { ok: true, code: 0, stdout: "pane_abc\n", stderr: "" };
    });
    const first = await launchRoutedAgent({
      env: { HERDR_ENV: "1" },
      agent: "cursor",
      launchName: "grok-4.6",
      effort: "medium",
      handoff: "approved plan",
      dryRun: false,
      herdr,
    });
    const second = await launchRoutedAgent({
      env: { HERDR_ENV: "1" },
      agent: "cursor",
      launchName: "grok-4.6",
      effort: "medium",
      handoff: "approved plan",
      dryRun: false,
      herdr,
      existingLaunchToken: first.launchToken,
      existingPaneId: first.paneId,
    });
    expect(second.ok).toBe(true);
    expect(calls.filter((argv) => argv[1] === "pane" && argv[2] === "split")).toHaveLength(1);
  });
});
