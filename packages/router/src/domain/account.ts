import { z } from "zod";
import { AccountIdSchema, AgentIdSchema, ModelIdSchema, ProviderIdSchema } from "./ids.js";

export const OwnershipSchema = z.enum(["personal", "shared"]);
export const CollectorKindSchema = z.enum([
  "official-api",
  "official-cli",
  "local-session",
  "browser-dashboard",
]);
export const RatioSchema = z.number().min(0).max(1);

const AccountInputSchema = z.object({
  id: AccountIdSchema,
  label: z.string().min(1),
  provider: ProviderIdSchema,
  agent: AgentIdSchema,
  ownership: OwnershipSchema,
  reserveFloor: RatioSchema.optional(),
  collectorPreference: z.array(CollectorKindSchema).min(1),
  enabledModels: z.array(ModelIdSchema).min(1),
  enabled: z.boolean(),
});

export const AccountSchema = AccountInputSchema.transform((account) => ({
  ...account,
  reserveFloor: account.reserveFloor ?? (account.ownership === "shared" ? 0.4 : 0),
}));

export type Ownership = z.infer<typeof OwnershipSchema>;
export type CollectorKind = z.infer<typeof CollectorKindSchema>;
export type Account = z.infer<typeof AccountSchema>;
