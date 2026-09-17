export function formatStatus(input: {
  accounts: Array<{ id: string; ownership: string; label: string }>;
  activity?: string;
}): string {
  const lines = input.accounts.map((account) => `${account.id} (${account.ownership})`);
  if (input.activity) {
    lines.push(`Shared activity: ${input.activity}`);
  }
  return lines.join("\n");
}
