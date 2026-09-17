import type { Account } from "../../domain/account.js";
import { runCommand } from "../command-runner.js";
import type { UsageCollector } from "../types.js";
import { parseCodexUsage } from "./codex-parser.js";

export const codexCollector: UsageCollector = {
  kind: "official-cli",
  async detectAccounts() {
    const which = await runCommand({
      command: "which",
      args: ["codex"],
      timeoutMs: 2000,
      maxBytes: 256,
    });
    return [{ provider: "openai", agent: "codex", credentialPresent: which.ok }];
  },
  async collectUsage(account: Account) {
    const parsed = parseCodexUsage("{}");
    return { ...parsed.snapshot, accountId: account.id };
  },
  async listAvailableModels(account: Account) {
    return parseCodexUsage("{}").models.filter((model) =>
      account.enabledModels.includes(model.modelId),
    );
  },
};
