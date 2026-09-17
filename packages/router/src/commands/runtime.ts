import { loadModelCatalog } from "../catalog/model-catalog.js";
import { loadConfig } from "../config/config-loader.js";
import type { RunDeps } from "./run.js";
import type { Account } from "../domain/account.js";
import { collectUsageChain } from "../collectors/collector-chain.js";
import { collectorsForAccount as defaultCollectorsForAccount } from "../collectors/registry.js";
import type { UsageCollector } from "../collectors/types.js";
import { createLiveTypeSafeClient, type TypeSafePort } from "../semantic/typesafe-client.js";
import {
  createHerdrClient,
  createProcessCommandAdapter,
  type HerdrClient,
  type RunCommand,
} from "../launch/herdr-client.js";
import { isHerdrEnv } from "../launch/readiness.js";
import { createCoordinatorClient, type CoordinatorClient } from "../activity/coordinator-client.js";
import { accountFingerprint } from "@model-router/hermes-heartbeat";
import { createBrowserDashboardCollector } from "../collectors/browser/dashboard-collector.js";
import { runCommand } from "../collectors/command-runner.js";
import { openDatabase } from "../store/database.js";
import { SessionRepository } from "../store/session-repository.js";

function unavailableTypeSafe(): TypeSafePort {
  return {
    calls: [],
    async systemOne() {
      throw new Error("TypeSafe is not configured; live API calls are disabled until approved");
    },
  };
}

const SECRET_ENV = /API_KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTHORIZATION/i;

export function sanitizeRuntimeEnv(env: NodeJS.Dict<string>): NodeJS.Dict<string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => Boolean(value) && !SECRET_ENV.test(key)),
  );
}

export function resolveEnvCredential(
  ref: string | undefined,
  env: NodeJS.Dict<string>,
): string | undefined {
  if (!ref) {
    return undefined;
  }
  const match = /^env:([A-Z0-9_]+)$/.exec(ref);
  if (!match) {
    return undefined;
  }
  const value = env[match[1]!];
  return value && value.length > 0 ? value : undefined;
}

export interface RuntimeOverrides {
  createTypeSafeClient?: (apiKey: string) => TypeSafePort;
  createProcessAdapter?: () => RunCommand;
  createHerdr?: (runCommand: RunCommand) => HerdrClient;
  collectorsForAccount?: (account: Account) => UsageCollector[];
  activityClient?: CoordinatorClient;
  fetchImpl?: typeof fetch;
  runCommand?: typeof runCommand;
  fetchDashboardHtml?: (provider: Account["provider"]) => Promise<string>;
  sessions?: RunDeps["sessions"];
}

function defaultActivityClient(
  env: NodeJS.Dict<string>,
  fetchImpl?: typeof fetch,
): CoordinatorClient {
  const config = loadConfig({ env });
  const token = resolveEnvCredential(config.coordinator?.readerCredentialRef, env);
  const fingerprintSecret = env.HEARTBEAT_FINGERPRINT_SECRET;
  if (!config.coordinator?.url || !token || !fingerprintSecret) {
    return {
      async status() {
        return "unreachable";
      },
    };
  }
  const inner = createCoordinatorClient({
    baseUrl: config.coordinator.url,
    readerToken: token,
    fetchImpl,
  });
  return {
    async status(accountId: string) {
      return inner.status(accountFingerprint(accountId, fingerprintSecret));
    },
  };
}

export async function createDefaultRunDeps(
  env: NodeJS.Dict<string>,
  overrides: RuntimeOverrides = {},
): Promise<RunDeps> {
  const config = loadConfig({ env });
  const catalog = loadModelCatalog();
  const resolveCollectors =
    overrides.collectorsForAccount ??
    ((account: Account) =>
      defaultCollectorsForAccount(account, {
        runCommand: overrides.runCommand,
        browserCollector: createBrowserDashboardCollector({
          approvedBridge: env.MODEL_ROUTER_BROWSER_BRIDGE === "1",
          fetchHtml: overrides.fetchDashboardHtml,
        }),
      }));
  const usage: RunDeps["usage"] = {};
  for (const account of config.accounts) {
    usage[account.id] = await collectUsageChain(account, resolveCollectors(account));
  }
  const apiKey = env.TYPESAFE_API_KEY;
  const createTypeSafe = overrides.createTypeSafeClient ?? createLiveTypeSafeClient;
  const client = apiKey && apiKey.length > 0 ? createTypeSafe(apiKey) : unavailableTypeSafe();
  let herdr: HerdrClient | undefined;
  if (isHerdrEnv(env)) {
    const adapter = (overrides.createProcessAdapter ?? createProcessCommandAdapter)();
    herdr = (overrides.createHerdr ?? createHerdrClient)(adapter);
  }
  return {
    sessions: overrides.sessions ?? new SessionRepository(openDatabase({ home: config.home })),
    accounts: config.accounts,
    models: catalog.models.filter((model) =>
      config.accounts.some((account) => account.enabledModels.includes(model.id)),
    ),
    usage,
    client,
    env: sanitizeRuntimeEnv(env),
    herdr,
    activityClient: overrides.activityClient ?? defaultActivityClient(env, overrides.fetchImpl),
  };
}
