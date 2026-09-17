import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeStatuslineCollector } from "../../src/collectors/anthropic/claude-statusline-collector.js";
import { shared } from "../cli/fixtures.js";

const nowMs = Date.parse("2026-09-17T10:00:00.000Z");
const nowSec = nowMs / 1000;

function cacheFile(contents: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "claude-quota-"));
  const file = path.join(dir, "statusline-quota-cache.json");
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

function collect(cachePath: string) {
  return createClaudeStatuslineCollector({ cachePath, now: () => nowMs }).collectUsage(shared);
}

describe("claude status line quota collector", () => {
  it("reads five-hour and weekly limits with reset times", async () => {
    const snapshot = await collect(
      cacheFile({
        at: nowSec - 60,
        five_hour: { used_percentage: 22, resets_at: nowSec + 2 * 3600 },
        seven_day: { used_percentage: 40, resets_at: nowSec + 5 * 86400 },
      }),
    );
    expect(snapshot).toMatchObject({
      accountId: shared.id,
      source: "local-session",
      certainty: "estimated",
      collectedAt: new Date((nowSec - 60) * 1000).toISOString(),
    });
    expect(snapshot.windows).toEqual([
      {
        kind: "five-hour",
        remainingRatio: 0.78,
        usedRatio: 0.22,
        resetsAt: new Date((nowSec + 2 * 3600) * 1000).toISOString(),
      },
      {
        kind: "weekly",
        remainingRatio: 0.6,
        usedRatio: 0.4,
        resetsAt: new Date((nowSec + 5 * 86400) * 1000).toISOString(),
      },
    ]);
    expect(Date.parse(snapshot.expiresAt)).toBeGreaterThan(nowMs);
  });

  it("treats a window whose reset time has passed as fully available", async () => {
    const snapshot = await collect(
      cacheFile({
        at: nowSec - 600,
        five_hour: { used_percentage: 95, resets_at: nowSec - 30 },
        seven_day: { used_percentage: 40, resets_at: nowSec + 86400 },
      }),
    );
    expect(snapshot.windows[0]).toMatchObject({
      kind: "five-hour",
      remainingRatio: 1,
      usedRatio: 0,
    });
  });

  it("keeps only the windows present in the cache", async () => {
    const snapshot = await collect(
      cacheFile({ at: nowSec, seven_day: { used_percentage: 10, resets_at: nowSec + 86400 } }),
    );
    expect(snapshot.windows.map((window) => window.kind)).toEqual(["weekly"]);
  });

  it.each([
    ["the cache file is missing", () => path.join(os.tmpdir(), "missing-claude-quota.json")],
    ["the cache is not JSON", () => cacheFile("not json")],
    ["the cache has no limit windows", () => cacheFile({ at: nowSec })],
    [
      "the cache is older than 15 minutes",
      () =>
        cacheFile({
          at: nowSec - 16 * 60,
          seven_day: { used_percentage: 10, resets_at: nowSec + 86400 },
        }),
    ],
  ])("returns unknown usage when %s", async (_label, makePath) => {
    const snapshot = await collect(makePath());
    expect(snapshot.certainty).toBe("unknown");
    expect(snapshot.windows.every((window) => window.remainingRatio === undefined)).toBe(true);
  });
});
