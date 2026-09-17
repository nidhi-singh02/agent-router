import { z } from "zod";
import { AgentIdSchema, ModelIdSchema, ProviderIdSchema } from "./ids.js";
import { RatioSchema } from "./account.js";

export const ReasoningEffortSchema = z.enum(["none", "low", "medium", "high", "ultra"]);

export const ModelCapabilitiesSchema = z.object({
  planning: RatioSchema,
  coding: RatioSchema,
  debugging: RatioSchema,
  creativity: RatioSchema,
  research: RatioSchema,
});

export const ModelProfileSchema = z.object({
  id: ModelIdSchema,
  provider: ProviderIdSchema,
  agent: AgentIdSchema,
  launchName: z.string().min(1),
  supportedEfforts: z.array(ReasoningEffortSchema).min(1),
  capabilities: ModelCapabilitiesSchema,
  relativeQuotaCost: z.number().positive(),
  relativeLatency: z.number().positive(),
  // The provider quota pool this model draws from; matches UsageWindow.pool.
  quotaPool: z.string().min(1).optional(),
});

export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
