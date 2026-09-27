import { randomUUID } from "node:crypto";
import type { ReasoningEffort } from "../domain/model-profile.js";
import type { RouterSession } from "../domain/session.js";
import type { HerdrClient, HerdrPaneClient } from "../launch/herdr-client.js";
import type { EffortChangeRepository } from "../store/effort-change-repository.js";
import { isTopTier, LIVE_EFFORT_MODELS, runsInsideAgent, taskUnlocksTopTier } from "./levels.js";
import {
  DEFAULT_SWITCH_TIMEOUT_MS,
  switchEffort,
  type SwitchAgent,
  type SwitchResult,
} from "./switcher.js";

export interface InPlacePlan {
  paneId: string;
  agentName: string;
  agent: SwitchAgent;
  from: ReasoningEffort;
  to: ReasoningEffort;
  callerIsTarget: boolean;
}

/**
 * Whether the next phase can continue in the previous session's pane: the same account
 * and model won, the pane is recorded, and nothing rules the switch out. Read-only.
 */
export function planInPlace(input: {
  enabled: boolean;
  previous?: RouterSession;
  accountId: string;
  modelId: string;
  effort: ReasoningEffort;
  creatingWorktree: boolean;
  /** The newest session recorded for the previous session's pane, if any. */
  latestForPane?: RouterSession;
  env: NodeJS.Dict<string>;
}): { ok: true; plan: InPlacePlan } | { ok: false; reason: string } {
  const previous = input.previous;
  const route = previous?.route;
  if (!input.enabled) return { ok: false, reason: "disabled" };
  if (!previous || !route || route.status !== "launched" || !previous.paneId || !route.agentName) {
    return { ok: false, reason: "no-live-pane" };
  }
  if (route.accountId !== input.accountId || route.modelId !== input.modelId) {
    return { ok: false, reason: "different-route" };
  }
  if (!LIVE_EFFORT_MODELS.has(input.modelId)) return { ok: false, reason: "model-not-live" };
  if (previous.liveSwitchUnsupported) return { ok: false, reason: "unsupported" };
  // A new worktree means a new working directory, which an existing pane cannot move to.
  if (input.creatingWorktree) return { ok: false, reason: "new-worktree" };
  // A newer phase already continued in this pane; its record, not this one, is current.
  if (input.latestForPane && input.latestForPane.id !== previous.id) {
    return { ok: false, reason: "superseded-session" };
  }
  const samePane = input.env.HERDR_PANE_ID === previous.paneId;
  // An agent may hand a phase only to its own pane; from another agent's pane the handoff
  // would arrive as a user message in a different conversation.
  if (runsInsideAgent(input.env) && !samePane) return { ok: false, reason: "not-caller-pane" };
  const from = previous.liveEffort ?? route.effort;
  // Top-tier levels start only with a new pane (see levels.ts).
  if (input.effort !== from && isTopTier(input.effort)) {
    return { ok: false, reason: "top-tier-requires-new-pane" };
  }
  return {
    ok: true,
    plan: {
      paneId: previous.paneId,
      agentName: route.agentName,
      agent: route.agent as SwitchAgent,
      from,
      to: input.effort,
      // The agent itself, mid-turn: it continues on its own rather than being prompted.
      callerIsTarget: samePane && runsInsideAgent(input.env),
    },
  };
}

export type InPlaceOutcome =
  | {
      ok: true;
      switched?: SwitchResult;
      turnBreak: boolean;
      /** Set with `holdLock`: releases the pane lock once the caller has recorded the phase. */
      release?: () => void;
    }
  | {
      ok: false;
      reason: string;
      switched?: SwitchResult;
      /** The handoff may have reached the pane, so no new pane may be opened for it. */
      noFallback?: boolean;
      release?: () => void;
    };

const IDLE_WAIT_MS = 30_000;
const PROMPT_WAIT_MS = 30_000;
const CONFIRM_WAIT_MS = 10_000;
const LOCK_MARGIN_MS = 30_000;
/** Herdr error codes for a prompt it rejected before sending anything. */
const PROMPT_REFUSED = /agent_blocked|agent_not_found|agent_not_ready/;
/**
 * The pane lock must outlive the longest hold: the idle wait, a switch (at most four polls
 * of the switch timeout: Claude's slider and outcome, or two Codex bursts, each with a
 * confirming read), the prompt wait and its confirmation, with margin. A lock that expired
 * mid-sequence would let a second caller type into the same pane.
 */
function inPlaceLockTtlMs(switchTimeoutMs: number): number {
  return IDLE_WAIT_MS + 4 * switchTimeoutMs + PROMPT_WAIT_MS + CONFIRM_WAIT_MS + LOCK_MARGIN_MS;
}

/**
 * Hands the next phase to the existing pane, switching effort first when it changes.
 * From inside that pane the agent continues by itself (Codex gets the task queued for its
 * next turn); from anywhere else the router waits for the pane to be idle and prompts it.
 */
export async function continueInPlace(input: {
  plan: InPlacePlan;
  handoffPrompt: string;
  herdr: HerdrClient;
  pane: HerdrPaneClient;
  effortChanges: Pick<EffortChangeRepository, "tryLock" | "unlock">;
  /** Re-checked under the lock: false when another phase took the pane while this waited. */
  stillCurrent?: () => boolean;
  /**
   * Keep the pane lock after a handover (success or unconfirmed) until `release` is called,
   * so the caller can record the new session before another caller sees the pane as free.
   */
  holdLock?: boolean;
  callerEnv: NodeJS.Dict<string>;
  sleep?: (ms: number) => Promise<void>;
  switchTimeoutMs?: number;
}): Promise<InPlaceOutcome> {
  const { plan } = input;
  const holder = `lock_${randomUUID()}`;
  const ttlMs = inPlaceLockTtlMs(input.switchTimeoutMs ?? DEFAULT_SWITCH_TIMEOUT_MS);
  if (!input.effortChanges.tryLock(plan.paneId, holder, Date.now(), ttlMs)) {
    return { ok: false, reason: "switch-in-progress" };
  }
  let held = false;
  const release = () => input.effortChanges.unlock(plan.paneId, holder);
  try {
    if (input.stillCurrent && !input.stillCurrent()) {
      return { ok: false, reason: "superseded-session" };
    }
    if (!plan.callerIsTarget) {
      const idle = await input.herdr.waitFor({
        target: plan.agentName,
        until: ["idle", "done"],
        timeoutMs: IDLE_WAIT_MS,
      });
      if (!idle.ok) return { ok: false, reason: "pane-busy" };
    }
    // Always through the switcher, even when the record says the level is unchanged: it
    // re-checks the pane (agent, blocked, input box) and reads the level back, doing
    // nothing when the pane already agrees.
    const switched = await switchEffort(
      {
        agent: plan.agent,
        paneId: plan.paneId,
        agentName: plan.agentName,
        from: plan.from,
        to: plan.to,
        callerIsTarget: plan.callerIsTarget,
        callerEnv: input.callerEnv,
        // A fixed prefix keeps a task starting with `/`, `!` or `@` from opening a Codex
        // popup instead of being queued.
        ...(plan.callerIsTarget ? { continuation: `Next phase: ${input.handoffPrompt}` } : {}),
      },
      {
        pane: input.pane,
        ...(input.sleep ? { sleep: input.sleep } : {}),
        ...(input.switchTimeoutMs ? { timeoutMs: input.switchTimeoutMs } : {}),
      },
    );
    if (switched.status === "failed") {
      return { ok: false, reason: switched.reason, switched };
    }
    const turnBreak = switched.status === "applied" && switched.turnBreak;
    if (!plan.callerIsTarget) {
      const prompted = await input.herdr.prompt({
        target: plan.agentName,
        text: input.handoffPrompt,
        until: ["working", "blocked"],
        timeoutMs: PROMPT_WAIT_MS,
      });
      if (!prompted.ok) {
        // Herdr refused it outright: nothing was delivered, so a new pane is safe.
        if (PROMPT_REFUSED.test(`${prompted.stdout}${prompted.stderr}`)) {
          return { ok: false, reason: "prompt-refused", switched };
        }
        // A timed-out wait does not mean the prompt was lost; a fast turn can start and end
        // between Herdr's polls. Confirm once more, accepting only a running turn.
        const started = await input.herdr.waitFor({
          target: plan.agentName,
          until: ["working"],
          timeoutMs: CONFIRM_WAIT_MS,
        });
        if (!started.ok) {
          // Possibly delivered: a new pane with the same handoff could duplicate the phase.
          held = input.holdLock === true;
          return {
            ok: false,
            reason: "prompt-unconfirmed",
            switched,
            noFallback: true,
            ...(held ? { release } : {}),
          };
        }
      }
    }
    held = input.holdLock === true;
    return { ok: true, switched, turnBreak, ...(held ? { release } : {}) };
  } finally {
    if (!held) release();
  }
}

/**
 * The top-tier flag for a continued session: inherited from the chain, and for chains
 * recorded before the flag existed, read from the root task. A continued task never sets it.
 */
export function inheritTopTier(
  previous: RouterSession,
  getSession: (id: string) => RouterSession | undefined,
): boolean {
  let current: RouterSession | undefined = previous;
  for (let depth = 0; current && depth < 100; depth += 1) {
    if (current.topTierUnlocked !== undefined) return current.topTierUnlocked;
    if (!current.previousSessionId) return taskUnlocksTopTier(current.task);
    current = getSession(current.previousSessionId);
  }
  return false;
}
