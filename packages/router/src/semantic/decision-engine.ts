import type { ChoiceResponse, SystemOneRequest } from "@typesafe-ai/sdk";
import type { ReasoningEffort } from "../domain/model-profile.js";
import type { WorkflowPhase } from "../domain/session.js";
import type { SemanticCandidate } from "./candidate.js";
import { cacheValueQuestion } from "./cache-assessor.js";
import { effortQuestion } from "./effort-selector.js";
import { deterministicFallback } from "./fallback.js";
import { phaseQuestion } from "./phase-classifier.js";
import { routeQuestion } from "./route-ranker.js";
import { taskFamilyQuestion } from "./task-classifier.js";
import { complexityQuestion, consequenceQuestion, creativityQuestion } from "./task-scorer.js";
import { assertSafeState, type TypeSafePort } from "./typesafe-client.js";
import { shouldReconsiderRoute } from "../sessions/phase-transition.js";

export type { SemanticCandidate } from "./candidate.js";

export interface DecideRouteInput {
  task: string;
  candidates: SemanticCandidate[];
  userRequestedUltra: boolean;
  client: TypeSafePort;
  previousRoute?: {
    opaqueId: string;
    phase: WorkflowPhase;
    effort: ReasoningEffort;
  };
}

export type RouteDecisionResult =
  | {
      status: "selected";
      candidateOpaqueId: string;
      effort: ReasoningEffort;
      phase: WorkflowPhase;
      family: string;
      confidence: number;
      reason: string;
      sticky: boolean;
    }
  | {
      status: "ask-user";
      options: string[];
      family: string;
      phase: WorkflowPhase;
    }
  | { status: "invalid-choice" }
  | { status: "no-candidates" }
  | { status: "unsafe-state" }
  | { status: "typesafe-unavailable"; fallback?: ReturnType<typeof deterministicFallback> };

export function applyConfidencePolicy(input: {
  consequenceScore: number;
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  eligibleIds: string[];
}): { action: "ask-user"; options: string[] } | { action: "use-default"; option: string } {
  const ranked = Object.entries(input.probabilities)
    .filter(([id]) => input.eligibleIds.includes(id))
    .sort((left, right) => right[1] - left[1])
    .map(([id]) => id);
  if (input.consequenceScore >= 2 && input.confidence < 0.75 && ranked.length >= 2) {
    return { action: "ask-user", options: ranked.slice(0, 2) };
  }
  const option = input.eligibleIds.includes(input.choice) ? input.choice : ranked[0];
  return { action: "use-default", option: option ?? input.choice };
}

export async function decideRoute(input: DecideRouteInput): Promise<RouteDecisionResult> {
  if (input.candidates.length === 0) {
    return { status: "no-candidates" };
  }
  const eligibleIds = input.candidates.map((candidate) => candidate.opaqueId);
  const classificationState = { task: input.task, candidateCount: input.candidates.length };
  try {
    assertSafeState(classificationState);
  } catch {
    return { status: "unsafe-state" };
  }

  let classification;
  try {
    classification = await input.client.systemOne({
      state: classificationState,
      questions: {
        family: taskFamilyQuestion(),
        phase: phaseQuestion(),
        complexity: complexityQuestion(),
        creativity: creativityQuestion(),
        consequence: consequenceQuestion(),
        cacheValue: cacheValueQuestion(),
      },
    });
  } catch {
    return {
      status: "typesafe-unavailable",
      fallback: deterministicFallback({
        family: "routine-transformation",
        candidates: input.candidates,
      }),
    };
  }

  const family = classification.answers.family.choice;
  const phase = classification.answers.phase.choice as WorkflowPhase;
  const previous = input.previousRoute;
  const previousCandidate = previous
    ? input.candidates.find((candidate) => candidate.opaqueId === previous.opaqueId)
    : undefined;
  const routeStillEligible = Boolean(
    previousCandidate?.supportedEfforts.includes(previous!.effort),
  );
  if (
    previous &&
    !shouldReconsiderRoute({
      currentPhase: previous.phase,
      nextPhase: phase,
      routeStillEligible,
    })
  ) {
    return {
      status: "selected",
      candidateOpaqueId: previous.opaqueId,
      effort: previous.effort,
      phase,
      family,
      confidence: 1,
      reason: `reused previous route ${previous.opaqueId} (same phase)`,
      sticky: true,
    };
  }
  const rankingState = {
    task: input.task,
    family,
    phase,
    complexity: classification.answers.complexity.score,
    creativity: classification.answers.creativity.score,
    consequence: classification.answers.consequence.score,
    cacheValue: classification.answers.cacheValue.score,
    candidates: input.candidates.map((candidate) => ({
      opaqueId: candidate.opaqueId,
      agent: candidate.agent,
      projectedRemainingRatio: candidate.projectedRemainingRatio,
      capabilities: candidate.capabilities,
      supportedEfforts: [...candidate.supportedEfforts],
    })),
  };
  try {
    assertSafeState(rankingState);
  } catch {
    return { status: "unsafe-state" };
  }

  let ranking;
  try {
    ranking = await input.client.systemOne({
      state: rankingState,
      questions: { route: routeQuestion(input.candidates) },
    });
  } catch {
    return {
      status: "typesafe-unavailable",
      fallback: deterministicFallback({
        family,
        candidates: input.candidates,
      }),
    };
  }
  const route = ranking.answers.route as ChoiceResponse;
  if (!eligibleIds.includes(route.choice)) {
    return { status: "invalid-choice" };
  }
  const confidenceDecision = applyConfidencePolicy({
    consequenceScore: classification.answers.consequence.score,
    choice: route.choice,
    confidence: route.confidence,
    probabilities: route.probabilities as Record<string, number>,
    eligibleIds,
  });
  if (confidenceDecision.action === "ask-user") {
    return { status: "ask-user", options: confidenceDecision.options, family, phase };
  }

  const selected = input.candidates.find(
    (candidate) => candidate.opaqueId === confidenceDecision.option,
  );
  if (!selected) {
    return { status: "invalid-choice" };
  }
  let effortResponse;
  try {
    effortResponse = await input.client.systemOne({
      state: {
        task: input.task,
        family,
        phase,
        complexity: classification.answers.complexity.score,
        creativity: classification.answers.creativity.score,
      },
      questions: {
        effort: effortQuestion([...selected.supportedEfforts], input.userRequestedUltra),
      },
    });
  } catch {
    return {
      status: "typesafe-unavailable",
      fallback: deterministicFallback({
        family,
        candidates: input.candidates,
      }),
    };
  }
  const effort = effortResponse.answers.effort.choice as ReasoningEffort;
  if (effort === "ultra" && !input.userRequestedUltra) {
    return { status: "invalid-choice" };
  }
  return {
    status: "selected",
    candidateOpaqueId: selected.opaqueId,
    effort,
    phase,
    family,
    confidence: route.confidence,
    reason: `TypeSafe selected ${selected.opaqueId} for ${family} in phase ${phase}`,
    sticky: false,
  };
}

export type { SystemOneRequest };
