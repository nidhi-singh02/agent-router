import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectorsForAccount } from "../../src/collectors/registry.js";
import { createBrowserDashboardCollector } from "../../src/collectors/browser/dashboard-collector.js";
import { personal } from "../cli/fixtures.js";

const html = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/dashboards/cursor.html"),
  "utf8",
);

describe("collector registry", () => {
  it("treats browser fallback as unavailable without an approved authenticated-browser bridge", async () => {
    const account = { ...personal, collectorPreference: ["browser-dashboard"] as const };
    const [browser] = collectorsForAccount(account);
    await expect(browser!.collectUsage(account)).rejects.toThrow(
      /approved authenticated-browser bridge/i,
    );
  });

  it("parses dashboard HTML only through an explicit approved browser bridge", async () => {
    const collector = createBrowserDashboardCollector({
      approvedBridge: true,
      fetchHtml: async () => html,
    });
    const snapshot = await collector.collectUsage(personal);
    expect(snapshot.source).toBe("browser-dashboard");
    expect(snapshot.certainty).toBe("estimated");
    expect(snapshot.windows[0]?.remainingRatio).toBeCloseTo(0.62);
  });
});
