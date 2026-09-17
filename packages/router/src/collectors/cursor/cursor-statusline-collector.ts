import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Account } from "../../domain/account.js";
import type { UsageSnapshot } from "../../domain/usage.js";
import { normalizeUsage } from "../normalizer.js";
import type { UsageCollector } from "../types.js";

// Written by a user's Cursor agent status line script after it calls Cursor's usage API.
// The router only reads this file; it never handles the Cursor auth token.
export const CURSOR_QUOTA_MAX_AGE_MS = 15 * 60_000;

const CacheSchema = z.object({
  pct: z.number(),
  auto_left: z.number(),
  at: z.number().positive(),
});

export function defaultCursorQuotaCachePath(home = os.homedir()): string {
  return path.join(home, ".cursor", "statusline-quota-cache.json");
}

function poolWindow(pool: string, percentLeft: number) {
  const left = Math.max(0, Math.min(100, percentLeft));
  return {
    kind: "monthly" as const,
    pool,
    remainingRatio: left / 100,
    usedRatio: (100 - left) / 100,
  };
}

export function createCursorStatuslineCollector(
  options: { cachePath?: string; now?: () => number } = {},
): UsageCollector {
  const cachePath = options.cachePath ?? defaultCursorQuotaCachePath();
  const now = options.now ?? Date.now;

  function unknown(account: Account): UsageSnapshot {
    const at = new Date(now()).toISOString();
    return normalizeUsage({
      accountId: account.id,
      windows: [{ kind: "monthly" }],
      collectedAt: at,
      source: "local-session",
      certainty: "unknown",
      expiresAt: at,
    });
  }

  return {
    kind: "local-session",
    async detectAccounts() {
      return [];
    },
    async collectUsage(account) {
      let cache;
      try {
        cache = CacheSchema.safeParse(JSON.parse(await readFile(cachePath, "utf8")));
      } catch {
        return unknown(account);
      }
      if (!cache.success) {
        return unknown(account);
      }
      const collectedAtMs = cache.data.at * 1000;
      if (now() - collectedAtMs > CURSOR_QUOTA_MAX_AGE_MS) {
        return unknown(account);
      }
      return normalizeUsage({
        accountId: account.id,
        windows: [poolWindow("spend", cache.data.pct), poolWindow("auto", cache.data.auto_left)],
        collectedAt: new Date(collectedAtMs).toISOString(),
        source: "local-session",
        certainty: "estimated",
        expiresAt: new Date(now() + 60_000).toISOString(),
      });
    },
    async listAvailableModels() {
      return [];
    },
  };
}
