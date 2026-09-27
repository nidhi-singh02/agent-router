import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Questions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";
import { AccountSchema } from "../../src/domain/account.js";
import { ModelProfileSchema, type ReasoningEffort } from "../../src/domain/model-profile.js";
import { RouterSessionSchema, type RouterSession } from "../../src/domain/session.js";
import type { TypeSafePort } from "../../src/semantic/typesafe-client.js";
import { openDatabase } from "../../src/store/database.js";
import { EffortChangeRepository } from "../../src/store/effort-change-repository.js";
import { SessionRepository } from "../../src/store/session-repository.js";

export const opusAccount = AccountSchema.parse({
  id: "acct_claude",
  label: "personal claude",
  provider: "anthropic",
  agent: "claude-code",
  ownership: "personal",
  collectorPreference: ["local-session"],
  enabledModels: ["anthropic:claude-opus"],
  enabled: true,
});

export const astraAccount = AccountSchema.parse({
  id: "acct_codex",
  label: "personal codex",
  provider: "openai",
  agent: "codex",
  ownership: "personal",
  collectorPreference: ["local-session"],
  enabledModels: ["openai:gpt-6-astra"],
  enabled: true,
});

const capabilities = { planning: 0.9, coding: 0.9, debugging: 0.9, creativity: 0.8, research: 0.8 };

export const opusModel = ModelProfileSchema.parse({
  id: "anthropic:claude-opus",
  provider: "anthropic",
  agent: "claude-code",
  launchName: "opus",
  supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
  capabilities,
  relativeQuotaCost: 1,
  relativeLatency: 1,
});

export const astraModel = ModelProfileSchema.parse({
  id: "openai:gpt-6-astra",
  provider: "openai",
  agent: "codex",
  launchName: "gpt-6-astra",
  supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  capabilities,
  relativeQuotaCost: 1,
  relativeLatency: 1,
});

export function store() {
  const home = mkdtempSync(path.join(os.tmpdir(), "router-live-effort-"));
  const db = openDatabase({ home });
  return {
    home,
    db,
    sessions: new SessionRepository(db),
    effortChanges: new EffortChangeRepository(db),
  };
}

export function launchedSession(input: {
  id?: string;
  agent: "claude-code" | "codex";
  effort: ReasoningEffort;
  paneId?: string;
  agentName?: string;
  task?: string;
  phase?: RouterSession["phase"];
  extras?: Partial<RouterSession>;
}): RouterSession {
  const claude = input.agent === "claude-code";
  const at = "2026-09-26T09:00:00.000Z";
  return RouterSessionSchema.parse({
    id: input.id ?? "sess_live",
    task: input.task ?? "Plan the migration.",
    phase: input.phase ?? "planning",
    route: {
      accountId: claude ? opusAccount.id : astraAccount.id,
      modelId: claude ? opusModel.id : astraModel.id,
      agent: input.agent,
      launchName: claude ? "opus" : "gpt-6-astra",
      effort: input.effort,
      reason: "test",
      status: "launched",
      launchToken: "launch_1",
      agentName: input.agentName ?? `router-${claude ? "claude" : "codex"}-abc123`,
    },
    reservations: [],
    handoffs: [],
    paneId: input.paneId ?? "wJ:p1",
    createdAt: at,
    updatedAt: at,
    ...input.extras,
  });
}

/** Answers every effort question with a fixed choice and confidence. */
export function effortTypeSafe(choice: string, confidence = 0.9): TypeSafePort {
  const calls: SystemOneRequest[] = [];
  return {
    calls,
    async systemOne<const Q extends Questions>(
      request: SystemOneRequest<Q>,
    ): Promise<SystemOneResult<Q>> {
      calls.push(request as SystemOneRequest);
      return {
        model: "fake",
        answers: {
          effort: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } },
        } as SystemOneResult<Q>["answers"],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
}
