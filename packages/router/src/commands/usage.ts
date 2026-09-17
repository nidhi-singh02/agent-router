import { dryRunBrowserUsage } from "../collectors/browser/dashboard-collector.js";

export function usageRefresh(input: { source: string; dryRun: boolean; html?: string }): string {
  if (input.source === "browser" && input.dryRun) {
    return dryRunBrowserUsage({ html: input.html ?? "", provider: "cursor" }).printed;
  }
  return "usage refresh is a local collector pass; live provider quota calls are not made from this command yet";
}
