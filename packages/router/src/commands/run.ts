import { randomUUID } from "node:crypto";
import { runCommand as defaultRunCommand, type runCommand } from "../collectors/command-runner.js";
import { redactCollectorText } from "../collectors/normalizer.js";
import { resolveEnrichment, type Resolution } from "../enrich/resolver.js";
import { advisoryMultiplier, toShapes, type EnrichmentShapes } from "../enrich/buckets.js";
import {
  RouterSessionSchema,
  type RouterSession,
  type SessionWorkspace,
} from "../domain/session.js";
import type { SessionRepository } from "../store/session-repository.js";
import { evaluateEligibility } from "../policy/eligibility.js";
import { revalidateDecision } from "../policy/revalidate.js";
import { decideRoute } from "../semantic/decision-engine.js";
import type { TypeSafePort } from "../semantic/typesafe-client.js";
import { formatDecisionCard } from "../presentation/decision-card.js";
import { formatPoolQuota } from "../presentation/quota.js";
import { launchRoutedAgent } from "../launch/herdr-launcher.js";
import type { HerdrClient, HerdrPaneClient } from "../launch/herdr-client.js";
import { buildHandoff, formatHandoffPrompt } from "../handoff/handoff-builder.js";
import type { Account } from "../domain/account.js";
import type { ModelProfile } from "../domain/model-profile.js";
import type { UsageSnapshot } from "../domain/usage.js";
import type { ReasoningEffort } from "../domain/model-profile.js";
import { estimateTaskCostRatio, TASK_BASELINE_RATIO } from "../policy/cost-estimator.js";
import { ReservationService } from "../reservations/reservation-service.js";
import { readSharedActivity } from "../activity/activity-service.js";
import type { CoordinatorClient } from "../activity/coordinator-client.js";
import { cacheAffinityKey } from "../sessions/cache-affinity.js";
import { remainingRatio } from "../policy/quota.js";
import type { EffortChangeRepository } from "../store/effort-change-repository.js";
import { taskUnlocksTopTier } from "../live-effort/levels.js";
import {
  continueInPlace,
  inheritTopTier,
  planInPlace,
  type InPlaceOutcome,
} from "../live-effort/in-place.js";
import {
  createGitRunner,
  createWorktree,
  inspectSourceCheckout,
  planWorktree,
  recheckSourceCheckout,
  validateWorkspace,
  type GitRunner,
  type SourceCheckout,
  type WorktreePlan,
} from "../workspace/git-worktree.js";

export interface RunDeps {
  accounts: Account[];
  models: ModelProfile[];
  usage: Record<string, UsageSnapshot>;
  client: TypeSafePort;
  env: NodeJS.Dict<string>;
  /** Parent env for the resolver, which allowlists it again. Never used for launch. */
  enrichEnv?: NodeJS.Dict<string>;
  now?: Date;
  reservations?: ReservationService;
  herdr?: HerdrClient;
  existingLaunchToken?: string;
  existingPaneId?: string;
  activityClient?: CoordinatorClient;
  sessions?: Pick<SessionRepository, "save" | "get" | "latestForPane">;
  /** Where the TypeSafe key was looked for, when none was found. */
  typesafeKeyHint?: string;
  /** Subprocess runner, injected for tests. */
  runCommand?: typeof runCommand;
  /** Persistent config switch; either this or `options.noEnrich` disables enrichment. */
  enrichmentEnabled?: boolean;
  /** Directory `router run` was started from; `--worktree` branches from it. Default: cwd. */
  cwd?: string;
  /** Parent directory for worktrees created by `--worktree`; must be outside the checkout. */
  worktreeRoot?: string;
  /** Git runner for `--worktree` and isolated continuations, injected for tests. */
  git?: GitRunner;
  /** `config.json` `liveEffort.enabled`: continue a phase in the same pane when possible. */
  liveEffortEnabled?: boolean;
  /** Pane control for in-place continuation; present inside Herdr. */
  herdrPane?: HerdrPaneClient;
  effortChanges?: Pick<
    EffortChangeRepository,
    "record" | "tryLock" | "unlock" | "agentSwitchStats"
  >;
  /** The caller's allowlisted variables (`liveEffortCallerEnv`). Never passed to a launch. */
  callerEnv?: NodeJS.Dict<string>;
  sleep?: (ms: number) => Promise<void>;
  switchTimeoutMs?: number;
}

export interface RunOptions {
  dryRun: boolean;
  previousSessionId?: string;
  noEnrich?: boolean;
  /** Create a Git worktree and launch the agent in it (`router run --worktree`). */
  worktree?: boolean;
}

/** What `--worktree`, or a continued isolated session, does with the workspace. */
type WorkspaceIntent =
  | { action: "create"; source: SourceCheckout; plan: WorktreePlan }
  | { action: "reuse"; workspace: SessionWorkspace };

function workspaceFailure(
  error: string,
  workspace?: Record<string, unknown>,
): { output: string; json: unknown; code: number } {
  return {
    code: 2,
    output: error,
    json: { ok: false, error, ...(workspace ? { workspace } : {}) },
  };
}

/**
 * Resolves the workspace before any routing call, so a missing repository, a dirty
 * checkout, or a broken recorded worktree stops the run before TypeSafe, reservations,
 * Herdr, or an agent are involved. Read-only: nothing is created here.
 */
async function prepareWorkspace(
  options: RunOptions,
  previous: RouterSession | undefined,
  deps: RunDeps,
  git: () => GitRunner,
): Promise<
  | { ok: true; intent?: WorkspaceIntent }
  | { ok: false; failure: ReturnType<typeof workspaceFailure> }
> {
  const recorded = previous?.workspace;
  if (previous && recorded?.isolated) {
    const checked = await validateWorkspace(git(), recorded);
    if (!checked.ok) {
      return {
        ok: false,
        failure: workspaceFailure(
          `Cannot continue session ${previous.id} in its isolated worktree: ${checked.error}\n` +
            "Nothing was launched; the router does not fall back to the current directory.",
          workspaceJson(recorded, "reuse", false),
        ),
      };
    }
    return { ok: true, intent: { action: "reuse", workspace: recorded } };
  }
  if (!options.worktree) {
    return { ok: true };
  }
  if (!deps.worktreeRoot) {
    return {
      ok: false,
      failure: workspaceFailure("--worktree is unavailable: no worktree directory is configured."),
    };
  }
  const source = await inspectSourceCheckout(git(), deps.cwd ?? process.cwd());
  if (!source.ok) {
    return { ok: false, failure: workspaceFailure(source.error) };
  }
  const plan = await planWorktree({
    git: git(),
    source,
    root: deps.worktreeRoot,
    now: new Date(),
  });
  if (!plan.ok) {
    return { ok: false, failure: workspaceFailure(plan.error) };
  }
  return { ok: true, intent: { action: "create", source, plan } };
}

function workspaceJson(
  workspace: Pick<SessionWorkspace, "path" | "branch"> & Partial<SessionWorkspace>,
  action: "create" | "reuse",
  created: boolean,
): Record<string, unknown> {
  return {
    isolated: true,
    action,
    created,
    path: workspace.path,
    branch: workspace.branch,
    baseCommit: workspace.baseCommit,
    repository: workspace.repository,
  };
}

function intentJson(intent: WorkspaceIntent): Record<string, unknown> {
  return intent.action === "reuse"
    ? workspaceJson(intent.workspace, "reuse", false)
    : workspaceJson(
        {
          ...intent.plan,
          baseCommit: intent.source.baseCommit,
          repository: {
            gitCommonDir: intent.source.gitCommonDir,
            sourceRoot: intent.source.sourceRoot,
          },
        },
        "create",
        false,
      );
}

function describeWorkspace(
  intent: WorkspaceIntent,
  dryRun: boolean,
  created: SessionWorkspace | undefined,
): string {
  if (intent.action === "reuse") {
    const { path, branch } = intent.workspace;
    return `${dryRun ? "would reuse" : "reused"} worktree ${path} (branch ${branch})`;
  }
  const { source, plan } = intent;
  const from = `${source.baseCommit.slice(0, 12)} (${source.sourceBranch ?? "detached HEAD"}) of ${source.sourceRoot}`;
  return dryRun
    ? `would create worktree ${plan.path} on new branch ${plan.branch} from ${from}`
    : `created worktree ${created?.path ?? plan.path} on branch ${plan.branch} from ${from}`;
}

export async function executeRun(
  task: string,
  options: RunOptions,
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
  let gitRunner: GitRunner | undefined;
  const git = () => (gitRunner ??= deps.git ?? createGitRunner());
  const prepared = await prepareWorkspace(options, previous, deps, git);
  if (!prepared.ok) {
    return prepared.failure;
  }
  const intent = prepared.intent;
  const enrichmentOff = options.noEnrich === true || deps.enrichmentEnabled === false;
  const enrichmentRun =
    intent?.action === "reuse"
      ? (input: Parameters<typeof defaultRunCommand>[0]) =>
          (deps.runCommand ?? defaultRunCommand)({
            ...input,
            cwd: input.cwd ?? intent.workspace.path,
          })
      : (deps.runCommand ?? defaultRunCommand);
  const resolution: Resolution = enrichmentOff
    ? { status: "skipped" }
    : await resolveEnrichment({
        task,
        run: enrichmentRun,
        env: deps.enrichEnv ?? deps.env,
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
        baselineRatio: TASK_BASELINE_RATIO,
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
  // Only the root task can unlock max/ultra; a continued task, which an agent writes, never does.
  const topTierUnlocked = previous
    ? inheritTopTier(previous, (id) => deps.sessions?.get(id))
    : taskUnlocksTopTier(task);
  const decision = await decideRoute({
    task,
    enrichment,
    topTierUnlocked,
    client: deps.client,
    candidates: eligible.map((item) => ({
      opaqueId: item.opaqueId,
      agent: item.model.agent,
      modelId: item.model.id,
      supportedEfforts: item.model.supportedEfforts,
      projectedRemainingRatio: item.projectedRemainingRatio,
      capabilities: item.model.capabilities,
    })),
    // A route whose launch failed must be re-ranked, never reused as sticky.
    previousRoute:
      previous?.route && previous.route.status === "launched"
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
  // A `--worktree` dry run must not write a reservation, even one released immediately, so
  // it runs the same capacity test read-only. Other dry runs keep their reserve-and-release.
  const reservation =
    options.dryRun && intent
      ? undefined
      : reservations.tryCreate({
          accountId: selected.account.id,
          ratio: selected.estimatedCostRatio,
          ttlMs: 60_000,
          maxTotalRatio,
        });
  const capacityOk = reservation
    ? true
    : options.dryRun && intent
      ? reservations.wouldFit({
          accountId: selected.account.id,
          ratio: selected.estimatedCostRatio,
          maxTotalRatio,
        })
      : false;
  if (!capacityOk)
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
  // The worktree is created only now, after routing and the reservation succeeded, so a run
  // that cannot launch anyway leaves nothing behind. On failure nothing is launched.
  let workspace = intent?.action === "reuse" ? intent.workspace : undefined;
  if (!options.dryRun && intent?.action === "create") {
    const still = await recheckSourceCheckout(git(), intent.source);
    if (!still.ok) {
      if (reservation) reservations.release(reservation.id);
      return workspaceFailure(still.error, intentJson(intent));
    }
    const created = await createWorktree({
      git: git(),
      source: intent.source,
      plan: intent.plan,
      now: new Date(),
    });
    if (!created.ok) {
      if (reservation) reservations.release(reservation.id);
      const output = `Worktree creation failed; no agent was launched. ${created.error}`;
      return {
        code: 1,
        output,
        json: { ok: false, error: output, workspace: intentJson(intent) },
      };
    }
    workspace = created.workspace;
  }
  if (!options.dryRun && intent?.action === "reuse" && previous) {
    const checked = await validateWorkspace(git(), intent.workspace);
    if (!checked.ok) {
      if (reservation) reservations.release(reservation.id);
      return workspaceFailure(
        `Cannot continue session ${previous.id} in its isolated worktree: ${checked.error}\n` +
          "Nothing was launched; the router does not fall back to the current directory.",
        workspaceJson(intent.workspace, "reuse", false),
      );
    }
  }
  // Recorded launches get their session id up front so the agent can route the next phase.
  const sessionId = !options.dryRun && deps.sessions ? `sess_${randomUUID()}` : undefined;
  const handoffPrompt = formatHandoffPrompt(
    handoff,
    sessionId
      ? {
          sessionId,
          previous: previous
            ? { sessionId: previous.id, phase: previous.phase, task: previous.task }
            : undefined,
          workspace: workspace ? { path: workspace.path, branch: workspace.branch } : undefined,
        }
      : undefined,
  );
  const liveEffortReady = Boolean(
    deps.liveEffortEnabled && deps.herdr && deps.herdrPane && deps.effortChanges,
  );
  const inPlace = planInPlace({
    enabled: liveEffortReady,
    previous,
    accountId: selected.account.id,
    modelId: selected.model.id,
    effort: decision.effort,
    creatingWorktree: intent?.action === "create",
    ...(previous?.paneId && deps.sessions
      ? { latestForPane: deps.sessions.latestForPane(previous.paneId) }
      : {}),
    // The launch env drops agent markers; the caller's allowlisted variables carry them.
    env: { ...deps.env, ...deps.callerEnv },
  });
  let inPlaceOutcome: InPlaceOutcome | undefined;
  if (inPlace.ok && !options.dryRun && sessionId) {
    inPlaceOutcome = await continueInPlace({
      plan: inPlace.plan,
      handoffPrompt,
      herdr: deps.herdr!,
      pane: deps.herdrPane!,
      effortChanges: deps.effortChanges!,
      stillCurrent: () => deps.sessions?.latestForPane(inPlace.plan.paneId)?.id === previous?.id,
      // Released below, once the new session that now owns the pane is saved.
      holdLock: true,
      callerEnv: deps.callerEnv ?? deps.env,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.switchTimeoutMs ? { switchTimeoutMs: deps.switchTimeoutMs } : {}),
    });
  }
  const continuedInPlace = inPlace.ok && inPlaceOutcome?.ok === true;
  // The handoff may already be running in the old pane; a new pane would duplicate it.
  const unconfirmedInPlace =
    inPlace.ok && inPlaceOutcome?.ok === false && inPlaceOutcome.noFallback === true;
  const launch = unconfirmedInPlace
    ? {
        ok: false,
        paneCreated: false,
        paneId: inPlace.plan.paneId,
        agentName: inPlace.plan.agentName,
        launchToken: previous?.route?.launchToken,
        printed: undefined,
        error:
          `Sent the next phase to ${inPlace.plan.agentName} in pane ${inPlace.plan.paneId}, ` +
          "but could not confirm it started. Check that pane before retrying; no new pane was opened.",
      }
    : continuedInPlace
      ? {
          ok: true,
          paneCreated: false,
          paneId: inPlace.plan.paneId,
          agentName: inPlace.plan.agentName,
          launchToken: previous?.route?.launchToken,
          printed: inPlaceMessage({
            plan: inPlace.plan,
            phase: decision.phase,
            turnBreak: inPlaceOutcome?.ok === true && inPlaceOutcome.turnBreak,
            handoffPrompt,
          }),
          error: undefined,
        }
      : await launchRoutedAgent({
          env: deps.env,
          agent: selected.model.agent,
          launchName: selected.model.launchName,
          effort: decision.effort,
          handoff: handoffPrompt,
          dryRun: options.dryRun,
          herdr: deps.herdr,
          existingLaunchToken: deps.existingLaunchToken,
          existingPaneId: deps.existingPaneId,
          // An isolated run always launches in its worktree, never in the caller's directory.
          ...(workspace ? { cwd: workspace.path } : {}),
        });
  // An unconfirmed handoff may be running in the old pane, so its reservation is kept.
  if (reservation && (options.dryRun || (!launch.ok && !unconfirmedInPlace))) {
    reservations.release(reservation.id);
  }
  // The pane lock held by an in-place handover is released once the new session that owns
  // the pane is recorded, or if recording it throws.
  try {
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
          // An unconfirmed handoff most likely reached the pane, which is live either way: the
          // agent there must be able to use this session.
          status: launch.ok || unconfirmedInPlace ? "launched" : "launch-failed",
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
        reservations: reservation
          ? [
              {
                id: reservation.id,
                accountId: reservation.accountId,
                ratio: reservation.ratio,
                createdAt: startedAt,
                expiresAt: new Date(reservation.expiresAt).toISOString(),
              },
            ]
          : [],
        handoffs: [handoff],
        paneId: launch.paneId,
        workspace,
        topTierUnlocked,
        ...(continuedInPlace || unconfirmedInPlace
          ? {
              continuation: "in-place",
              liveEffort:
                inPlaceOutcome?.switched?.status === "failed" ? undefined : decision.effort,
            }
          : {}),
        // A refused switch marks the chain so later phases open a new pane without retrying.
        ...(inPlaceOutcome?.ok === false &&
        inPlaceOutcome.switched?.status === "failed" &&
        inPlaceOutcome.switched.unsupported
          ? { liveSwitchUnsupported: true }
          : {}),
        createdAt: startedAt,
        updatedAt: startedAt,
      });
      deps.sessions.save(session);
      const switched = inPlaceOutcome?.switched;
      if (switched && deps.effortChanges && previous) {
        // The switch happened in the previous session's pane. When the handover then fell
        // back to a new pane, that pane (and its session) is the one now at the new level.
        const paneOwner = continuedInPlace || unconfirmedInPlace ? sessionId : previous.id;
        if (paneOwner === previous.id) {
          deps.sessions.save({
            // Fresh: the previous session may have changed while this run was routing.
            ...(deps.sessions.get(previous.id) ?? previous),
            ...(switched.status === "applied" ? { liveEffort: switched.to } : {}),
            // A no-change read the pane's real level, which may correct a stale record.
            ...(switched.status === "no-change" ? { liveEffort: switched.from } : {}),
            ...(switched.status === "failed" && switched.unsupported
              ? { liveSwitchUnsupported: true }
              : {}),
            updatedAt: startedAt,
          });
        }
        deps.effortChanges.record({
          sessionId: paneOwner,
          source: "phase-boundary",
          from: switched.from,
          to: switched.to,
          status: switched.status,
          reason: switched.status === "applied" ? "switched" : switched.reason,
          turnBreak: switched.status === "applied" && switched.turnBreak,
          createdAt: startedAt,
        });
      }
    }
  } finally {
    inPlaceOutcome?.release?.();
  }
  const snapshot = deps.usage[selected.account.id];
  const card = formatDecisionCard({
    selected: `${selected.model.agent} / ${selected.model.launchName} / ${decision.effort}`,
    phase: decision.phase,
    taskSize: formatTaskSize(resolution),
    why: decision.reason,
    previousSession: previous
      ? `${previous.id} (${previous.phase} -> ${decision.phase})`
      : undefined,
    workspace: intent ? describeWorkspace(intent, options.dryRun, workspace) : undefined,
    continuation: describeContinuation({
      enabled: liveEffortReady,
      previous: Boolean(previous),
      inPlace,
      outcome: inPlaceOutcome,
      dryRun: options.dryRun,
    }),
    sharedActivity:
      ownerMessages.get(selected.account.id) ??
      (selected.account.ownership === "shared" && !deps.activityClient
        ? "shared subscription currently active"
        : undefined),
    reservePolicy:
      selected.account.ownership === "shared"
        ? `${Math.round(selected.account.reserveFloor * 100)}% protected`
        : "personal account",
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
  const workspaceNote =
    workspace && !launch.ok
      ? intent?.action === "create"
        ? `\nLaunch failed after the worktree was created. The worktree was kept, not deleted: ${workspace.path} (branch ${workspace.branch}).`
        : `\nLaunch failed; the recorded worktree is unchanged: ${workspace.path} (branch ${workspace.branch}).`
      : "";
  return {
    code: launch.ok ? 0 : 1,
    output: `${card}\n${launch.printed ?? launch.error ?? ""}${workspaceNote}`,
    json: {
      ok: launch.ok,
      selected: selected.opaqueId,
      effort: decision.effort,
      dryRun: options.dryRun,
      launchToken: launch.launchToken,
      paneId: launch.paneId,
      agentName: launch.agentName,
      sessionId,
      ...(liveEffortReady && previous
        ? {
            continuation:
              (continuedInPlace || unconfirmedInPlace) && inPlace.ok
                ? {
                    mode: "in-place",
                    // What the switcher observed in the pane, which the record may lag.
                    from: inPlaceOutcome?.switched?.from ?? inPlace.plan.from,
                    to: decision.effort,
                    turnBreak: inPlaceOutcome?.ok === true && inPlaceOutcome.turnBreak,
                    ...(unconfirmedInPlace ? { unconfirmed: true } : {}),
                    // From inside that pane the agent continues on its own, with this handoff.
                    ...(inPlace.plan.callerIsTarget ? { self: true, handoff: handoffPrompt } : {}),
                  }
                : options.dryRun && inPlace.ok
                  ? {
                      mode: "in-place",
                      from: inPlace.plan.from,
                      to: decision.effort,
                      turnBreak: false,
                      dryRun: true,
                    }
                  : {
                      mode: "new-pane",
                      reason: inPlace.ok
                        ? inPlaceOutcome?.ok === false
                          ? inPlaceOutcome.reason
                          : undefined
                        : inPlace.reason,
                    },
          }
        : {}),
      enrichment: enrichmentJson(resolution),
      ...(intent
        ? {
            ...(launch.ok ? {} : { error: launch.error }),
            workspace: workspace
              ? workspaceJson(workspace, intent.action, intent.action === "create")
              : intentJson(intent),
          }
        : {}),
    },
  };
}

function describeContinuation(input: {
  enabled: boolean;
  previous: boolean;
  inPlace: ReturnType<typeof planInPlace>;
  outcome: InPlaceOutcome | undefined;
  dryRun: boolean;
}): string | undefined {
  if (!input.enabled || !input.previous) return undefined;
  if (!input.inPlace.ok) return `new pane (${input.inPlace.reason})`;
  const { plan } = input.inPlace;
  // The level the switcher saw in the pane when it ran; the record otherwise.
  const from = input.outcome?.switched?.from ?? plan.from;
  const effort = from === plan.to ? `effort ${plan.to} unchanged` : `effort ${from} -> ${plan.to}`;
  if (input.dryRun) return `would continue in place (pane ${plan.paneId}), ${effort}`;
  if (input.outcome?.ok) return `in place (pane ${plan.paneId}), ${effort}`;
  if (input.outcome?.noFallback) {
    return `in place (pane ${plan.paneId}), ${effort}; handoff sent but not confirmed`;
  }
  return `new pane (in-place continuation failed: ${input.outcome?.reason ?? "unknown"})`;
}

function inPlaceMessage(input: {
  plan: { paneId: string; agentName: string; to: string; callerIsTarget: boolean };
  phase: string;
  turnBreak: boolean;
  handoffPrompt: string;
}): string {
  if (!input.plan.callerIsTarget) {
    return `Sent the next phase to ${input.plan.agentName} in pane ${input.plan.paneId} at effort ${input.plan.to}.`;
  }
  if (input.turnBreak) {
    return (
      `Next phase queued in this session at effort ${input.plan.to}; it starts when your turn ends.\n` +
      "End your turn now with a one-line status."
    );
  }
  return `Continue in this session: phase ${input.phase}, effort now ${input.plan.to}.\n\n${input.handoffPrompt}`;
}

function enrichmentJson(resolution: Resolution): Record<string, unknown> {
  if (resolution.status === "skipped") {
    return { status: "skipped" };
  }
  if (resolution.status === "unresolved") {
    return { status: "unresolved", reason: resolution.reason };
  }
  const shapes = toShapes(resolution);
  return {
    status: "resolved",
    prNumber: resolution.prNumber,
    repo: `${resolution.repo.owner}/${resolution.repo.name}`,
    sizeBucket: shapes.sizeBucket,
    fileCountBucket: shapes.fileCountBucket,
    advisoryMultiplier: advisoryMultiplier(shapes.sizeBucket),
  };
}

const SIZE_LABEL: Record<EnrichmentShapes["sizeBucket"], string> = {
  trivial: "trivial (1-9 lines)",
  small: "small (10-49 lines)",
  medium: "medium (50-249 lines)",
  large: "large (250-999 lines)",
  "very-large": "very-large (1000+ lines)",
};

function formatTaskSize(resolution: Resolution): string | undefined {
  if (resolution.status === "skipped") {
    return undefined;
  }
  if (resolution.status === "unresolved") {
    return `unresolved (${resolution.reason})`;
  }
  const shapes = toShapes(resolution);
  // S3's charset check on owner and name is enforced at ingress by `parsePrUrl` in
  // `enrich/resolver.ts`, whose `PR_URL` regex is the only source of these values, so
  // there is no resolution that could reach this line with a repo to omit.
  const { owner, name } = resolution.repo;
  const files = shapes.fileCountBucket === "1" ? "file" : "files";
  return `${SIZE_LABEL[shapes.sizeBucket]}, ${shapes.fileCountBucket} ${files} (PR #${resolution.prNumber} in ${owner}/${name})`;
}

export type { ReasoningEffort };
