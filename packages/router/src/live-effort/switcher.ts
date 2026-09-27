import { setTimeout as delay } from "node:timers/promises";
import { ReasoningEffortSchema, type ReasoningEffort } from "../domain/model-profile.js";
import { herdrAgentKind } from "../launch/agent-command.js";
import type { HerdrAgentInfo, HerdrPaneClient } from "../launch/herdr-client.js";
import { effortRank, isTopTier, LIVE_LEVELS } from "./levels.js";
import {
  claudeCacheWarningOpen,
  codexInPlanMode,
  codexStatusEffort,
  footerLines,
  inputLineState,
  inputLineText,
  inVimNormalMode,
  newClaudeOutcome,
} from "./pane-text.js";

export type SwitchAgent = "claude-code" | "codex";

export type SwitchFailure =
  | "pane-drift"
  | "pane-blocked"
  | "pane-input-busy"
  | "codex-plan-mode"
  | "top-tier-requires-new-pane"
  | "slider-not-opened"
  | "cache-warning"
  | "saved-default"
  | "effort-capped"
  | "verify-mismatch"
  | "verify-timeout"
  | "send-failed";

export type SwitchResult =
  | { status: "applied"; from: ReasoningEffort; to: ReasoningEffort; turnBreak: boolean }
  | {
      status: "no-change";
      from: ReasoningEffort;
      to: ReasoningEffort;
      reason: "already-at-level" | "top-tier-held" | "quota";
    }
  | {
      status: "failed";
      from: ReasoningEffort;
      to: ReasoningEffort;
      reason: SwitchFailure;
      /** The agent refused in-place switching; later switches on this chain are skipped. */
      unsupported?: boolean;
    };

export interface SwitchInput {
  agent: SwitchAgent;
  paneId: string;
  agentName: string;
  /** The level the router last recorded for this pane. */
  from: ReasoningEffort;
  to: ReasoningEffort;
  /** The switch was requested from inside the target pane (the agent itself). */
  callerIsTarget: boolean;
  /** The caller's allowlisted environment; `CLAUDE_EFFORT` is the calling Claude agent's level. */
  callerEnv: NodeJS.Dict<string>;
  /**
   * Codex only: text queued with Tab when the pane is mid-turn, so the next turn (which is
   * the first to use the new level) starts on its own. Claude applies mid-turn and ignores it.
   */
  continuation?: string;
  /**
   * Rules checked against the level actually read from the pane, which the router's record
   * may lag (the user can change it in the TUI): keep a top-tier level, and allow a raise
   * only when quota permits.
   */
  rules?: {
    holdTopTier?: boolean;
    allowRaiseFrom?: (observed: ReasoningEffort) => boolean;
  };
}

export interface SwitcherDeps {
  pane: HerdrPaneClient;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the TUI to show the result. */
  timeoutMs?: number;
  pollMs?: number;
}

/** Whether Herdr still reports the recorded agent, of the recorded kind, in the recorded pane. */
export function paneHoldsAgent(
  info: HerdrAgentInfo | undefined,
  paneId: string,
  agent: SwitchAgent,
): boolean {
  return info !== undefined && info.paneId === paneId && info.agent === herdrAgentKind(agent);
}

/** Text safe to type into a TUI: control characters become spaces, on one line. */
export function plainLine(text: string): string {
  return text.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;

/** `CLAUDE_EFFORT`, which Claude Code sets for its Bash tool: the calling agent's own level. */
export function callerClaudeEffort(env: NodeJS.Dict<string>): ReasoningEffort | undefined {
  const parsed = ReasoningEffortSchema.safeParse(env.CLAUDE_EFFORT);
  return parsed.success ? parsed.data : undefined;
}

/** How long to wait for a TUI to show a switch's result. */
export const DEFAULT_SWITCH_TIMEOUT_MS = 5_000;
/** Codex bursts sent at most: the first, and one retry when it changed nothing. */
const CODEX_ATTEMPTS = 2;
const VISIBLE_LINES = 40;
const RECENT_LINES = 200;

function failed(
  input: Pick<SwitchInput, "from" | "to">,
  reason: SwitchFailure,
  options: { unsupported?: boolean } = {},
): SwitchResult {
  return {
    status: "failed",
    from: input.from,
    to: input.to,
    reason,
    ...(options.unsupported ? { unsupported: true } : {}),
  };
}

/**
 * Changes the reasoning effort of a running Opus 5.5 or GPT 6 Astra pane without touching
 * the user's saved defaults, then confirms the change on screen. Never confirms a dialog,
 * never clears the user's input, and never assumes a switch worked.
 */
export async function switchEffort(input: SwitchInput, deps: SwitcherDeps): Promise<SwitchResult> {
  const sleep = deps.sleep ?? delay;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SWITCH_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? 250;
  const fail = (reason: SwitchFailure) => failed(input, reason);

  // Reaching a top-tier level needs a new pane; staying at one (to === from) is fine.
  const topTierMove = (observed: ReasoningEffort) => observed !== input.to && isTopTier(input.to);
  const info = await deps.pane.getAgent(input.agentName);
  if (!info || !paneHoldsAgent(info, input.paneId, input.agent)) {
    return fail("pane-drift");
  }
  if (info.status === "blocked") {
    return fail("pane-blocked");
  }
  const screen = await deps.pane.readPane(input.paneId, {
    source: "visible",
    lines: VISIBLE_LINES + 20,
    ansi: true,
  });
  if (screen === undefined) {
    return fail("pane-drift");
  }
  if (
    inputLineState(input.agent === "claude-code" ? "claude" : "codex", screen) !== "empty" ||
    inVimNormalMode(screen)
  ) {
    return fail("pane-input-busy");
  }

  if (input.agent === "codex") {
    if (codexInPlanMode(screen)) {
      return fail("codex-plan-mode");
    }
    const observed = codexStatusEffort(screen);
    if (!observed) {
      // Without the status line there is no way to confirm a switch, so none is attempted.
      return fail("verify-timeout");
    }
    const held = heldByRules(input, observed);
    if (held) return held;
    if (topTierMove(observed)) {
      return fail("top-tier-requires-new-pane");
    }
    // The agent calling on itself is mid-turn by definition, whatever Herdr's status says.
    const midTurn = info.status === "working" || input.callerIsTarget;
    return switchCodex({ ...input, from: observed }, midTurn, deps.pane, {
      sleep,
      timeoutMs,
      pollMs,
    });
  }

  // Only the calling agent's own CLAUDE_EFFORT is live. The transcript records the level of
  // the last request, which lags a switch made on an idle pane, so it is not trusted.
  // Only the calling agent's CLAUDE_EFFORT is a reading of the pane. Otherwise the record
  // stands in for the level, but it can lag (an earlier unconfirmed switch, a change made in
  // the TUI), so it never short-circuits a switch: the slider moves to an absolute position.
  const reported = input.callerIsTarget ? callerClaudeEffort(input.callerEnv) : undefined;
  const observed = reported ?? input.from;
  const held = heldByRules(input, observed, reported !== undefined);
  if (held) return held;
  if (topTierMove(observed)) {
    return fail("top-tier-requires-new-pane");
  }
  return switchClaude({ ...input, from: observed }, deps.pane, { sleep, timeoutMs, pollMs });
}

function heldByRules(
  input: SwitchInput,
  observed: ReasoningEffort,
  confirmed = true,
): SwitchResult | undefined {
  const hold = (reason: "already-at-level" | "top-tier-held" | "quota"): SwitchResult => ({
    status: "no-change",
    from: observed,
    to: input.to,
    reason,
  });
  if (confirmed && observed === input.to) return hold("already-at-level");
  if (input.rules?.holdTopTier && isTopTier(observed)) return hold("top-tier-held");
  if (
    effortRank(input.to) > effortRank(observed) &&
    input.rules?.allowRaiseFrom &&
    !input.rules.allowRaiseFrom(observed)
  ) {
    return hold("quota");
  }
  return undefined;
}

interface Timing {
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
}

/** Checks until a value appears, bounded by both attempts and wall-clock time. */
async function poll<T>(
  timing: Timing,
  check: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const attempts = Math.max(1, Math.ceil(timing.timeoutMs / timing.pollMs));
  const deadline = Date.now() + timing.timeoutMs;
  for (let attempt = 1; ; attempt += 1) {
    const value = await check();
    if (value !== undefined) return value;
    if (attempt >= attempts || Date.now() >= deadline) return undefined;
    await timing.sleep(timing.pollMs);
  }
}

/**
 * Claude Code: `/effort` opens a slider that starts at the current level; left and right
 * move it and `s` applies the level to this session only. Typing `/effort <level>` would
 * instead save the level as the user's default for every new session.
 */
async function switchClaude(
  input: SwitchInput,
  pane: HerdrPaneClient,
  timing: Timing,
): Promise<SwitchResult> {
  const target = LIVE_LEVELS.indexOf(input.to);
  const fail = (reason: SwitchFailure, unsupported = false) =>
    failed(input, reason, { unsupported });
  // Without a baseline an old outcome line could read as new, so nothing is typed.
  const before = await pane.readPane(input.paneId, { source: "recent", lines: RECENT_LINES });
  const beforeScreen = await pane.readPane(input.paneId, {
    source: "visible",
    lines: VISIBLE_LINES,
    ansi: true,
  });
  if (before === undefined || beforeScreen === undefined) {
    return fail("send-failed");
  }
  // The box may have gained text since the first check: re-check right before typing.
  if (inputLineState("claude", beforeScreen) !== "empty") {
    return fail("pane-input-busy");
  }
  const typed = await pane.sendText(input.paneId, "/effort");
  if (!typed.ok) {
    return fail("send-failed");
  }
  // Enter only if the box holds exactly `/effort`: otherwise it would submit a message.
  const echoed = await pane.readPane(input.paneId, {
    source: "visible",
    lines: VISIBLE_LINES,
    ansi: true,
  });
  if (!echoed || inputLineText("claude", echoed) !== "/effort") {
    return fail("pane-input-busy");
  }
  const opened = await pane.sendKeys(input.paneId, ["enter"]);
  if (!opened.ok) {
    return fail("send-failed");
  }
  const slider = await poll(timing, async () => {
    const screen = await pane.readPane(input.paneId, { source: "visible", lines: VISIBLE_LINES });
    return screen && sliderOpened(beforeScreen, screen) ? true : undefined;
  });
  if (!slider) {
    // Nothing else is sent: without the slider open, arrows and `s` would land in the input.
    await closeStraySlider(input.paneId, pane, beforeScreen);
    return fail("slider-not-opened");
  }
  // Pin the slider to its lowest level, then step right to the target, so the result does
  // not depend on where it started. `low` is the slider's first level.
  const keys = [
    ...Array.from({ length: LIVE_LEVELS.length + 2 }, () => "left"),
    ...Array.from({ length: target }, () => "right"),
    "s",
  ];
  const sent = await pane.sendKeys(input.paneId, keys);
  if (!sent.ok) {
    return fail("send-failed");
  }
  const outcome = await poll(timing, async () => {
    const after = await pane.readPane(input.paneId, { source: "recent", lines: RECENT_LINES });
    // While the slider is still drawn, `s` has not been handled yet: what is on screen is old.
    if (!after || sliderOpened(beforeScreen, after)) return undefined;
    const screen = await pane.readPane(input.paneId, { source: "visible", lines: VISIBLE_LINES });
    if (screen && claudeCacheWarningOpen(screen)) return { kind: "cache-warning" as const };
    return newClaudeOutcome(before, after);
  });
  if (!outcome) {
    // A cache-warning dialog that came up late would take the next Enter as "Yes".
    const late = await pane.readPane(input.paneId, { source: "visible", lines: VISIBLE_LINES });
    if (late && claudeCacheWarningOpen(late)) {
      await pane.sendKeys(input.paneId, ["esc"]);
      return fail("cache-warning", true);
    }
    await closeStraySlider(input.paneId, pane, beforeScreen);
    return fail("verify-timeout");
  }
  switch (outcome.kind) {
    case "session-only":
      return outcome.level === input.to
        ? { status: "applied", from: input.from, to: input.to, turnBreak: false }
        : fail("verify-mismatch");
    case "cache-warning": {
      // Bedrock and gateways ask before re-reading the whole history at the new level.
      // The router never accepts that on the user's behalf: Escape picks "No, go back".
      await pane.sendKeys(input.paneId, ["esc"]);
      return fail("cache-warning", true);
    }
    case "saved-default":
      return fail("saved-default");
    case "capped":
      return fail("effort-capped");
    case "kept":
      // Kept at the target is where the pane should be.
      return outcome.level === input.to
        ? { status: "no-change", from: input.to, to: input.to, reason: "already-at-level" }
        : fail("verify-mismatch");
  }
}

/**
 * The slider's key-hint line (`←/→ adjust · enter confirm · s for this session only`), near
 * the bottom where it is drawn, and not already there before `/effort`. Conversation lines
 * (`⏺` messages, `⎿` results) never count, so text quoting the hint cannot fake it.
 */
function sliderHints(screen: string): number {
  return footerLines(screen, 12).filter(
    (line) => !/^\s*[⏺⎿]/.test(line) && /adjust.*confirm.*s for this session only\s*$/.test(line),
  ).length;
}

function sliderOpened(beforeScreen: string, screen: string): boolean {
  return sliderHints(screen) > sliderHints(beforeScreen);
}

/**
 * A slider that opened after the router stopped waiting would take the next input as its
 * own keys (Enter there saves the user's default), so it is closed. Escape is sent only
 * when the slider's hint is on screen: elsewhere it would interrupt the agent.
 */
async function closeStraySlider(
  paneId: string,
  pane: HerdrPaneClient,
  beforeScreen: string,
): Promise<void> {
  const screen = await pane.readPane(paneId, { source: "visible", lines: VISIBLE_LINES });
  if (screen && sliderOpened(beforeScreen, screen)) {
    await pane.sendKeys(paneId, ["esc"]);
  }
}

/**
 * Codex: Alt+. and Alt+, step the effort one level without saving it. The change applies
 * from the next turn, so a mid-turn switch queues the continuation with Tab; Codex sends a
 * queued message as soon as the running turn ends.
 */
async function switchCodex(
  input: SwitchInput,
  working: boolean,
  pane: HerdrPaneClient,
  timing: Timing,
): Promise<SwitchResult> {
  const fail = (reason: SwitchFailure) => failed(input, reason);
  let current = input.from;
  for (let attempt = 0; attempt < CODEX_ATTEMPTS; attempt += 1) {
    const steps = effortRank(input.to) - effortRank(current);
    const key = steps > 0 ? "alt+." : "alt+,";
    const sent = await pane.sendKeys(
      input.paneId,
      Array.from({ length: Math.abs(steps) }, () => key),
    );
    if (!sent.ok) {
      return fail("send-failed");
    }
    const seen = await poll(timing, async () => {
      const screen = await pane.readPane(input.paneId, { source: "visible", lines: VISIBLE_LINES });
      const effort = screen ? codexStatusEffort(screen) : undefined;
      return effort === input.to ? effort : undefined;
    });
    if (seen) {
      break;
    }
    const screen = await pane.readPane(input.paneId, { source: "visible", lines: VISIBLE_LINES });
    const observed = screen ? codexStatusEffort(screen) : undefined;
    // Retry only when nothing moved: resending after a partial or delayed step overshoots.
    if (attempt === CODEX_ATTEMPTS - 1 || observed !== input.from) {
      return fail("verify-mismatch");
    }
    current = observed;
  }
  const turnBreak = working && input.continuation !== undefined;
  if (turnBreak) {
    // One line of plain text: a newline would submit the composer mid-turn, and other
    // control characters (Ctrl-C, Escape sequences) would act as keystrokes.
    // A trailing space closes a file-search popup a final `@token` would leave open.
    const line = `${plainLine(input.continuation!)} `;
    const typed = await pane.sendText(input.paneId, line);
    const queued = typed.ok ? await pane.sendKeys(input.paneId, ["tab"]) : typed;
    if (!queued.ok) {
      // The level did change. Report that, without a turn break: nothing reliable was
      // queued, so the agent carries on itself, and no second pane is opened for the task.
      return { status: "applied", from: input.from, to: input.to, turnBreak: false };
    }
  }
  return { status: "applied", from: input.from, to: input.to, turnBreak };
}
