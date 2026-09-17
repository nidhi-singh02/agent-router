import { z } from "zod";

export const AccountIdSchema = z.string().min(1).brand<"AccountId">();
export const ModelIdSchema = z.string().min(1).brand<"ModelId">();
export const SessionIdSchema = z.string().min(1).brand<"SessionId">();
export const OpaqueCandidateIdSchema = z.string().min(1).brand<"OpaqueCandidateId">();
export const ProviderIdSchema = z.string().min(1).brand<"ProviderId">();

export const AgentIdSchema = z.enum(["cursor", "claude-code", "codex", "opencode"]);

export type AccountId = z.infer<typeof AccountIdSchema>;
export type ModelId = z.infer<typeof ModelIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type OpaqueCandidateId = z.infer<typeof OpaqueCandidateIdSchema>;
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type AgentId = z.infer<typeof AgentIdSchema>;
