import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Account } from "../../domain/account.js";
import type { UsageSnapshot, UsageWindow } from "../../domain/usage.js";
import { normalizeUsage } from "../normalizer.js";
import type { UsageCollector } from "../types.js";

// Written by a user's Claude Code status line script from its rate_limits payload.
export const CLAUDE_QUOTA_MAX_AGE_MS = 15 * 60_000;

const LimitSchema = z.object({
  used_percentage: z.number(),
  resets_at: z.number().positive().optional(),
});

const CacheSchema = z.object({
  at: z.number().positive(),
  five_hour: LimitSchema.optional(),
  seven_day: LimitSchema.optional(),
});

export function defaultClaudeQuotaCachePath(home = os.homedir()): string {
  return path.join(home, ".claude", "statusline-quota-cache.json");
}

function limitWindow(
  kind: UsageWindow["kind"],
  limit: z.infer<typeof LimitSchema>,
  nowMs: number,
): UsageWindow {
  const resetsAtMs = limit.resets_at === undefined ? undefined : limit.resets_at * 1000;
  // A window whose reset time has passed since the cache was written is fully available again.
  const used = resetsAtMs !== undefined && resetsAtMs <= nowMs ? 0 : limit.used_percentage;
  const usedPercent = Math.max(0, Math.min(100, used));
  return {
    kind,
    remainingRatio: (100 - usedPercent) / 100,
    usedRatio: usedPercent / 100,
    ...(resetsAtMs === undefined ? {} : { resetsAt: new Date(resetsAtMs).toISOString() }),
  };
}

export function createClaudeStatuslineCollector(
  options: { cachePath?: string; now?: () => number } = {},
): UsageCollector {
  const cachePath = options.cachePath ?? defaultClaudeQuotaCachePath();
  const now = options.now ?? Date.now;

  function unknown(account: Account): UsageSnapshot {
    const at = new Date(now()).toISOString();
    return normalizeUsage({
      accountId: account.id,
      windows: [{ kind: "five-hour" }],
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
      const nowMs = now();
      const collectedAtMs = cache.data.at * 1000;
      if (nowMs - collectedAtMs > CLAUDE_QUOTA_MAX_AGE_MS) {
        return unknown(account);
      }
      const windows: UsageWindow[] = [];
      if (cache.data.five_hour) {
        windows.push(limitWindow("five-hour", cache.data.five_hour, nowMs));
      }
      if (cache.data.seven_day) {
        windows.push(limitWindow("weekly", cache.data.seven_day, nowMs));
      }
      if (windows.length === 0) {
        return unknown(account);
      }
      return normalizeUsage({
        accountId: account.id,
        windows,
        collectedAt: new Date(collectedAtMs).toISOString(),
        source: "local-session",
        certainty: "estimated",
        expiresAt: new Date(nowMs + 60_000).toISOString(),
      });
    },
    async listAvailableModels() {
      return [];
    },
  };
}
