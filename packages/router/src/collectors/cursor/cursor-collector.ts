import type { Account } from "../../domain/account.js";
import { runCommand } from "../command-runner.js";
import type { UsageCollector } from "../types.js";
import { parseCursorUsage } from "./cursor-parser.js";

export const cursorCollector: UsageCollector = {
  kind: "official-cli",
  async detectAccounts() {
    const which = await runCommand({
      command: "which",
      args: ["cursor"],
      timeoutMs: 2000,
      maxBytes: 256,
    });
    return [
      {
        provider: "cursor",
        agent: "cursor",
        credentialPresent: which.ok,
      },
    ];
  },
  async collectUsage(account: Account) {
    const parsed = parseCursorUsage("{}");
    return { ...parsed.snapshot, accountId: account.id };
  },
  async listAvailableModels(account: Account) {
    const parsed = parseCursorUsage("{}");
    return parsed.models.filter((model) => account.enabledModels.includes(model.modelId));
  },
};
