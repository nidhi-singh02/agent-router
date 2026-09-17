export function formatStatus(input: {
  accounts: Array<{ id: string; ownership: string; label: string }>;
  activity?: string;
  quota?: Record<string, string>;
}): string {
  const lines = input.accounts.map((account) => {
    const quota = input.quota?.[account.id];
    return `${account.id} (${account.ownership})${quota ? `  quota: ${quota}` : ""}`;
  });
  if (input.activity) {
    lines.push(`Shared activity: ${input.activity}`);
  }
  return lines.join("\n");
}
