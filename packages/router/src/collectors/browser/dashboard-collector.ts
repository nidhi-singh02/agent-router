import { redactCollectorText, normalizeUsage } from "../normalizer.js";
import { DASHBOARD_REGISTRY } from "./dashboard-registry.js";
import { attachBrowserSession } from "./browser-session.js";
import type { Account } from "../../domain/account.js";
import type { UsageCollector } from "../types.js";

export class BrowserDashboardUnavailableError extends Error {
  constructor() {
    super("browser-dashboard unavailable: no approved authenticated-browser bridge");
  }
}

function dashboardProvider(provider: Account["provider"]): keyof typeof DASHBOARD_REGISTRY {
  if (provider === "anthropic") {
    return "anthropic";
  }
  if (provider === "openai") {
    return "openai";
  }
  return "cursor";
}

export function createBrowserDashboardCollector(options: {
  approvedBridge: boolean;
  fetchHtml?: (provider: Account["provider"]) => Promise<string>;
}): UsageCollector {
  return {
    kind: "browser-dashboard",
    async detectAccounts() {
      return [];
    },
    async collectUsage(account) {
      const session = attachBrowserSession(options.approvedBridge);
      if (!session.available || !options.fetchHtml) {
        throw new BrowserDashboardUnavailableError();
      }
      const parsed = DASHBOARD_REGISTRY[dashboardProvider(account.provider)].parser(
        await options.fetchHtml(account.provider),
      );
      const collectedAt = new Date().toISOString();
      return normalizeUsage({
        ...parsed.snapshot,
        accountId: account.id,
        collectedAt,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    },
    async listAvailableModels() {
      return [];
    },
  };
}

export function dryRunBrowserUsage(input: {
  html: string;
  provider: keyof typeof DASHBOARD_REGISTRY;
}) {
  const parsed = DASHBOARD_REGISTRY[input.provider].parser(input.html);
  const remaining = parsed.snapshot.windows
    .map((window) =>
      window.remainingRatio === undefined
        ? `${window.kind}=unknown`
        : `${window.kind} remaining ${Math.round(window.remainingRatio * 100)}%`,
    )
    .join(", ");
  return {
    persisted: false,
    printed: redactCollectorText(
      `browser ${input.provider} ${remaining}; certainty=${parsed.snapshot.certainty}; fragile=${parsed.fragile}`,
    ),
    snapshot: parsed.snapshot,
  };
}
