import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCursorStatuslineCollector } from "../../src/collectors/cursor/cursor-statusline-collector.js";
import { personal } from "../cli/fixtures.js";

const nowMs = Date.parse("2026-09-17T10:00:00.000Z");

function cacheFile(contents: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cursor-quota-"));
  const file = path.join(dir, "statusline-quota-cache.json");
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

function collector(cachePath: string) {
  return createCursorStatuslineCollector({ cachePath, now: () => nowMs });
}

describe("cursor status line quota collector", () => {
  it("reads spend and auto pools from the status line cache", async () => {
    const at = (nowMs - 95_000) / 1000;
    const cachePath = cacheFile({
      text: "quota $0.00/$20.00  auto 80% left  limit hit",
      pct: 0,
      auto_left: 80,
      at,
    });
    const snapshot = await collector(cachePath).collectUsage(personal);
    expect(collector(cachePath).kind).toBe("local-session");
    expect(snapshot).toMatchObject({
      accountId: personal.id,
      source: "local-session",
      certainty: "estimated",
      collectedAt: new Date(at * 1000).toISOString(),
    });
    expect(snapshot.windows).toEqual([
      { kind: "monthly", pool: "spend", remainingRatio: 0, usedRatio: 1 },
      { kind: "monthly", pool: "auto", remainingRatio: 0.8, usedRatio: 0.2 },
    ]);
    expect(Date.parse(snapshot.expiresAt)).toBeGreaterThan(nowMs);
  });

  it.each([
    ["the cache file is missing", () => path.join(os.tmpdir(), "missing-cursor-quota.json")],
    ["the cache is not JSON", () => cacheFile("not json")],
    [
      "the status line has no quota yet",
      () => cacheFile({ text: "quota —", pct: 0, auto_left: 0, at: 0 }),
    ],
    [
      "the cache is older than 15 minutes",
      () => cacheFile({ text: "quota", pct: 50, auto_left: 50, at: (nowMs - 16 * 60_000) / 1000 }),
    ],
  ])("returns unknown usage when %s", async (_label, makePath) => {
    const snapshot = await collector(makePath()).collectUsage(personal);
    expect(snapshot.certainty).toBe("unknown");
    expect(snapshot.windows.every((window) => window.remainingRatio === undefined)).toBe(true);
  });
});
