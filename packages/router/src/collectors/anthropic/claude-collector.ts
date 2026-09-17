import type { Account } from "../../domain/account.js";
import { runCommand } from "../command-runner.js";
import type { UsageCollector } from "../types.js";
import { parseClaudeUsage } from "./claude-parser.js";

export const claudeCollector: UsageCollector = {
  kind: "official-cli",
  async detectAccounts() {
    const which = await runCommand({
      command: "which",
      args: ["claude"],
      timeoutMs: 2000,
      maxBytes: 256,
    });
    return [{ provider: "anthropic", agent: "claude-code", credentialPresent: which.ok }];
  },
  async collectUsage(account: Account) {
    const parsed = parseClaudeUsage("{}");
    return { ...parsed.snapshot, accountId: account.id };
  },
  async listAvailableModels(account: Account) {
    return parseClaudeUsage("{}").models.filter((model) =>
      account.enabledModels.includes(model.modelId),
    );
  },
};
