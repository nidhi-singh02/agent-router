import { randomUUID } from "node:crypto";
import { redactCollectorText } from "../collectors/normalizer.js";
import { RouterSessionSchema } from "../domain/session.js";
import type { SessionRepository } from "../store/session-repository.js";
import { evaluateEligibility } from "../policy/eligibility.js";
import { revalidateDecision } from "../policy/revalidate.js";
import { decideRoute } from "../semantic/decision-engine.js";
import type { TypeSafePort } from "../semantic/typesafe-client.js";
import { formatDecisionCard } from "../presentation/decision-card.js";
import { formatPoolQuota } from "../presentation/quota.js";
import { launchRoutedAgent } from "../launch/herdr-launcher.js";
import type { HerdrClient } from "../launch/herdr-client.js";
import { buildHandoff, serializeHandoff } from "../handoff/handoff-builder.js";
import type { Account } from "../domain/account.js";
import type { ModelProfile } from "../domain/model-profile.js";
import type { UsageSnapshot } from "../domain/usage.js";
import type { ReasoningEffort } from "../domain/model-profile.js";
import { estimateTaskCostRatio } from "../policy/cost-estimator.js";
import { ReservationService } from "../reservations/reservation-service.js";
import { readSharedActivity } from "../activity/activity-service.js";
import type { CoordinatorClient } from "../activity/coordinator-client.js";

export interface RunDeps {
  accounts: Account[];
  models: ModelProfile[];
  usage: Record<string, UsageSnapshot>;
  client: TypeSafePort;
  env: NodeJS.Dict<string>;
  now?: Date;
  reservations?: ReservationService;
  herdr?: HerdrClient;
  existingLaunchToken?: string;
  existingPaneId?: string;
  activityClient?: CoordinatorClient;
  sessions?: Pick<SessionRepository, "save">;
}

export async function executeRun(
  task: string,
  options: { dryRun: boolean },
  deps: RunDeps,
): Promise<{ output: string; json: unknown; code: number }> {
  const now = deps.now ?? new Date();
  const reservations = deps.reservations ?? new ReservationService();
  const eligible = [];
  const exclusions = [];
  const ownerMessages = new Map<string, string>();
  for (const account of deps.accounts) {
    if (deps.activityClient) {
      const activity = await readSharedActivity({
        account,
        client: deps.activityClient,
      });
      if (account.ownership === "shared" && activity.conservative) {
        // Without a coordinator signal, known quota plus the shared reserve is enough to route.
        const knownUsage =
          deps.usage[account.id]?.certainty !== undefined &&
          deps.usage[account.id]?.certainty !== "unknown";
        if (!(activity.coordinatorUnavailable && knownUsage)) {
          exclusions.push({ accountId: account.id, reason: "shared-activity-constrained" });
          continue;
        }
        ownerMessages.set(account.id, "unknown (coordinator unavailable); routed on quota");
      }
      if (activity.ownerMessage) {
        ownerMessages.set(account.id, activity.ownerMessage);
      }
    }
    const usage = deps.usage[account.id];
    if (!usage) {
      exclusions.push({ accountId: account.id, reason: "unknown-usage" });
      continue;
    }
    for (const model of deps.models.filter((item) => account.enabledModels.includes(item.id))) {
      const estimatedCostRatio = estimateTaskCostRatio({
        relativeQuotaCost: model.relativeQuotaCost,
        baselineRatio: 0.02,
      });
      const usageWithReservations = {
        ...usage,
        activeReservationRatio: usage.activeReservationRatio + reservations.activeRatio(account.id),
      };
      const result = evaluateEligibility({
        account,
        model,
        usage: usageWithReservations,
        estimatedCostRatio,
        now,
      });
      if (result.eligible) {
        eligible.push({
          opaqueId: `${account.id}:${model.id}`,
          account,
          model,
          projectedRemainingRatio: result.projectedRemainingRatio,
          estimatedCostRatio,
        });
      } else {
        exclusions.push({ accountId: account.id, modelId: model.id, reason: result.reason });
      }
    }
  }
  if (eligible.length === 0) {
    return {
      code: 2,
      output: `No eligible route. Exclusions: ${JSON.stringify(exclusions)}`,
      json: { ok: false, exclusions },
    };
  }
  const decision = await decideRoute({
    task,
    userRequestedUltra: /\bultra\b/i.test(task),
    client: deps.client,
    candidates: eligible.map((item) => ({
      opaqueId: item.opaqueId,
      agent: item.model.agent,
      modelId: item.model.id,
      supportedEfforts: item.model.supportedEfforts,
      projectedRemainingRatio: item.projectedRemainingRatio,
      capabilities: item.model.capabilities,
    })),
  });
  if (decision.status === "ask-user") {
    return {
      code: 3,
      output: `Low confidence. Choose: ${decision.options.join(" or ")}`,
      json: { ok: false, options: decision.options },
    };
  }
  if (decision.status !== "selected") {
    return {
      code: 2,
      output: `TypeSafe could not select a route (${decision.status}).`,
      json: { ok: false, status: decision.status },
    };
  }
  const selected = eligible.find((item) => item.opaqueId === decision.candidateOpaqueId);
  if (!selected) {
    return { code: 2, output: "Selected candidate is no longer eligible.", json: { ok: false } };
  }
  const revalidated = revalidateDecision({
    account: selected.account,
    model: selected.model,
    usage: deps.usage[selected.account.id]!,
    estimatedCostRatio: selected.estimatedCostRatio,
    selectedEffort: decision.effort,
    now,
  });
  if (!revalidated.ok) {
    return {
      code: 2,
      output: `Launch revalidation failed: ${revalidated.reason}`,
      json: { ok: false, reason: revalidated.reason },
    };
  }
  const reservation = reservations.create({
    accountId: selected.account.id,
    ratio: selected.estimatedCostRatio,
    ttlMs: 60_000,
  });
  const handoff = buildHandoff({
    task,
    approvedSpec: "Use the current approved specification and plan.",
    constraints: ["Do not deploy or consume extra quota."],
    currentPhase: decision.phase,
    relevantFiles: [],
    completedChecks: [],
    remainingAcceptanceCriteria: [],
  });
  const launch = await launchRoutedAgent({
    env: deps.env,
    agent: selected.model.agent,
    launchName: selected.model.launchName,
    effort: decision.effort,
    handoff: serializeHandoff(handoff),
    dryRun: options.dryRun,
    herdr: deps.herdr,
    existingLaunchToken: deps.existingLaunchToken,
    existingPaneId: deps.existingPaneId,
  });
  let sessionId: string | undefined;
  if (!options.dryRun && deps.sessions) {
    const startedAt = new Date().toISOString();
    const session = RouterSessionSchema.parse({
      id: `sess_${randomUUID()}`,
      task: redactCollectorText(task),
      phase: decision.phase,
      route: {
        accountId: selected.account.id,
        modelId: selected.model.id,
        agent: selected.model.agent,
        launchName: selected.model.launchName,
        effort: decision.effort,
        reason: decision.reason,
        status: launch.ok ? "launched" : "launch-failed",
        launchToken: launch.launchToken,
        error: launch.ok ? undefined : redactCollectorText(launch.error ?? "launch failed"),
      },
      reservations: [
        {
          id: reservation.id,
          accountId: reservation.accountId,
          ratio: reservation.ratio,
          createdAt: startedAt,
          expiresAt: new Date(reservation.expiresAt).toISOString(),
        },
      ],
      handoffs: [handoff],
      paneId: launch.paneId,
      createdAt: startedAt,
      updatedAt: startedAt,
    });
    deps.sessions.save(session);
    sessionId = session.id;
  }
  const snapshot = deps.usage[selected.account.id];
  const card = formatDecisionCard({
    selected: `${selected.model.agent} / ${selected.model.launchName} / ${decision.effort}`,
    phase: decision.phase,
    why: decision.reason,
    sharedActivity:
      ownerMessages.get(selected.account.id) ??
      (selected.account.ownership === "shared" && !deps.activityClient
        ? "shared subscription currently active"
        : undefined),
    reservePolicy: selected.account.ownership === "shared" ? "40% protected" : "personal account",
    cacheDecision: "phase sticky unless eligibility changes",
    usageSource: !snapshot
      ? "unknown"
      : snapshot.source === "skipped"
        ? "skipped (run with --usage to check quota)"
        : snapshot.source === "none"
          ? "unknown (no collector returned usage)"
          : `${snapshot.certainty} ${snapshot.source}`,
    quota: snapshot ? formatPoolQuota(snapshot, selected.model.quotaPool) : undefined,
    freshness: snapshot ? `refreshed at ${snapshot.collectedAt}` : undefined,
    reset: snapshot?.windows.find((window) => window.resetsAt)?.resetsAt,
  });
  return {
    code: launch.ok ? 0 : 1,
    output: `${card}\n${launch.printed ?? launch.error ?? ""}`,
    json: {
      ok: launch.ok,
      selected: selected.opaqueId,
      effort: decision.effort,
      dryRun: options.dryRun,
      launchToken: launch.launchToken,
      paneId: launch.paneId,
      sessionId,
    },
  };
}

export type { ReasoningEffort };
