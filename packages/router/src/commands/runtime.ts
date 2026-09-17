import { loadModelCatalog } from "../catalog/model-catalog.js";
import { loadConfig } from "../config/config-loader.js";
import type { RunDeps } from "./run.js";
import type { UsageSnapshot } from "../domain/usage.js";
import type { TypeSafePort } from "../semantic/typesafe-client.js";

function unavailableTypeSafe(): TypeSafePort {
  return {
    calls: [],
    async systemOne() {
      throw new Error("TypeSafe is not configured; live API calls are disabled until approved");
    },
  };
}

export function createDefaultRunDeps(env: NodeJS.Dict<string>): RunDeps {
  const config = loadConfig({ env });
  const catalog = loadModelCatalog();
  const collectedAt = new Date().toISOString();
  const usage: Record<string, UsageSnapshot> = {};
  for (const account of config.accounts) {
    usage[account.id] = {
      accountId: account.id,
      windows: [{ kind: "five-hour" }],
      collectedAt,
      source: "official-cli",
      certainty: "unknown",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      activeReservationRatio: 0,
    };
  }
  return {
    accounts: config.accounts,
    models: catalog.models.filter((model) =>
      config.accounts.some((account) => account.enabledModels.includes(model.id)),
    ),
    usage,
    client: unavailableTypeSafe(),
    env,
  };
}
