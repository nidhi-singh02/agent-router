export function formatAccounts(
  accounts: Array<{ id: string; ownership: string; enabled: boolean }>,
): string {
  return accounts
    .map((account) => `${account.id}\townership=${account.ownership}\tenabled=${account.enabled}`)
    .join("\n");
}
