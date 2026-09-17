import type { Account } from "../../domain/account.js";
import { runCommand } from "../command-runner.js";
import type { UsageCollector } from "../types.js";
import { parseClaudeUsage } from "./claude-parser.js";
import {
  collectVerifiedStatus,
  COLLECTOR_MAX_BYTES,
  COLLECTOR_TIMEOUT_MS,
} from "../verified-command.js";

export function createClaudeCollector(run: typeof runCommand = runCommand): UsageCollector {
  return {
    kind: "official-cli",
    async detectAccounts() {
      const which = await run({
        command: "which",
        args: ["claude"],
        timeoutMs: 2000,
        maxBytes: 256,
      });
      return [{ provider: "anthropic", agent: "claude-code", credentialPresent: which.ok }];
    },
    async collectUsage(account: Account) {
      return collectVerifiedStatus({
        run,
        command: "claude",
        args: ["auth", "status", "--json"],
        account,
        parse: parseClaudeUsage,
      });
    },
    async listAvailableModels(account: Account) {
      const result = await run({
        command: "claude",
        args: ["auth", "status", "--json"],
        timeoutMs: COLLECTOR_TIMEOUT_MS,
        maxBytes: COLLECTOR_MAX_BYTES,
      });
      return parseClaudeUsage(result.stdout).models.filter((model) =>
        account.enabledModels.includes(model.modelId),
      );
    },
  };
}

export const claudeCollector: UsageCollector = createClaudeCollector();
