import { execFileSync } from "node:child_process";
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
import { UsageRepository } from "../store/usage-repository.js";

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

export type KeychainReader = (service: string) => string | undefined;

/** Reads a generic password from the macOS login Keychain by service name. */
export function readMacKeychain(service: string): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  try {
    const value = execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Resolves `env:NAME` from the environment or `keychain:NAME` from the Keychain. */
export function resolveCredential(
  ref: string | undefined,
  env: NodeJS.Dict<string>,
  readKeychain: KeychainReader = readMacKeychain,
): string | undefined {
  const keychain = ref ? /^keychain:([A-Za-z0-9._-]+)$/.exec(ref) : null;
  return keychain ? readKeychain(keychain[1]!) : resolveEnvCredential(ref, env);
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
  readKeychain?: KeychainReader;
  /** Default `"local"`: only `local-session` collectors. `"full"`: official, local, and browser. */
  usageMode?: "local" | "full";
}

function filterCollectors(
  collectors: UsageCollector[],
  usageMode: "local" | "full",
): UsageCollector[] {
  if (usageMode === "full") {
    return collectors;
  }
  return collectors.filter((collector) => collector.kind === "local-session");
}

function defaultActivityClient(
  env: NodeJS.Dict<string>,
  fetchImpl?: typeof fetch,
): CoordinatorClient {
  const config = loadConfig({ env });
  const token = resolveCredential(config.coordinator?.readerCredentialRef, env);
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
  const usageMode = overrides.usageMode ?? "local";
  const snapshots = await Promise.all(
    config.accounts.map((account) =>
      collectUsageChain(account, filterCollectors(resolveCollectors(account), usageMode)),
    ),
  );
  const usage: RunDeps["usage"] = Object.fromEntries(
    config.accounts.map((account, index) => [account.id, snapshots[index]!]),
  );
  const db = openDatabase({ home: config.home });
  const usageRepo = new UsageRepository(db);
  for (const snapshot of snapshots) {
    if (snapshot.certainty !== "unknown") {
      usageRepo.save(snapshot);
    }
  }
  // The configured reference (for example keychain:model-router-typesafe) works in every
  // pane without exporting the key; TYPESAFE_API_KEY remains a fallback.
  const apiKeyRef = config.typesafe?.apiKeyRef;
  const apiKey =
    resolveCredential(apiKeyRef, env, overrides.readKeychain) ??
    resolveEnvCredential("env:TYPESAFE_API_KEY", env);
  const createTypeSafe = overrides.createTypeSafeClient ?? createLiveTypeSafeClient;
  const client = apiKey ? createTypeSafe(apiKey) : unavailableTypeSafe();
  const checked = [
    ...(apiKeyRef && apiKeyRef !== "env:TYPESAFE_API_KEY" ? [apiKeyRef] : []),
    "TYPESAFE_API_KEY",
  ];
  const typesafeKeyHint = apiKey
    ? undefined
    : `No TypeSafe API key found (checked ${checked.join(" and ")}). Store it once with: ` +
      'security add-generic-password -a "$USER" -s model-router-typesafe -w';
  let herdr: HerdrClient | undefined;
  if (isHerdrEnv(env)) {
    const adapter = (overrides.createProcessAdapter ?? createProcessCommandAdapter)();
    herdr = (overrides.createHerdr ?? createHerdrClient)(adapter);
  }
  return {
    typesafeKeyHint,
    sessions: overrides.sessions ?? new SessionRepository(db),
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
