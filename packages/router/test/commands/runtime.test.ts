import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDefaultRunDeps } from "../../src/commands/runtime.js";
import type { UsageCollector } from "../../src/collectors/types.js";
import type { TypeSafePort } from "../../src/semantic/typesafe-client.js";
import type { HerdrClient } from "../../src/launch/herdr-client.js";
import { personal, usageFor } from "../cli/fixtures.js";

function homeWithAccount(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "router-runtime-"));
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
          collectorPreference: ["official-cli"],
          enabledModels: personal.enabledModels,
          enabled: true,
          credentialRef: "env:CURSOR_API_KEY",
        },
      ],
    }),
  );
  return home;
}

function stubTypeSafe(): TypeSafePort {
  return {
    calls: [],
    async systemOne() {
      throw new Error("stub typesafe must not be called");
    },
  };
}

function stubHerdr(): HerdrClient {
  return {
    splitCurrent: async () => ({ ok: true, code: 0, stdout: "pane_x\n", stderr: "" }),
    startAgent: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
    prompt: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
  };
}

describe("createDefaultRunDeps", () => {
  it("keeps TypeSafe unavailable when TYPESAFE_API_KEY is absent", async () => {
    const createTypeSafeClient = vi.fn(stubTypeSafe);
    const deps = await createDefaultRunDeps(
      { MODEL_ROUTER_HOME: homeWithAccount() },
      { createTypeSafeClient },
    );
    expect(createTypeSafeClient).not.toHaveBeenCalled();
    await expect(deps.client.systemOne({ questions: {}, state: {} } as never)).rejects.toThrow(
      /TypeSafe is not configured/,
    );
  });

  it("selects createLiveTypeSafeClient only when TYPESAFE_API_KEY is present and never stores the key on deps", async () => {
    const dummyKey = "ts_test_dummy_key_not_live";
    const live = stubTypeSafe();
    const createTypeSafeClient = vi.fn(() => live);
    const deps = await createDefaultRunDeps(
      {
        MODEL_ROUTER_HOME: homeWithAccount(),
        TYPESAFE_API_KEY: dummyKey,
        CURSOR_API_KEY: "sk-secret-123",
      },
      { createTypeSafeClient },
    );
    expect(createTypeSafeClient).toHaveBeenCalledTimes(1);
    expect(createTypeSafeClient).toHaveBeenCalledWith(dummyKey);
    expect(deps.client).toBe(live);
    const serialized = JSON.stringify(deps);
    expect(serialized).not.toContain(dummyKey);
    expect(serialized).not.toContain("sk-secret-123");
    expect(deps.env.TYPESAFE_API_KEY).toBeUndefined();
  });

  it("does not inject a Herdr process adapter unless HERDR_ENV=1", async () => {
    const createProcessAdapter = vi.fn(() => async () => ({
      ok: true,
      code: 0,
      stdout: "",
      stderr: "",
    }));
    const createHerdr = vi.fn(() => stubHerdr());
    const deps = await createDefaultRunDeps(
      { MODEL_ROUTER_HOME: homeWithAccount() },
      { createProcessAdapter, createHerdr },
    );
    expect(createProcessAdapter).not.toHaveBeenCalled();
    expect(createHerdr).not.toHaveBeenCalled();
    expect(deps.herdr).toBeUndefined();
  });

  it("injects createHerdrClient(createProcessCommandAdapter()) when HERDR_ENV=1", async () => {
    const adapter = async () => ({ ok: true, code: 0, stdout: "", stderr: "" });
    const herdr = stubHerdr();
    const createProcessAdapter = vi.fn(() => adapter);
    const createHerdr = vi.fn(() => herdr);
    const deps = await createDefaultRunDeps(
      { MODEL_ROUTER_HOME: homeWithAccount(), HERDR_ENV: "1" },
      { createProcessAdapter, createHerdr },
    );
    expect(createProcessAdapter).toHaveBeenCalledTimes(1);
    expect(createHerdr).toHaveBeenCalledWith(adapter);
    expect(deps.herdr).toBe(herdr);
  });

  it("runs configured collector chains instead of fabricating unknown snapshots", async () => {
    const snapshot = usageFor(personal.id, 0.77);
    const collectUsage = vi.fn(async () => snapshot);
    const collectors: UsageCollector[] = [
      {
        kind: "official-cli",
        detectAccounts: async () => [],
        collectUsage,
        listAvailableModels: async () => [],
      },
    ];
    const deps = await createDefaultRunDeps(
      { MODEL_ROUTER_HOME: homeWithAccount() },
      { collectorsForAccount: () => collectors },
    );
    expect(collectUsage).toHaveBeenCalledTimes(1);
    expect(deps.usage[personal.id]?.windows[0]?.remainingRatio).toBe(0.77);
    expect(deps.usage[personal.id]?.certainty).toBe("exact");
  });

  it("always attaches an activity client so shared activity can run before eligibility", async () => {
    const deps = await createDefaultRunDeps({ MODEL_ROUTER_HOME: homeWithAccount() });
    expect(deps.activityClient).toBeDefined();
    await expect(deps.activityClient!.status("acct_shared")).resolves.toBeDefined();
  });
});
