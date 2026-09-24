import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { usageRefresh } from "../../src/commands/usage.js";
import { createDefaultRunDeps } from "../../src/commands/runtime.js";
import type { UsageCollector } from "../../src/collectors/types.js";
import { openDatabase } from "../../src/store/database.js";
import { UsageRepository } from "../../src/store/usage-repository.js";
import { personal, usageFor } from "../cli/fixtures.js";

function homeWithAccount(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "router-usage-"));
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      accounts: [
        {
          id: personal.id,
          label: personal.label,
          provider: personal.provider,
          agent: personal.agent,
          ownership: personal.ownership,
          collectorPreference: ["local-session"],
          enabledModels: personal.enabledModels,
          enabled: true,
          credentialRef: "env:CURSOR_API_KEY",
        },
      ],
    }),
  );
  return home;
}

describe("usageRefresh", () => {
  it("prints local-session facts on dry-run and does not persist", async () => {
    const persist = vi.fn();
    const snapshot = usageFor(personal.id, 0.8, {
      source: "local-session",
      certainty: "estimated",
    });
    const printed = await usageRefresh({
      source: "local-session",
      dryRun: true,
      accounts: [personal],
      collect: async () => snapshot,
      persist,
    });
    expect(printed).toContain(personal.id);
    expect(printed).toContain("estimated");
    expect(persist).not.toHaveBeenCalled();
  });

  it("reports the most restrictive window, matching routing", async () => {
    const snapshot = usageFor(personal.id, 0.9, {
      windows: [
        { kind: "five-hour", remainingRatio: 0.9, usedRatio: 0.1 },
        { kind: "weekly", remainingRatio: 0.1, usedRatio: 0.9 },
      ],
    });
    const printed = await usageRefresh({
      source: "official-cli",
      dryRun: true,
      accounts: [personal],
      collect: async () => snapshot,
    });
    expect(printed).toContain("remaining=0.1");
  });

  it("persists snapshots when not dry-run", async () => {
    const persist = vi.fn();
    const snapshot = usageFor(personal.id, 0.8, {
      source: "local-session",
      certainty: "estimated",
    });
    await usageRefresh({
      source: "local-session",
      dryRun: false,
      accounts: [personal],
      collect: async () => snapshot,
      persist,
    });
    expect(persist).toHaveBeenCalledWith(snapshot);
  });
});

describe("createDefaultRunDeps usage persist", () => {
  it("saves non-unknown snapshots so UsageRepository.latest can read them", async () => {
    const snapshot = usageFor(personal.id, 0.61, {
      source: "local-session",
      certainty: "estimated",
    });
    const collectors: UsageCollector[] = [
      {
        kind: "local-session",
        detectAccounts: async () => [],
        collectUsage: async () => snapshot,
        listAvailableModels: async () => [],
      },
    ];
    const home = homeWithAccount();
    await createDefaultRunDeps(
      { MODEL_ROUTER_HOME: home },
      { collectorsForAccount: () => collectors, usageMode: "local" },
    );
    const db = openDatabase({ home });
    try {
      expect(new UsageRepository(db).latest(personal.id)?.windows[0]?.remainingRatio).toBe(0.61);
    } finally {
      db.close();
    }
  });
});
