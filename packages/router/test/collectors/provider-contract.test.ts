import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCursorUsage } from "../../src/collectors/cursor/cursor-parser.js";
import { parseClaudeUsage } from "../../src/collectors/anthropic/claude-parser.js";
import { parseCodexUsage } from "../../src/collectors/openai/codex-parser.js";
import { parseOpenCodeStatus } from "../../src/collectors/opencode/opencode-parser.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/providers");

describe("provider parsers", () => {
  it("parses a sanitized Cursor usage fixture", () => {
    const parsed = parseCursorUsage(readFileSync(path.join(dir, "cursor.json"), "utf8"));
    expect(parsed.snapshot.certainty).toBe("exact");
    expect(parsed.snapshot.windows[0]?.remainingRatio).toBeCloseTo(0.72);
    expect(parsed.models.map((model) => model.launchName)).toContain("grok-4.6");
    expect(parsed.credentialPresent).toBe(true);
  });

  it("marks missing Anthropic five-hour data as unknown with provenance", () => {
    const parsed = parseClaudeUsage(readFileSync(path.join(dir, "anthropic.json"), "utf8"));
    const fiveHour = parsed.snapshot.windows.find((window) => window.kind === "five-hour");
    expect(fiveHour?.remainingRatio).toBeUndefined();
    expect(parsed.snapshot.certainty).toBe("estimated");
    expect(parsed.diagnostic).toMatch(/five-hour/i);
  });

  it("marks Claude usage unknown when auth status has no usage numbers", () => {
    const parsed = parseClaudeUsage(
      JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
    );
    expect(parsed.snapshot.certainty).toBe("unknown");
    expect(parsed.snapshot.windows.every((window) => window.remainingRatio === undefined)).toBe(
      true,
    );
    expect(parsed.credentialPresent).toBe(true);
  });

  it("attaches Codex usage to the OpenAI provider", () => {
    const parsed = parseCodexUsage(readFileSync(path.join(dir, "openai.json"), "utf8"));
    expect(parsed.provider).toBe("openai");
    expect(parsed.snapshot.windows[0]?.kind).toBe("weekly");
    expect(parsed.snapshot.windows[0]?.remainingRatio).toBeCloseTo(0.7);
  });

  it("reports OpenCode harness authentication without inventing quota", () => {
    const parsed = parseOpenCodeStatus(readFileSync(path.join(dir, "opencode.json"), "utf8"));
    expect(parsed.harness).toBe("opencode");
    expect(parsed.authenticatedProviders).toEqual(["openai"]);
    expect(parsed.usage).toBeUndefined();
  });

  it("returns unknown plus a diagnostic when a fixture format changes", () => {
    const parsed = parseCursorUsage("{not-json");
    expect(parsed.snapshot.certainty).toBe("unknown");
    expect(parsed.diagnostic).toBeTruthy();
  });
});
