import type { Account } from "../../domain/account.js";
import { runCommand } from "../command-runner.js";
import type { UsageCollector } from "../types.js";
import { parseCodexUsage } from "./codex-parser.js";
import {
  collectVerifiedStatus,
  COLLECTOR_MAX_BYTES,
  COLLECTOR_TIMEOUT_MS,
} from "../verified-command.js";

export function createCodexCollector(run: typeof runCommand = runCommand): UsageCollector {
  return {
    kind: "official-cli",
    async detectAccounts() {
      const which = await run({
        command: "which",
        args: ["codex"],
        timeoutMs: 2000,
        maxBytes: 256,
      });
      return [{ provider: "openai", agent: "codex", credentialPresent: which.ok }];
    },
    async collectUsage(account: Account) {
      return collectVerifiedStatus({
        run,
        command: "codex",
        args: ["login", "status"],
        account,
        parse: parseCodexUsage,
      });
    },
    async listAvailableModels(account: Account) {
      const result = await run({
        command: "codex",
        args: ["login", "status"],
        timeoutMs: COLLECTOR_TIMEOUT_MS,
        maxBytes: COLLECTOR_MAX_BYTES,
      });
      return parseCodexUsage(result.stdout).models.filter((model) =>
        account.enabledModels.includes(model.modelId),
      );
    },
  };
}

export const codexCollector: UsageCollector = createCodexCollector();
