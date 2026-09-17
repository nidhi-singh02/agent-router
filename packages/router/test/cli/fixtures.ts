import { AccountSchema } from "../../src/domain/account.js";
import { ModelProfileSchema } from "../../src/domain/model-profile.js";
import { UsageSnapshotSchema } from "../../src/domain/usage.js";
import type { TypeSafePort } from "../../src/semantic/typesafe-client.js";
import type { Questions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";

export const now = new Date("2026-09-17T09:01:00.000Z");

export const personal = AccountSchema.parse({
  id: "acct_personal",
  label: "personal cursor",
  provider: "cursor",
  agent: "cursor",
  ownership: "personal",
  collectorPreference: ["official-cli"],
  enabledModels: ["cursor:grok-4.6"],
  enabled: true,
});

export const shared = AccountSchema.parse({
  id: "acct_shared",
  label: "family claude",
  provider: "anthropic",
  agent: "claude-code",
  ownership: "shared",
  collectorPreference: ["official-cli"],
  enabledModels: ["anthropic:claude-sonnet"],
  enabled: true,
});

export const cursorModel = ModelProfileSchema.parse({
  id: "cursor:grok-4.6",
  provider: "cursor",
  agent: "cursor",
  launchName: "grok-4.6",
  supportedEfforts: ["low", "medium", "high"],
  capabilities: { planning: 0.8, coding: 0.8, debugging: 0.7, creativity: 0.6, research: 0.6 },
  relativeQuotaCost: 1,
  relativeLatency: 1,
});

export const claudeModel = ModelProfileSchema.parse({
  id: "anthropic:claude-sonnet",
  provider: "anthropic",
  agent: "claude-code",
  launchName: "sonnet",
  supportedEfforts: ["low", "medium", "high"],
  capabilities: { planning: 0.85, coding: 0.8, debugging: 0.8, creativity: 0.7, research: 0.75 },
  relativeQuotaCost: 1,
  relativeLatency: 1,
});

export function usageFor(
  accountId: string,
  remainingRatio: number,
  extras: Record<string, unknown> = {},
) {
  return UsageSnapshotSchema.parse({
    accountId,
    windows: [
      {
        kind: "five-hour",
        remainingRatio,
        usedRatio: 1 - remainingRatio,
        resetsAt: "2026-09-17T14:00:00.000Z",
      },
    ],
    collectedAt: "2026-09-17T09:00:00.000Z",
    source: "official-cli",
    certainty: "exact",
    expiresAt: "2026-09-17T09:05:00.000Z",
    activeReservationRatio: 0,
    ...extras,
  });
}

function choiceAnswer(choice: string, confidence: number, probabilities: Record<string, number>) {
  return { type: "choice" as const, choice, confidence, probabilities };
}

function scoreAnswer(score: number, confidence = 0.8) {
  return {
    type: "score" as const,
    score,
    confidence,
    legend: {},
    probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 },
  };
}

export function fakeTypeSafe(script: {
  family?: string;
  phase?: string;
  route?: string;
  routeConfidence?: number;
  routeProbabilities?: Record<string, number>;
  effort?: string;
  consequence?: number;
}): TypeSafePort {
  const calls: SystemOneRequest[] = [];
  return {
    calls,
    async systemOne<const Q extends Questions>(
      request: SystemOneRequest<Q>,
    ): Promise<SystemOneResult<Q>> {
      calls.push(request as SystemOneRequest);
      if ("family" in request.questions) {
        return {
          model: "fake",
          answers: {
            family: choiceAnswer(script.family ?? "implementation", 0.9, {
              implementation: 0.9,
            }),
            phase: choiceAnswer(script.phase ?? "implementation", 0.9, {
              implementation: 0.9,
            }),
            complexity: scoreAnswer(1),
            creativity: scoreAnswer(0),
            consequence: scoreAnswer(script.consequence ?? 1),
            cacheValue: scoreAnswer(1),
          } as SystemOneResult<Q>["answers"],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }
      if ("route" in request.questions) {
        const ids = Object.keys(
          (request.questions.route as { criteria: Record<string, unknown> }).criteria,
        );
        const choice = script.route && ids.includes(script.route) ? script.route : ids[0];
        const probabilities =
          script.routeProbabilities ?? Object.fromEntries(ids.map((id) => [id, 0.5]));
        return {
          model: "fake",
          answers: {
            route: choiceAnswer(choice ?? "none", script.routeConfidence ?? 0.9, probabilities),
          } as SystemOneResult<Q>["answers"],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }
      return {
        model: "fake",
        answers: {
          effort: choiceAnswer(script.effort ?? "medium", 0.9, { medium: 0.9, high: 0.1 }),
        } as SystemOneResult<Q>["answers"],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
}
