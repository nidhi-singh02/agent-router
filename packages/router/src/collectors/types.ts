import type { Account, CollectorKind } from "../domain/account.js";
import type { UsageSnapshot } from "../domain/usage.js";
import type { ModelId } from "../domain/ids.js";

export interface DetectedAccount {
  provider: string;
  agent: Account["agent"];
  labelHint?: string;
  credentialPresent: boolean;
}

export interface ModelAvailability {
  modelId: ModelId;
  launchName: string;
  available: boolean;
  source: CollectorKind;
}

export interface UsageCollector {
  kind: CollectorKind;
  detectAccounts(): Promise<DetectedAccount[]>;
  collectUsage(account: Account): Promise<UsageSnapshot>;
  listAvailableModels(account: Account): Promise<ModelAvailability[]>;
}
