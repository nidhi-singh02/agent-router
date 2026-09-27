import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Account } from "../domain/account.js";
import type { ModelProfile, ReasoningEffort } from "../domain/model-profile.js";
import type { RouterSession } from "../domain/session.js";
import type { UsageSnapshot } from "../domain/usage.js";
import type { HerdrPaneClient } from "../launch/herdr-client.js";
import {
  effortRank,
  isTopTier,
  LIVE_EFFORT_MODELS,
  LIVE_LEVELS,
  runsInsideAgent,
} from "../live-effort/levels.js";
import { toSignalShapes, type Signals } from "../live-effort/signals.js";
import {
  DEFAULT_SWITCH_TIMEOUT_MS,
  switchEffort,
  type SwitchAgent,
  type SwitchResult,
} from "../live-effort/switcher.js";
import { estimateTaskCostRatio, TASK_BASELINE_RATIO } from "../policy/cost-estimator.js";
import { evaluateEligibility } from "../policy/eligibility.js";
import type { ReservationService } from "../reservations/reservation-service.js";
import { effortQuestion } from "../semantic/effort-selector.js";
import { assertSafeState, type TypeSafePort } from "../semantic/typesafe-client.js";
import type {
  EffortChangeRepository,
  EffortChangeSource,
} from "../store/effort-change-repository.js";
import type { SessionRepository } from "../store/session-repository.js";

/** Minimum time between two agent-initiated switches in one session. */
export const EFFORT_COOLDOWN_MS = 5 * 60_000;
/** Agent-initiated switches allowed per session. */
export const EFFORT_SWITCH_CAP = 8;
/** Below this TypeSafe confidence the current level is kept. */
export const EFFORT_MIN_CONFIDENCE = 0.6;
const MANUAL_LOCK_WAIT_MS = 10_000;
/**
 * How long a `router effort` lock lasts: the TypeSafe call (its SDK retries and honors
 * Retry-After, up to about 150 s in the worst case) plus a switch (at most four polls of the
 * switch timeout), with margin. A lock that expired mid-switch would let another caller
 * type into the same pane.
 */
const EFFORT_LOCK_TTL_MS = 150_000 + 4 * DEFAULT_SWITCH_TIMEOUT_MS + 30_000;
const LOCK_RETRY_MS = 500;

export type EffortRequest =
  { kind: "agent"; subStep: string; signals: Signals } | { kind: "manual"; level: ReasoningEffort };

export interface EffortDeps {
  sessions: Pick<SessionRepository, "get" | "save" | "latestForPane">;
  effortChanges: Pick<EffortChangeRepository, "record" | "agentSwitchStats" | "tryLock" | "unlock">;
  pane?: HerdrPaneClient;
  client: TypeSafePort;
  accounts: Account[];
  models: ModelProfile[];
  usage: Record<string, UsageSnapshot>;
  reservations?: Pick<ReservationService, "activeRatio">;
  /** The caller's allowlisted environment (`liveEffortCallerEnv`). */
  env: NodeJS.Dict<string>;
  liveEffortEnabled: boolean;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  switchTimeoutMs?: number;
}

export interface EffortResult {
  code: number;
  output: string;
  json: unknown;
}

type NoChangeReason =
  | "disabled"
  | "not-eligible"
  | "unsupported"
  | "already-at-level"
  | "low-confidence"
  | "cooldown"
  | "switch-cap"
  | "quota"
  | "top-tier-gated"
  | "top-tier-requires-new-pane"
  | "unsupported-effort"
  | "unsafe-state"
  | "not-caller-pane"
  | "not-in-herdr"
  | "superseded-session"
  | "top-tier-held"
  | "typesafe-unavailable";

function finish(input: {
  sessionId: string;
  from: ReasoningEffort;
  to: ReasoningEffort;
  status: "applied" | "no-change" | "failed";
  reason: string;
  turnBreak?: boolean;
}): EffortResult {
  const turnBreak = input.turnBreak ?? false;
  const json = {
    // `ok` means the pane switched; exit 4 (no change) and 5 (failed) are both false.
    ok: input.status === "applied",
    sessionId: input.sessionId,
    from: input.from,
    to: input.to,
    status: input.status,
    reason: input.reason,
    turnBreak,
  };
  if (input.status === "applied") {
    const output = turnBreak
      ? `Effort switched ${input.from} -> ${input.to}; it applies from the next turn.\n` +
        `End your turn now with a one-line status; you will be resumed at ${input.to}.`
      : `Effort switched ${input.from} -> ${input.to} (this session only).\nContinue at ${input.to}.`;
    return { code: 0, output, json };
  }
  if (input.status === "no-change") {
    return {
      code: 4,
      output: `No effort change (${input.reason}).\nContinue at ${input.from}.`,
      json,
    };
  }
  return {
    code: 5,
    output: `Effort switch failed (${input.reason}).\nContinue at ${input.from}.`,
    json,
  };
}

function currentEffort(session: RouterSession): ReasoningEffort {
  return session.liveEffort ?? session.route!.effort;
}

/**
 * `router effort`: changes the reasoning effort of a running Opus 5.5 or GPT 6 Astra pane.
 * An agent passes its sub-step and TypeSafe picks the level; the user passes a level.
 */
export async function executeEffort(
  sessionId: string,
  request: EffortRequest,
  deps: EffortDeps,
): Promise<EffortResult> {
  const now = deps.now ?? (() => new Date());
  const initial = deps.sessions.get(sessionId);
  if (!initial) {
    const output = `Session not found: ${sessionId}`;
    return {
      code: 2,
      output,
      json: { ok: false, sessionId, status: "failed", reason: "unknown-session", error: output },
    };
  }
  if (!initial.route) {
    const output = `Session ${sessionId} has no route.`;
    return {
      code: 2,
      output,
      json: { ok: false, sessionId, status: "failed", reason: "no-route", error: output },
    };
  }
  const requested = request.kind === "manual" ? request.level : undefined;
  const early = (reason: NoChangeReason) => {
    const from = currentEffort(initial);
    return finish({ sessionId, from, to: requested ?? from, status: "no-change", reason });
  };
  if (!deps.liveEffortEnabled) return early("disabled");
  const route = initial.route;
  const model = deps.models.find((item) => item.id === route.modelId);
  const account = deps.accounts.find((item) => item.id === route.accountId);
  const paneId = initial.paneId;
  const agentName = route.agentName;
  if (
    !LIVE_EFFORT_MODELS.has(route.modelId) ||
    route.status !== "launched" ||
    !paneId ||
    !agentName ||
    !model ||
    !account
  ) {
    return early("not-eligible");
  }
  // Pane control exists only inside Herdr (HERDR_ENV=1).
  if (!deps.pane) return early("not-in-herdr");
  // After an in-place continuation the pane belongs to the newest session in its chain;
  // an older id would record switches (and the cooldown) on a session no longer in charge.
  const current = deps.sessions.latestForPane(paneId);
  if (current && current.id !== sessionId) return early("superseded-session");
  // An agent may switch only its own pane: its sub-step text reaches the pane it names,
  // and from any other pane that would be a message to a different agent.
  if (request.kind === "agent" && deps.env.HERDR_PANE_ID !== paneId) {
    return early("not-caller-pane");
  }
  if (request.kind === "manual") {
    if (!model.supportedEfforts.includes(request.level)) return early("unsupported-effort");
    // Top-tier levels start only with a new pane, on both models: Codex reaches them only
    // through its /model picker, which saves the choice as the user's default.
    if (isTopTier(request.level)) return early("top-tier-requires-new-pane");
  }

  // Everything below runs under the pane lock and on a fresh read of the session, so two
  // callers can neither both pass the cooldown nor act on each other's stale level.
  const holder = `lock_${randomUUID()}`;
  const locked = await takeLock(deps, paneId, holder, request.kind === "manual", now);
  if (!locked) {
    const from = currentEffort(initial);
    return finish({
      sessionId,
      from,
      to: requested ?? from,
      status: "failed",
      reason: "switch-in-progress",
    });
  }
  try {
    // Re-checked under the lock: a phase may have continued in place while this call waited.
    const latest = deps.sessions.latestForPane(paneId);
    if (latest && latest.id !== sessionId) {
      const from = currentEffort(initial);
      return finish({
        sessionId,
        from,
        to: requested ?? from,
        status: "no-change",
        reason: "superseded-session",
      });
    }
    const session = deps.sessions.get(sessionId) ?? initial;
    const from = currentEffort(session);
    const noChange = (reason: NoChangeReason, to: ReasoningEffort = requested ?? from) =>
      finish({ sessionId, from, to, status: "no-change", reason });
    if (session.liveSwitchUnsupported) return noChange("unsupported");

    let to: ReasoningEffort;
    let confidence: number | undefined;
    let shapes: ReturnType<typeof toSignalShapes> | undefined;
    if (request.kind === "manual") {
      to = request.level;
    } else {
      // A top-tier level was the user's choice; sub-step switches only reach xhigh, so they
      // would always lower it.
      if (isTopTier(from)) return noChange("top-tier-held");
      const limited = agentSwitchLimit(deps, sessionId, now);
      if (limited) return noChange(limited);
      shapes = toSignalShapes(request.signals);
      const state = {
        subStep: request.subStep,
        phase: session.phase,
        currentEffort: from,
        signals: shapes,
      };
      try {
        assertSafeState(state);
      } catch {
        return noChange("unsafe-state");
      }
      // Sub-step switches stay below the top tier on both models (see levels.ts).
      const allowed = model.supportedEfforts.filter((effort) => LIVE_LEVELS.includes(effort));
      let answer;
      try {
        const response = await deps.client.systemOne({
          state,
          questions: { effort: effortQuestion(allowed, false) },
        });
        answer = response.answers.effort;
      } catch {
        return noChange("typesafe-unavailable");
      }
      to = answer.choice as ReasoningEffort;
      confidence = answer.confidence;
      if (!allowed.includes(to)) return noChange("top-tier-gated", from);
      if (to !== from && answer.confidence < EFFORT_MIN_CONFIDENCE) {
        return noChange("low-confidence", to);
      }
    }

    // A raise the quota refuses stops here, before the pane is touched; the switcher checks
    // again against the level it reads from the pane, which the record may lag.
    if (effortRank(to) > effortRank(from) && !quotaAllowsUpShift(account, model, deps, now())) {
      return noChange("quota", to);
    }
    // Even when the record already says `to`, the switcher runs: it re-checks the pane
    // (agent, blocked, input box) and, for Codex, reads the level from the status line.
    // For Claude it trusts CLAUDE_EFFORT when the agent calls, else the record.
    const result = await switchEffort(
      {
        agent: route.agent as SwitchAgent,
        paneId,
        agentName,
        from,
        to,
        callerIsTarget: deps.env.HERDR_PANE_ID === paneId && runsInsideAgent(deps.env),
        rules: {
          holdTopTier: request.kind === "agent",
          allowRaiseFrom: () => quotaAllowsUpShift(account, model, deps, now()),
        },
        callerEnv: deps.env,
        ...(request.kind === "agent"
          ? { continuation: `Continue with the sub-step: ${request.subStep}` }
          : {}),
      },
      {
        pane: deps.pane,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        ...(deps.switchTimeoutMs ? { timeoutMs: deps.switchTimeoutMs } : {}),
      },
    );
    // Recorded before the lock is released, so the next caller's cooldown check sees it.
    return recordSwitch({ session, source: request.kind, result, confidence, shapes, deps, now });
  } finally {
    deps.effortChanges.unlock(paneId, holder);
  }
}

function agentSwitchLimit(
  deps: Pick<EffortDeps, "effortChanges">,
  sessionId: string,
  now: () => Date,
): "switch-cap" | "cooldown" | undefined {
  const { count, lastAt } = deps.effortChanges.agentSwitchStats(sessionId);
  if (count >= EFFORT_SWITCH_CAP) return "switch-cap";
  if (lastAt && now().getTime() - Date.parse(lastAt) < EFFORT_COOLDOWN_MS) {
    return "cooldown";
  }
  return undefined;
}

export function recordSwitch(input: {
  session: RouterSession;
  source: EffortChangeSource;
  result: SwitchResult;
  confidence?: number;
  shapes?: object;
  deps: Pick<EffortDeps, "sessions" | "effortChanges">;
  now: () => Date;
}): EffortResult {
  const { session, result } = input;
  const reason = result.status === "applied" ? "switched" : result.reason;
  const status = result.status;
  input.deps.effortChanges.record({
    sessionId: session.id,
    source: input.source,
    from: result.from,
    to: result.to,
    status,
    reason,
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    ...(input.shapes ? { signals: input.shapes as Record<string, unknown> } : {}),
    turnBreak: result.status === "applied" && result.turnBreak,
    createdAt: input.now().toISOString(),
  });
  const updatedAt = input.now().toISOString();
  if (result.status === "applied" || result.status === "no-change") {
    input.deps.sessions.save({
      ...session,
      liveEffort: result.status === "applied" ? result.to : result.from,
      updatedAt,
    });
  } else if (result.unsupported) {
    input.deps.sessions.save({ ...session, liveSwitchUnsupported: true, updatedAt });
  }
  return finish({
    sessionId: session.id,
    from: result.from,
    to: result.to,
    status,
    reason,
    turnBreak: result.status === "applied" && result.turnBreak,
  });
}

async function takeLock(
  deps: EffortDeps,
  lockKey: string,
  holder: string,
  wait: boolean,
  now: () => Date,
): Promise<boolean> {
  const sleep = deps.sleep ?? delay;
  // Bounded by attempts as well as time, so a stopped clock cannot spin forever.
  const attempts = wait ? MANUAL_LOCK_WAIT_MS / LOCK_RETRY_MS : 0;
  const deadline = now().getTime() + (wait ? MANUAL_LOCK_WAIT_MS : 0);
  for (let attempt = 0; ; attempt += 1) {
    if (deps.effortChanges.tryLock(lockKey, holder, now().getTime(), EFFORT_LOCK_TTL_MS)) {
      return true;
    }
    if (attempt >= attempts || now().getTime() >= deadline) return false;
    await sleep(LOCK_RETRY_MS);
  }
}

/** Raising effort costs more quota, so the account must still pass the routing rules. */
export function quotaAllowsUpShift(
  account: Account,
  model: ModelProfile,
  deps: Pick<EffortDeps, "usage" | "reservations">,
  now: Date,
): boolean {
  const usage = deps.usage[account.id];
  if (!usage) {
    return account.ownership === "personal";
  }
  const result = evaluateEligibility({
    account,
    model,
    usage: {
      ...usage,
      activeReservationRatio:
        usage.activeReservationRatio + (deps.reservations?.activeRatio(account.id) ?? 0),
    },
    estimatedCostRatio: estimateTaskCostRatio({
      relativeQuotaCost: model.relativeQuotaCost,
      baselineRatio: TASK_BASELINE_RATIO,
    }),
    now,
  });
  return result.eligible;
}
