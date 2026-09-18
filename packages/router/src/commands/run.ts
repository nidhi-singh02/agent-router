import { randomUUID } from "node:crypto";
import { runCommand as defaultRunCommand, type runCommand } from "../collectors/command-runner.js";
import { redactCollectorText } from "../collectors/normalizer.js";
import { resolveEnrichment, type Resolution } from "../enrich/resolver.js";
import { toShapes, type EnrichmentShapes } from "../enrich/buckets.js";
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
import { buildHandoff, formatHandoffPrompt } from "../handoff/handoff-builder.js";
import type { Account } from "../domain/account.js";
import type { ModelProfile } from "../domain/model-profile.js";
import type { UsageSnapshot } from "../domain/usage.js";
import type { ReasoningEffort } from "../domain/model-profile.js";
import { estimateTaskCostRatio } from "../policy/cost-estimator.js";
import { ReservationService } from "../reservations/reservation-service.js";
import { readSharedActivity } from "../activity/activity-service.js";
import type { CoordinatorClient } from "../activity/coordinator-client.js";
import { cacheAffinityKey } from "../sessions/cache-affinity.js";
import { remainingRatio } from "../policy/quota.js";

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
  sessions?: Pick<SessionRepository, "save" | "get">;
  /** Where the TypeSafe key was looked for, when none was found. */
  typesafeKeyHint?: string;
  /** Subprocess runner, injected for tests. */
  runCommand?: typeof runCommand;
  /** Persistent config switch; either this or `options.noEnrich` disables enrichment. */
  enrichmentEnabled?: boolean;
}

export async function executeRun(
  task: string,
  options: { dryRun: boolean; previousSessionId?: string; noEnrich?: boolean },
  deps: RunDeps,
): Promise<{ output: string; json: unknown; code: number }> {
  const now = deps.now ?? new Date();
  const previous = options.previousSessionId
    ? deps.sessions?.get(options.previousSessionId)
    : undefined;
  if (options.previousSessionId && !previous) {
    const output = `Session not found: ${options.previousSessionId}`;
    return { code: 2, output, json: { ok: false, error: output } };
  }
  const enrichmentOff = options.noEnrich === true || deps.enrichmentEnabled === false;
  const resolution: Resolution = enrichmentOff
    ? { status: "skipped" }
    : await resolveEnrichment({
        task,
        run: deps.runCommand ?? defaultRunCommand,
        env: deps.env,
      });
  const enrichment =
    resolution.status === "resolved"
      ? toShapes({ churn: resolution.churn, changedFiles: resolution.changedFiles })
      : undefined;
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
    enrichment,
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
    previousRoute: previous?.route
      ? {
          opaqueId: `${previous.route.accountId}:${previous.route.modelId}`,
          phase: previous.phase,
          effort: previous.route.effort,
        }
      : undefined,
  });
  if (decision.status === "unsafe-state") {
    const output =
      "Task text looks like it contains a credential and was not sent. Remove the secret and retry.";
    return { code: 2, output, json: { ok: false, status: "unsafe-state" } };
  }
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
      output: [
        `TypeSafe could not select a route (${decision.status}).`,
        decision.status === "typesafe-unavailable" ? deps.typesafeKeyHint : undefined,
      ]
        .filter(Boolean)
        .join(" "),
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
  const remaining = remainingRatio(deps.usage[selected.account.id]!, selected.model.quotaPool);
  const maxTotalRatio =
    selected.account.ownership === "shared"
      ? (remaining ?? 0) -
        deps.usage[selected.account.id]!.activeReservationRatio -
        selected.account.reserveFloor
      : Number.POSITIVE_INFINITY;
  const reservation = reservations.tryCreate({
    accountId: selected.account.id,
    ratio: selected.estimatedCostRatio,
    ttlMs: 60_000,
    maxTotalRatio,
  });
  if (!reservation)
    return {
      code: 2,
      output: "Launch revalidation failed: reservation-conflict",
      json: { ok: false, reason: "reservation-conflict" },
    };
  const handoff = buildHandoff({
    task,
    constraints: ["Do not deploy or publish anything without asking the user."],
    currentPhase: decision.phase,
    relevantFiles: [],
    completedChecks: [],
    remainingAcceptanceCriteria: [],
  });
  // Recorded launches get their session id up front so the agent can route the next phase.
  const sessionId = !options.dryRun && deps.sessions ? `sess_${randomUUID()}` : undefined;
  const launch = await launchRoutedAgent({
    env: deps.env,
    agent: selected.model.agent,
    launchName: selected.model.launchName,
    effort: decision.effort,
    handoff: formatHandoffPrompt(
      handoff,
      sessionId
        ? {
            sessionId,
            previous: previous
              ? { sessionId: previous.id, phase: previous.phase, task: previous.task }
              : undefined,
          }
        : undefined,
    ),
    dryRun: options.dryRun,
    herdr: deps.herdr,
    existingLaunchToken: deps.existingLaunchToken,
    existingPaneId: deps.existingPaneId,
  });
  if (options.dryRun || !launch.ok) reservations.release(reservation.id);
  if (sessionId && deps.sessions) {
    const startedAt = new Date().toISOString();
    const affinityInput = {
      provider: selected.account.provider,
      modelId: selected.model.id,
      effort: decision.effort,
      agent: selected.model.agent,
      promptPrefix: task.slice(0, 80),
    };
    const key = cacheAffinityKey(affinityInput);
    const session = RouterSessionSchema.parse({
      id: sessionId,
      previousSessionId: previous?.id,
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
        agentName: launch.agentName,
        error: launch.ok ? undefined : redactCollectorText(launch.error ?? "launch failed"),
      },
      cacheAffinity: {
        provider: selected.account.provider,
        modelId: selected.model.id,
        effort: decision.effort,
        agent: selected.model.agent,
        promptPrefixHash: key.slice(key.lastIndexOf(":") + 1),
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
  }
  const snapshot = deps.usage[selected.account.id];
  const card = formatDecisionCard({
    selected: `${selected.model.agent} / ${selected.model.launchName} / ${decision.effort}`,
    phase: decision.phase,
    taskSize: formatTaskSize(resolution, enrichment),
    why: decision.reason,
    previousSession: previous
      ? `${previous.id} (${previous.phase} -> ${decision.phase})`
      : undefined,
    sharedActivity:
      ownerMessages.get(selected.account.id) ??
      (selected.account.ownership === "shared" && !deps.activityClient
        ? "shared subscription currently active"
        : undefined),
    reservePolicy: selected.account.ownership === "shared" ? "40% protected" : "personal account",
    cacheDecision: decision.sticky
      ? "reused previous route (same phase)"
      : previous
        ? previous.phase !== decision.phase
          ? "phase change justifies a structured handoff"
          : "previous route ineligible; re-ranked"
        : "no previous session",
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
      agentName: launch.agentName,
      sessionId,
      enrichment: enrichmentJson(resolution, enrichment),
    },
  };
}

function enrichmentJson(
  resolution: Resolution,
  shapes: EnrichmentShapes | undefined,
): Record<string, unknown> {
  if (resolution.status === "skipped") {
    return { status: "skipped" };
  }
  if (resolution.status === "unresolved") {
    return { status: "unresolved", reason: resolution.reason };
  }
  return {
    status: "resolved",
    prNumber: resolution.prNumber,
    repo: `${resolution.repo.owner}/${resolution.repo.name}`,
    sizeBucket: shapes!.sizeBucket,
    fileCountBucket: shapes!.fileCountBucket,
  };
}

const SIZE_LABEL: Record<EnrichmentShapes["sizeBucket"], string> = {
  trivial: "trivial (1-9 lines)",
  small: "small (10-49 lines)",
  medium: "medium (50-249 lines)",
  large: "large (250-999 lines)",
  "very-large": "very-large (1000+ lines)",
};

function formatTaskSize(
  resolution: Resolution,
  shapes: EnrichmentShapes | undefined,
): string | undefined {
  if (resolution.status === "skipped") {
    return undefined;
  }
  if (resolution.status === "unresolved") {
    return `unresolved (${resolution.reason})`;
  }
  const { owner, name } = resolution.repo;
  return `${SIZE_LABEL[shapes!.sizeBucket]}, ${shapes!.fileCountBucket} files (PR #${resolution.prNumber} in ${owner}/${name})`;
}

export type { ReasoningEffort };
