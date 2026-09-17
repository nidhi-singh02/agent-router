import type Database from "better-sqlite3";
import { AccountSchema } from "../domain/account.js";
import type { ConfiguredAccount } from "../config/config-schema.js";

export class AccountRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(account: ConfiguredAccount): void {
    this.db
      .prepare(
        `insert into accounts (
          id, label, provider, agent, ownership, reserve_floor,
          collector_preference, enabled_models, enabled, credential_ref
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          label=excluded.label,
          provider=excluded.provider,
          agent=excluded.agent,
          ownership=excluded.ownership,
          reserve_floor=excluded.reserve_floor,
          collector_preference=excluded.collector_preference,
          enabled_models=excluded.enabled_models,
          enabled=excluded.enabled,
          credential_ref=excluded.credential_ref`,
      )
      .run(
        account.id,
        account.label,
        account.provider,
        account.agent,
        account.ownership,
        account.reserveFloor,
        JSON.stringify(account.collectorPreference),
        JSON.stringify(account.enabledModels),
        account.enabled ? 1 : 0,
        account.credentialRef ?? null,
      );
  }

  get(id: string): ConfiguredAccount | undefined {
    const row = this.db
      .prepare(
        `select id, label, provider, agent, ownership, reserve_floor as reserveFloor,
                collector_preference as collectorPreference, enabled_models as enabledModels,
                enabled, credential_ref as credentialRef
         from accounts where id = ?`,
      )
      .get(id) as
      | {
          id: string;
          label: string;
          provider: string;
          agent: string;
          ownership: string;
          reserveFloor: number;
          collectorPreference: string;
          enabledModels: string;
          enabled: number;
          credentialRef: string | null;
        }
      | undefined;
    if (!row) {
      return undefined;
    }
    return {
      ...AccountSchema.parse({
        ...row,
        collectorPreference: JSON.parse(row.collectorPreference),
        enabledModels: JSON.parse(row.enabledModels),
        enabled: Boolean(row.enabled),
      }),
      credentialRef: row.credentialRef ?? undefined,
    };
  }
}
