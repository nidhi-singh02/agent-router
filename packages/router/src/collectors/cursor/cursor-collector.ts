import type { Account } from "../../domain/account.js";
import { runCommand } from "../command-runner.js";
import type { UsageCollector } from "../types.js";
import { parseCursorUsage } from "./cursor-parser.js";
import {
  collectVerifiedStatus,
  COLLECTOR_MAX_BYTES,
  COLLECTOR_TIMEOUT_MS,
} from "../verified-command.js";

export function createCursorCollector(run: typeof runCommand = runCommand): UsageCollector {
  return {
    kind: "official-cli",
    async detectAccounts() {
      const which = await run({
        command: "which",
        args: ["agent"],
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
      return collectVerifiedStatus({
        run,
        command: "agent",
        args: ["status", "--format", "json"],
        account,
        parse: parseCursorUsage,
      });
    },
    async listAvailableModels(account: Account) {
      const result = await run({
        command: "agent",
        args: ["status", "--format", "json"],
        timeoutMs: COLLECTOR_TIMEOUT_MS,
        maxBytes: COLLECTOR_MAX_BYTES,
      });
      return parseCursorUsage(result.stdout).models.filter((model) =>
        account.enabledModels.includes(model.modelId),
      );
    },
  };
}

export const cursorCollector: UsageCollector = createCursorCollector();
