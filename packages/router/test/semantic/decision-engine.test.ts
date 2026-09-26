import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decideRoute } from "../../src/semantic/decision-engine.js";
import type { TypeSafePort } from "../../src/semantic/typesafe-client.js";
import type { SystemOneRequest, SystemOneResult, Questions } from "@typesafe-ai/sdk";
import { cursorModel, fakeTypeSafe } from "../cli/fixtures.js";

function choiceAnswer(choice: string, confidence: number, probabilities: Record<string, number>) {
  return { type: "choice" as const, choice, confidence, probabilities };
}

function scoreAnswer(score: number, confidence: number) {
  return {
    type: "score" as const,
    score,
    confidence,
    legend: {},
    probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 },
  };
}

function fakeClient(handler: (request: SystemOneRequest) => Record<string, unknown>): TypeSafePort {
  const calls: SystemOneRequest[] = [];
  return {
    calls,
    async systemOne<const Q extends Questions>(
      request: SystemOneRequest<Q>,
    ): Promise<SystemOneResult<Q>> {
      calls.push(request as SystemOneRequest);
      return {
        model: "fake-jev",
        answers: handler(request) as SystemOneResult<Q>["answers"],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
}

const eligible = [
  {
    opaqueId: "cand_safe_a",
    agent: "cursor" as const,
    modelId: "cursor:grok-4.6",
    supportedEfforts: ["low", "medium", "high"] as const,
    projectedRemainingRatio: 0.7,
    capabilities: { planning: 0.8, coding: 0.8, debugging: 0.7, creativity: 0.6, research: 0.6 },
  },
  {
    opaqueId: "cand_safe_b",
    agent: "claude-code" as const,
    modelId: "anthropic:claude-sonnet",
    supportedEfforts: ["medium", "high", "ultra"] as const,
    projectedRemainingRatio: 0.55,
    capabilities: { planning: 0.85, coding: 0.8, debugging: 0.8, creativity: 0.7, research: 0.75 },
  },
];

describe("decision engine", () => {
  it("returns only an eligible opaque candidate id", async () => {
    const client = fakeClient((request) => {
      if ("route" in request.questions) {
        return {
          route: choiceAnswer("cand_safe_a", 0.9, { cand_safe_a: 0.8, cand_safe_b: 0.2 }),
        };
      }
      if ("effort" in request.questions) {
        return { effort: choiceAnswer("medium", 0.88, { low: 0.05, medium: 0.8, high: 0.15 }) };
      }
      return {
        family: choiceAnswer("implementation", 0.92, { implementation: 0.92, planning: 0.08 }),
        phase: choiceAnswer("implementation", 0.9, { implementation: 0.9, planning: 0.1 }),
        complexity: scoreAnswer(1, 0.8),
        creativity: scoreAnswer(0, 0.8),
        consequence: scoreAnswer(1, 0.8),
        cacheValue: scoreAnswer(2, 0.7),
      };
    });

    const decision = await decideRoute({
      task: "Implement the approved session repository plan.",
      candidates: eligible,
      userRequestedUltra: false,
      client,
    });

    expect(decision.status).toBe("selected");
    if (decision.status === "selected") {
      expect(["cand_safe_a", "cand_safe_b"]).toContain(decision.candidateOpaqueId);
      expect(decision.effort).not.toBe("ultra");
    }
  });

  it("ignores a TypeSafe choice outside the eligible closed set", async () => {
    const client = fakeClient((request) => {
      if ("route" in request.questions) {
        return { route: choiceAnswer("cand_ineligible", 0.99, { cand_ineligible: 0.99 }) };
      }
      if ("effort" in request.questions) {
        return { effort: choiceAnswer("medium", 0.9, { medium: 0.9, high: 0.1 }) };
      }
      return {
        family: choiceAnswer("implementation", 0.9, { implementation: 1 }),
        phase: choiceAnswer("implementation", 0.9, { implementation: 1 }),
        complexity: scoreAnswer(1, 0.8),
        creativity: scoreAnswer(0, 0.8),
        consequence: scoreAnswer(1, 0.8),
        cacheValue: scoreAnswer(1, 0.8),
      };
    });

    const decision = await decideRoute({
      task: "Implement the approved plan.",
      candidates: eligible,
      userRequestedUltra: false,
      client,
    });

    expect(decision.status).toBe("invalid-choice");
  });

  it("excludes ultra unless the user requested it and the model supports it", async () => {
    const client = fakeClient((request) => {
      if ("route" in request.questions) {
        return { route: choiceAnswer("cand_safe_b", 0.9, { cand_safe_b: 0.7, cand_safe_a: 0.3 }) };
      }
      if ("effort" in request.questions) {
        const criteria = request.questions.effort as { criteria: Record<string, unknown> };
        expect(criteria.criteria).not.toHaveProperty("ultra");
        return { effort: choiceAnswer("high", 0.8, { high: 0.8, medium: 0.2 }) };
      }
      return {
        family: choiceAnswer("debugging", 0.85, { debugging: 0.85 }),
        phase: choiceAnswer("debugging", 0.85, { debugging: 0.85 }),
        complexity: scoreAnswer(3, 0.8),
        creativity: scoreAnswer(0, 0.8),
        consequence: scoreAnswer(2, 0.8),
        cacheValue: scoreAnswer(1, 0.8),
      };
    });

    const decision = await decideRoute({
      task: "Debug a failing production issue.",
      candidates: eligible,
      userRequestedUltra: false,
      client,
    });
    expect(decision.status).toBe("selected");
    if (decision.status === "selected") {
      expect(decision.effort).toBe("high");
    }
  });

  it("does not send credentials, cookies, account labels, or telegram data to TypeSafe", async () => {
    const client = fakeClient((request) => {
      const serialized = JSON.stringify(request);
      expect(serialized).not.toMatch(/sk-|cookie|telegram|family claude|Bearer/i);
      if ("route" in request.questions) {
        return { route: choiceAnswer("cand_safe_a", 0.91, { cand_safe_a: 0.91 }) };
      }
      if ("effort" in request.questions) {
        return { effort: choiceAnswer("medium", 0.9, { medium: 1 }) };
      }
      return {
        family: choiceAnswer("implementation", 0.9, { implementation: 1 }),
        phase: choiceAnswer("implementation", 0.9, { implementation: 1 }),
        complexity: scoreAnswer(1, 0.8),
        creativity: scoreAnswer(0, 0.8),
        consequence: scoreAnswer(1, 0.8),
        cacheValue: scoreAnswer(1, 0.8),
      };
    });

    await decideRoute({
      task: "Implement the approved plan.",
      candidates: eligible,
      userRequestedUltra: false,
      client,
    });
    expect(client.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("batches independent classifications before ranking", async () => {
    const client = fakeClient((request) => {
      if ("family" in request.questions) {
        expect(request.questions).toHaveProperty("phase");
        expect(request.questions).toHaveProperty("complexity");
        expect(request.questions).not.toHaveProperty("route");
        return {
          family: choiceAnswer("planning", 0.9, { planning: 1 }),
          phase: choiceAnswer("planning", 0.9, { planning: 1 }),
          complexity: scoreAnswer(3, 0.8),
          creativity: scoreAnswer(1, 0.8),
          consequence: scoreAnswer(2, 0.8),
          cacheValue: scoreAnswer(1, 0.8),
        };
      }
      if ("route" in request.questions) {
        return { route: choiceAnswer("cand_safe_b", 0.86, { cand_safe_b: 0.6, cand_safe_a: 0.4 }) };
      }
      return { effort: choiceAnswer("high", 0.8, { high: 1 }) };
    });

    await decideRoute({
      task: "Plan the architecture.",
      candidates: eligible,
      userRequestedUltra: false,
      client,
    });
    expect(client.calls.map((call) => Object.keys(call.questions))).toEqual([
      ["family", "phase", "complexity", "creativity", "consequence", "cacheValue"],
      ["route"],
      ["effort"],
    ]);
  });

  it.each(["implementation", "routine-transformation", "metadata"])(
    "keeps ranking failure behavior for %s",
    async (family) => {
      const rankingFail = fakeClient((request) => {
        if ("family" in request.questions) {
          return {
            family: choiceAnswer(family, 0.9, { [family]: 1 }),
            phase: choiceAnswer("implementation", 0.9, { implementation: 1 }),
            complexity: scoreAnswer(1, 0.8),
            creativity: scoreAnswer(0, 0.8),
            consequence: scoreAnswer(1, 0.8),
            cacheValue: scoreAnswer(1, 0.8),
          };
        }
        throw new Error("ranking down");
      });
      await expect(
        decideRoute({
          task: "Implement the approved plan.",
          candidates: eligible,
          userRequestedUltra: false,
          client: rankingFail,
        }),
      ).resolves.toEqual({
        status: "typesafe-unavailable",
        fallback:
          family === "implementation"
            ? undefined
            : {
                candidateOpaqueId: "cand_safe_a",
                effort: "low",
                phase: family,
              },
      });
    },
  );

  it.each([
    ["cand_safe_a", "low"],
    ["cand_safe_b", "medium"],
  ])("preserves ranked choice %s when effort fails", async (opaqueId, effort) => {
    const effortFail = fakeClient((request) => {
      if ("route" in request.questions) {
        return { route: choiceAnswer(opaqueId, 0.9, { [opaqueId]: 0.9 }) };
      }
      if ("effort" in request.questions) {
        throw new Error("503 Service temporarily unavailable");
      }
      return {
        family: choiceAnswer("implementation", 0.9, { implementation: 1 }),
        phase: choiceAnswer("implementation", 0.9, { implementation: 1 }),
        complexity: scoreAnswer(1, 0.8),
        creativity: scoreAnswer(0, 0.8),
        consequence: scoreAnswer(1, 0.8),
        cacheValue: scoreAnswer(1, 0.8),
      };
    });
    await expect(
      decideRoute({
        task: "Implement the approved plan.",
        candidates: eligible,
        userRequestedUltra: false,
        client: effortFail,
      }),
    ).resolves.toMatchObject({
      status: "selected",
      candidateOpaqueId: opaqueId,
      effort,
      sticky: false,
      trace: { fallbackUsed: true },
    });
  });

  it("allows task text that mentions Telegram or cookie while still excluding secrets", async () => {
    const client = fakeClient((request) => {
      const serialized = JSON.stringify(request);
      expect(serialized).toMatch(/Telegram/);
      expect(serialized).not.toMatch(/sk-secret-123/);
      if ("route" in request.questions) {
        return { route: choiceAnswer("cand_safe_a", 0.91, { cand_safe_a: 0.91 }) };
      }
      if ("effort" in request.questions) {
        return { effort: choiceAnswer("medium", 0.9, { medium: 1 }) };
      }
      return {
        family: choiceAnswer("implementation", 0.9, { implementation: 1 }),
        phase: choiceAnswer("implementation", 0.9, { implementation: 1 }),
        complexity: scoreAnswer(1, 0.8),
        creativity: scoreAnswer(0, 0.8),
        consequence: scoreAnswer(1, 0.8),
        cacheValue: scoreAnswer(1, 0.8),
      };
    });
    const decision = await decideRoute({
      task: "Tell the team on Telegram after the cookie banner copy is approved.",
      candidates: eligible,
      userRequestedUltra: false,
      client,
    });
    expect(decision.status).toBe("selected");
  });

  const grokCandidate = {
    opaqueId: "acct:cursor:grok-4.6",
    agent: "cursor" as const,
    modelId: cursorModel.id,
    supportedEfforts: ["low", "medium", "high"] as const,
    projectedRemainingRatio: 0.8,
    capabilities: cursorModel.capabilities,
  };

  it("reuses the previous eligible route in the same phase without ranking", async () => {
    const client = fakeTypeSafe({
      family: "implementation",
      phase: "implementation",
      route: "acct:other",
      effort: "high",
    });
    const decision = await decideRoute({
      task: "Keep implementing the plan.",
      userRequestedUltra: false,
      client,
      candidates: [grokCandidate],
      previousRoute: {
        opaqueId: "acct:cursor:grok-4.6",
        phase: "implementation",
        effort: "medium",
      },
    });
    expect(decision).toMatchObject({
      status: "selected",
      candidateOpaqueId: "acct:cursor:grok-4.6",
      effort: "medium",
      sticky: true,
    });
    expect(client.calls.some((call) => "route" in call.questions)).toBe(false);
    expect(client.calls.some((call) => "effort" in call.questions)).toBe(false);
  });

  it("re-ranks at a phase boundary even if the previous route is still eligible", async () => {
    const client = fakeTypeSafe({
      family: "implementation",
      phase: "implementation",
      route: "acct:cursor:grok-4.6",
      effort: "low",
    });
    const decision = await decideRoute({
      task: "Implement the approved plan.",
      userRequestedUltra: false,
      client,
      candidates: [grokCandidate],
      previousRoute: {
        opaqueId: "acct:cursor:grok-4.6",
        phase: "planning",
        effort: "high",
      },
    });
    expect(decision).toMatchObject({
      status: "selected",
      effort: "low",
      sticky: false,
    });
    expect(client.calls.some((call) => "route" in call.questions)).toBe(true);
  });

  it("re-ranks when the previous opaque id is not in the eligible set", async () => {
    const client = fakeTypeSafe({
      family: "implementation",
      phase: "implementation",
      route: "acct:cursor:grok-4.6",
      effort: "medium",
    });
    const decision = await decideRoute({
      task: "Keep implementing the plan.",
      userRequestedUltra: false,
      client,
      candidates: [grokCandidate],
      previousRoute: {
        opaqueId: "acct:other:model",
        phase: "implementation",
        effort: "medium",
      },
    });
    expect(decision).toMatchObject({
      status: "selected",
      candidateOpaqueId: "acct:cursor:grok-4.6",
      sticky: false,
    });
    expect(client.calls.some((call) => "route" in call.questions)).toBe(true);
  });

  it("returns unsafe-state instead of throwing when the task contains a credential shape", async () => {
    const client = fakeTypeSafe({});
    const result = await decideRoute({
      task: "refactor using key AKIAIOSFODNN7EXAMPLE now",
      candidates: [grokCandidate],
      userRequestedUltra: false,
      client,
    });
    expect(result.status).toBe("unsafe-state");
  });
});

describe("evaluation fixtures", () => {
  it("cover the required task families", () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "../../evals/routing-cases.json"),
        "utf8",
      ),
    ) as { cases: Array<{ id: string }> };
    expect(raw.cases.map((item) => item.id).sort()).toEqual(
      [
        "creative-ideation",
        "debugging",
        "implementation",
        "metadata",
        "planning",
        "research",
        "review",
        "routine-transformation",
        "specification",
      ].sort(),
    );
  });
});
