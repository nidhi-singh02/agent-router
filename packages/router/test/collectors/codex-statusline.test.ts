import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexStatuslineCollector } from "../../src/collectors/openai/codex-statusline-collector.js";
import { personal } from "../cli/fixtures.js";

const nowMs = Date.parse("2026-09-17T10:00:00.000Z");

const codexAccount = {
  ...personal,
  agent: "codex" as const,
  provider: "openai" as typeof personal.provider,
  enabledModels: ["openai:gpt-5.5"] as unknown as typeof personal.enabledModels,
};

function cacheFile(contents: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-quota-"));
  const file = path.join(dir, "statusline-quota-cache.json");
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

function collector(cachePath: string, now = nowMs) {
  return createCodexStatuslineCollector({ cachePath, now: () => now });
}

describe("codex status line quota collector", () => {
  it("parses a fresh weekly_left cache as estimated local-session usage", async () => {
    const cachePath = cacheFile({ weekly_left: 40, at: 1_789_644_000 });
    const snapshot = await createCodexStatuslineCollector({
      cachePath,
      now: () => 1_789_644_000 * 1000 + 60_000,
    }).collectUsage(codexAccount);
    expect(snapshot.certainty).toBe("estimated");
    expect(snapshot.source).toBe("local-session");
    expect(snapshot.windows[0]).toMatchObject({
      kind: "weekly",
      remainingRatio: 0.4,
    });
  });

  it("returns unknown when the cache is older than 15 minutes", async () => {
    const at = (nowMs - 16 * 60_000) / 1000;
    const snapshot = await collector(cacheFile({ weekly_left: 40, at })).collectUsage(codexAccount);
    expect(snapshot.certainty).toBe("unknown");
    expect(snapshot.source).toBe("local-session");
  });
});
