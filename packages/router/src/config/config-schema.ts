import { z } from "zod";
import { AccountSchema, CollectorKindSchema, RatioSchema } from "../domain/account.js";
import { AgentIdSchema, ModelIdSchema, ProviderIdSchema } from "../domain/ids.js";
import { ModelProfileSchema } from "../domain/model-profile.js";

export const CredentialRefSchema = z
  .string()
  .regex(
    /^(env|keychain):[A-Za-z0-9._-]+$/,
    "credential references must be env:NAME or keychain:NAME",
  );

const ConfigAccountInputSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    provider: ProviderIdSchema,
    agent: AgentIdSchema,
    ownership: z.enum(["personal", "shared"]),
    reserveFloor: RatioSchema.optional(),
    collectorPreference: z.array(CollectorKindSchema).min(1),
    enabledModels: z.array(ModelIdSchema).min(1),
    enabled: z.boolean(),
    credentialRef: CredentialRefSchema.optional(),
  })
  .superRefine((account, ctx) => {
    const floor = account.reserveFloor ?? (account.ownership === "shared" ? 0.4 : 0);
    if (account.ownership === "shared" && floor < 0.4) {
      ctx.addIssue({
        code: "custom",
        message: "shared reserve floor must be at least 0.40",
        path: ["reserveFloor"],
      });
    }
  });

export function isSecureCoordinatorUrl(value: string): boolean {
  const url = new URL(value);
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  );
}

export const CoordinatorConfigSchema = z.object({
  url: z
    .string()
    .url()
    .refine(isSecureCoordinatorUrl, "coordinator URL must use HTTPS or HTTP loopback"),
  readerCredentialRef: CredentialRefSchema,
  writerCredentialRef: CredentialRefSchema.optional(),
});

export const ConfigFileSchema = z.object({
  accounts: z.array(ConfigAccountInputSchema).default([]),
  coordinator: CoordinatorConfigSchema.optional(),
  typesafe: z
    .object({
      apiKeyRef: CredentialRefSchema,
    })
    .optional(),
  enrichment: z.object({ enabled: z.boolean().default(true) }).optional(),
});

export const ModelCatalogSchema = z.object({
  updatedAt: z.iso.datetime(),
  provenance: z.string().min(1),
  models: z.array(ModelProfileSchema).min(1),
});

export type ConfigFile = z.infer<typeof ConfigFileSchema>;
export type CoordinatorConfig = z.infer<typeof CoordinatorConfigSchema>;
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;
export type ConfiguredAccount = z.infer<typeof AccountSchema> & {
  credentialRef?: string;
};
