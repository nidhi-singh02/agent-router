import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createCursorCollector } from "../../src/collectors/cursor/cursor-collector.js";
import { createClaudeCollector } from "../../src/collectors/anthropic/claude-collector.js";
import { createCodexCollector } from "../../src/collectors/openai/codex-collector.js";
import { personal, shared } from "../cli/fixtures.js";
import { AccountSchema } from "../../src/domain/account.js";
import type { runCommand } from "../../src/collectors/command-runner.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/providers");

function runner(
  stdout: string,
  inspect?: (input: Parameters<typeof runCommand>[0]) => void,
): typeof runCommand {
  return async (input) => {
    inspect?.(input);
    expect(input.maxBytes).toBeLessThanOrEqual(65_536);
    expect(input.timeoutMs).toBeLessThanOrEqual(8_000);
    return { ok: true, stdout, stderr: "", executedReturnedOutput: false as const };
  };
}

describe("official CLI collectors", () => {
  it("runs agent status --format json and parses bounded Cursor output", async () => {
    const inspect = vi.fn();
    const collector = createCursorCollector(
      runner(readFileSync(path.join(fixtures, "cursor.json"), "utf8"), inspect),
    );
    const snapshot = await collector.collectUsage(personal);
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ command: "agent", args: ["status", "--format", "json"] }),
    );
    expect(snapshot.certainty).toBe("exact");
    expect(snapshot.windows[0]?.remainingRatio).toBeCloseTo(0.72);
    expect(snapshot.accountId).toBe(personal.id);
  });

  it("runs claude auth status --json and keeps missing five-hour quota unknown", async () => {
    const inspect = vi.fn();
    const collector = createClaudeCollector(
      runner(readFileSync(path.join(fixtures, "anthropic.json"), "utf8"), inspect),
    );
    const snapshot = await collector.collectUsage(shared);
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ command: "claude", args: ["auth", "status", "--json"] }),
    );
    expect(
      snapshot.windows.find((window) => window.kind === "five-hour")?.remainingRatio,
    ).toBeUndefined();
    expect(snapshot.certainty).toBe("estimated");
  });

  it("runs codex login status and attaches weekly remaining when present", async () => {
    const inspect = vi.fn();
    const collector = createCodexCollector(
      runner(readFileSync(path.join(fixtures, "openai.json"), "utf8"), inspect),
    );
    const account = AccountSchema.parse({
      ...shared,
      id: "acct_codex",
      provider: "openai",
      agent: "codex",
      ownership: "personal",
      enabledModels: ["openai:codex"],
    });
    const snapshot = await collector.collectUsage(account);
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ command: "codex", args: ["login", "status"] }),
    );
    expect(snapshot.windows[0]?.remainingRatio).toBeCloseTo(0.7);
  });

  it("returns honest unknown when a verified status command exposes no quota", async () => {
    const collector = createCursorCollector(runner(JSON.stringify({ auth: { loggedIn: true } })));
    const snapshot = await collector.collectUsage(personal);
    expect(snapshot.certainty).toBe("unknown");
    expect(snapshot.windows[0]?.remainingRatio).toBeUndefined();
  });
});
