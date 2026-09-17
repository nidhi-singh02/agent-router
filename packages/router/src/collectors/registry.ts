import type { Account } from "../domain/account.js";
import { cursorCollector } from "./cursor/cursor-collector.js";
import { claudeCollector } from "./anthropic/claude-collector.js";
import { codexCollector } from "./openai/codex-collector.js";
import { opencodeCollector } from "./opencode/opencode-collector.js";
import type { UsageCollector } from "./types.js";

const skippedBrowserCollector: UsageCollector = {
  kind: "browser-dashboard",
  async detectAccounts() {
    return [];
  },
  async collectUsage(account) {
    const now = new Date().toISOString();
    return {
      accountId: account.id,
      windows: [{ kind: "five-hour" }],
      collectedAt: now,
      source: "browser-dashboard",
      certainty: "unknown",
      expiresAt: now,
      activeReservationRatio: 0,
    };
  },
  async listAvailableModels() {
    return [];
  },
};

function officialCollector(account: Account): UsageCollector {
  if (account.agent === "claude-code") {
    return claudeCollector;
  }
  if (account.agent === "codex") {
    return codexCollector;
  }
  if (account.agent === "opencode") {
    return opencodeCollector;
  }
  return cursorCollector;
}

export function collectorsForAccount(account: Account): UsageCollector[] {
  return account.collectorPreference.map((kind) => {
    if (kind === "official-cli" || kind === "official-api") {
      return officialCollector(account);
    }
    if (kind === "local-session") {
      return opencodeCollector;
    }
    return skippedBrowserCollector;
  });
}
