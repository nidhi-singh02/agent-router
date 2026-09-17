import type { Account } from "../domain/account.js";
import { normalizeUsage } from "./normalizer.js";
import type { runCommand } from "./command-runner.js";
import type { UsageSnapshot } from "../domain/usage.js";

export const COLLECTOR_TIMEOUT_MS = 5_000;
export const COLLECTOR_MAX_BYTES = 16_384;

export async function collectVerifiedStatus(input: {
  run: typeof runCommand;
  command: string;
  args: readonly string[];
  account: Account;
  parse: (raw: string) => { snapshot: UsageSnapshot };
}): Promise<UsageSnapshot> {
  const result = await input.run({
    command: input.command,
    args: [...input.args],
    timeoutMs: COLLECTOR_TIMEOUT_MS,
    maxBytes: COLLECTOR_MAX_BYTES,
  });
  const raw = result.ok ? result.stdout : result.stderr;
  const parsed = input.parse(raw.length > 0 ? raw : "{}");
  const collectedAt = new Date().toISOString();
  return normalizeUsage({
    ...parsed.snapshot,
    accountId: input.account.id,
    collectedAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}
