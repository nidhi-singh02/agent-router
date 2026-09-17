import { z } from "zod";
import { AccountIdSchema, AgentIdSchema, ModelIdSchema, OpaqueCandidateIdSchema } from "./ids.js";
import { RatioSchema } from "./account.js";
import { ReasoningEffortSchema } from "./model-profile.js";

export const RouteCandidateSchema = z.object({
  opaqueId: OpaqueCandidateIdSchema,
  accountId: AccountIdSchema,
  modelId: ModelIdSchema,
  agent: AgentIdSchema,
  supportedEfforts: z.array(ReasoningEffortSchema).min(1),
  projectedRemainingRatio: RatioSchema,
});

export const RouteDecisionSchema = z.object({
  candidateOpaqueId: OpaqueCandidateIdSchema,
  accountId: AccountIdSchema,
  modelId: ModelIdSchema,
  agent: AgentIdSchema,
  effort: ReasoningEffortSchema,
  confidence: RatioSchema,
  reason: z.string().min(1),
  alternateCandidateOpaqueId: OpaqueCandidateIdSchema.optional(),
});

export type RouteCandidate = z.infer<typeof RouteCandidateSchema>;
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;
