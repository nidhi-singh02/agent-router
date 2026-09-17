import type { Account } from "../domain/account.js";
import { createCursorCollector } from "./cursor/cursor-collector.js";
import { createClaudeCollector } from "./anthropic/claude-collector.js";
import { createCodexCollector } from "./openai/codex-collector.js";
import { opencodeCollector } from "./opencode/opencode-collector.js";
import { createBrowserDashboardCollector } from "./browser/dashboard-collector.js";
import { runCommand } from "./command-runner.js";
import type { UsageCollector } from "./types.js";

export interface CollectorRegistryOptions {
  runCommand?: typeof runCommand;
  browserCollector?: UsageCollector;
}

function officialCollector(account: Account, run: typeof runCommand): UsageCollector {
  if (account.agent === "claude-code") {
    return createClaudeCollector(run);
  }
  if (account.agent === "codex") {
    return createCodexCollector(run);
  }
  if (account.agent === "opencode") {
    return opencodeCollector;
  }
  return createCursorCollector(run);
}

// The local-session collector reads OpenCode state, so it only applies to the OpenCode CLI
// or to OpenCode models used from another harness.
export function usesOpenCode(account: Account): boolean {
  return (
    account.agent === "opencode" ||
    account.provider === "opencode" ||
    account.enabledModels.some((modelId) => modelId.startsWith("opencode:"))
  );
}

export function collectorsForAccount(
  account: Account,
  options: CollectorRegistryOptions = {},
): UsageCollector[] {
  const run = options.runCommand ?? runCommand;
  const browser =
    options.browserCollector ?? createBrowserDashboardCollector({ approvedBridge: false });
  return account.collectorPreference.flatMap((kind) => {
    if (kind === "official-cli" || kind === "official-api") {
      return [officialCollector(account, run)];
    }
    if (kind === "local-session") {
      return usesOpenCode(account) ? [opencodeCollector] : [];
    }
    return [browser];
  });
}
