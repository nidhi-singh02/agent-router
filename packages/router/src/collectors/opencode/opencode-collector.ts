import type { Account } from "../../domain/account.js";
import { runCommand } from "../command-runner.js";
import type { UsageCollector } from "../types.js";
import { parseOpenCodeStatus } from "./opencode-parser.js";

export const opencodeCollector: UsageCollector = {
  kind: "local-session",
  async detectAccounts() {
    const which = await runCommand({
      command: "which",
      args: ["opencode"],
      timeoutMs: 2000,
      maxBytes: 256,
    });
    return [{ provider: "openai", agent: "opencode", credentialPresent: which.ok }];
  },
  async collectUsage(account: Account) {
    try {
      parseOpenCodeStatus("{}");
    } catch {
      // OpenCode does not own quota; unknown usage is expected.
    }
    const now = new Date().toISOString();
    return {
      accountId: account.id,
      windows: [{ kind: "provider-defined" }],
      collectedAt: now,
      source: "local-session",
      certainty: "unknown",
      expiresAt: now,
      activeReservationRatio: 0,
    };
  },
  async listAvailableModels() {
    return [];
  },
};
