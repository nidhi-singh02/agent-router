import type { Account } from "../domain/account.js";
import type { UsageSnapshot } from "../domain/usage.js";

export async function usageRefresh(input: {
  source: "local-session" | "official-cli" | "browser";
  dryRun: boolean;
  accounts: Account[];
  collect: (account: Account) => Promise<UsageSnapshot>;
  persist?: (snapshot: UsageSnapshot) => void;
}): Promise<string> {
  const lines: string[] = [];
  for (const account of input.accounts) {
    const snapshot = await input.collect(account);
    if (!input.dryRun) {
      input.persist?.(snapshot);
    }
    const remaining = snapshot.windows.find(
      (window) => window.remainingRatio !== undefined,
    )?.remainingRatio;
    lines.push(
      `${account.id} source=${snapshot.source} certainty=${snapshot.certainty} remaining=${remaining ?? "unknown"}`,
    );
  }
  return lines.join("\n");
}
