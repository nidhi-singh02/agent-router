import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDefaultRunDeps } from "../../src/commands/runtime.js";
import type { UsageCollector } from "../../src/collectors/types.js";
import type { TypeSafePort } from "../../src/semantic/typesafe-client.js";
import type { HerdrClient } from "../../src/launch/herdr-client.js";
import { accountFingerprint } from "@agent-router/hermes-heartbeat";
import { personal, usageFor } from "../cli/fixtures.js";

const idleCollectors: UsageCollector[] = [
  {
    kind: "official-cli",
    detectAccounts: async () => [],
    collectUsage: async (account) => usageFor(account.id, 0.8),
    listAvailableModels: async () => [],
  },
];

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
      { createTypeSafeClient, collectorsForAccount: () => idleCollectors },
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
      { createTypeSafeClient, collectorsForAccount: () => idleCollectors },
    );
    expect(createTypeSafeClient).toHaveBeenCalledTimes(1);
    expect(createTypeSafeClient).toHaveBeenCalledWith(dummyKey);
    expect(deps.client).toBe(live);
    const serialized = JSON.stringify(deps);
    expect(serialized).not.toContain(dummyKey);
    expect(serialized).not.toContain("sk-secret-123");
    expect(deps.env.TYPESAFE_API_KEY).toBeUndefined();
  });

  it("reads the TypeSafe key from a keychain reference without an env var", async () => {
    const home = homeWithAccount();
    const configPath = path.join(home, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(
      configPath,
      JSON.stringify({ ...config, typesafe: { apiKeyRef: "keychain:model-router-typesafe" } }),
    );
    const dummyKey = "ts_keychain_dummy_not_live";
    const readKeychain = vi.fn((name: string) =>
      name === "model-router-typesafe" ? dummyKey : undefined,
    );
    const createTypeSafeClient = vi.fn(stubTypeSafe);
    const deps = await createDefaultRunDeps(
      { MODEL_ROUTER_HOME: home },
      { createTypeSafeClient, readKeychain, collectorsForAccount: () => idleCollectors },
    );
    expect(readKeychain).toHaveBeenCalledWith("model-router-typesafe");
    expect(createTypeSafeClient).toHaveBeenCalledWith(dummyKey);
    expect(JSON.stringify(deps)).not.toContain(dummyKey);
    expect(deps.typesafeKeyHint).toBeUndefined();
  });

  it("falls back to TYPESAFE_API_KEY when the configured reference has no value", async () => {
    const home = homeWithAccount();
    const configPath = path.join(home, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(
      configPath,
      JSON.stringify({ ...config, typesafe: { apiKeyRef: "keychain:model-router-typesafe" } }),
    );
    const createTypeSafeClient = vi.fn(stubTypeSafe);
    await createDefaultRunDeps(
      { MODEL_ROUTER_HOME: home, TYPESAFE_API_KEY: "ts_env_dummy" },
      {
        createTypeSafeClient,
        readKeychain: () => undefined,
        collectorsForAccount: () => idleCollectors,
      },
    );
    expect(createTypeSafeClient).toHaveBeenCalledWith("ts_env_dummy");
  });

  it("explains where the TypeSafe key was looked for when none is found", async () => {
    const home = homeWithAccount();
    const configPath = path.join(home, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(
      configPath,
      JSON.stringify({ ...config, typesafe: { apiKeyRef: "keychain:model-router-typesafe" } }),
    );
    const deps = await createDefaultRunDeps(
      { MODEL_ROUTER_HOME: home },
      { readKeychain: () => undefined, collectorsForAccount: () => idleCollectors },
    );
    expect(deps.typesafeKeyHint).toBe(
      'No TypeSafe API key found (checked keychain:model-router-typesafe and TYPESAFE_API_KEY). Store it once with: security add-generic-password -a "$USER" -s model-router-typesafe -w',
    );
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
      { createProcessAdapter, createHerdr, collectorsForAccount: () => idleCollectors },
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
      {
        MODEL_ROUTER_HOME: homeWithAccount(),
        HERDR_ENV: "1",
        TYPESAFE_API_KEY: "secret",
        UNRELATED_VALUE: "drop",
      },
      { createProcessAdapter, createHerdr, collectorsForAccount: () => idleCollectors },
    );
    expect(createProcessAdapter).toHaveBeenCalledTimes(1);
    expect(createProcessAdapter).toHaveBeenCalledWith({
      env: expect.objectContaining({ HERDR_ENV: "1" }),
    });
    const childEnv = createProcessAdapter.mock.calls[0]?.[0]?.env;
    expect(childEnv?.TYPESAFE_API_KEY).toBeUndefined();
    expect(childEnv?.UNRELATED_VALUE).toBeUndefined();
    expect(createHerdr).toHaveBeenCalledWith(adapter);
    expect(deps.herdr).toBe(herdr);
  });

  it("runs only local-session collectors in default local usage mode", async () => {
    const localCollect = vi.fn(async () => usageFor(personal.id, 0.55));
    const officialCollect = vi.fn(async () => usageFor(personal.id, 0.11));
    const collectors: UsageCollector[] = [
      {
        kind: "official-cli",
        detectAccounts: async () => [],
        collectUsage: officialCollect,
        listAvailableModels: async () => [],
      },
      {
        kind: "local-session",
        detectAccounts: async () => [],
        collectUsage: localCollect,
        listAvailableModels: async () => [],
      },
    ];
    const collectorsForAccount = vi.fn(() => collectors);
    const deps = await createDefaultRunDeps(
      { MODEL_ROUTER_HOME: homeWithAccount() },
      { collectorsForAccount, usageMode: "local" },
    );
    expect(collectorsForAccount).toHaveBeenCalled();
    expect(officialCollect).not.toHaveBeenCalled();
    expect(localCollect).toHaveBeenCalledTimes(1);
    expect(deps.usage[personal.id]?.windows[0]?.remainingRatio).toBe(0.55);
    expect(deps.usage[personal.id]?.source).not.toBe("skipped");
  });

  it("runs the full collector list when usageMode is full", async () => {
    const officialCollect = vi.fn(async () => usageFor(personal.id, 0.42));
    const collectors: UsageCollector[] = [
      {
        kind: "official-cli",
        detectAccounts: async () => [],
        collectUsage: officialCollect,
        listAvailableModels: async () => [],
      },
    ];
    await createDefaultRunDeps(
      { MODEL_ROUTER_HOME: homeWithAccount() },
      { collectorsForAccount: () => collectors, usageMode: "full" },
    );
    expect(officialCollect).toHaveBeenCalledTimes(1);
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
      { collectorsForAccount: () => collectors, usageMode: "full" },
    );
    expect(collectUsage).toHaveBeenCalledTimes(1);
    expect(deps.usage[personal.id]?.windows[0]?.remainingRatio).toBe(0.77);
    expect(deps.usage[personal.id]?.certainty).toBe("exact");
  });

  it("always attaches an activity client so shared activity can run before eligibility", async () => {
    const deps = await createDefaultRunDeps(
      { MODEL_ROUTER_HOME: homeWithAccount() },
      { collectorsForAccount: () => idleCollectors },
    );
    expect(deps.activityClient).toBeDefined();
    await expect(deps.activityClient!.status("acct_shared")).resolves.toBe("unreachable");
  });

  it("constrains shared accounts when no heartbeat coordinator is configured", async () => {
    const deps = await createDefaultRunDeps(
      { MODEL_ROUTER_HOME: homeWithAccount() },
      { collectorsForAccount: () => idleCollectors },
    );
    await expect(deps.activityClient!.status("acct_shared")).resolves.toBe("unreachable");
  });

  it("looks up coordinator status with an HMAC fingerprint and never a raw account id", async () => {
    const secret = "test-fingerprint-secret";
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
        coordinator: {
          url: "https://coordinator.example.invalid",
          readerCredentialRef: "env:COORDINATOR_READER_TOKEN",
        },
      }),
    );
    const urls: string[] = [];
    const deps = await createDefaultRunDeps(
      {
        MODEL_ROUTER_HOME: home,
        COORDINATOR_READER_TOKEN: "reader-token",
        HEARTBEAT_FINGERPRINT_SECRET: secret,
      },
      {
        collectorsForAccount: () => idleCollectors,
        fetchImpl: async (input) => {
          urls.push(String(input));
          return new Response(JSON.stringify({ activity: "inactive" }), { status: 200 });
        },
      },
    );
    await deps.activityClient!.status("acct_shared");
    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toContain("acct_shared");
    expect(urls[0]).toContain(accountFingerprint("acct_shared", secret));
  });
});
