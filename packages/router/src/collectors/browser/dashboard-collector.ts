import { normalizeUsage } from "../normalizer.js";
import { redactCollectorText } from "../normalizer.js";
import { DASHBOARD_REGISTRY } from "./dashboard-registry.js";

export function dryRunBrowserUsage(input: { html: string; provider: keyof typeof DASHBOARD_REGISTRY }) {
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
