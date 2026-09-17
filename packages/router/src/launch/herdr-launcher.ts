import { createHash, randomBytes } from "node:crypto";
import { redactCollectorText } from "../collectors/normalizer.js";
import type { AgentId } from "../domain/ids.js";
import type { ReasoningEffort } from "../domain/model-profile.js";
import { buildAgentCommand, herdrAgentKind } from "./agent-command.js";
import { createHerdrClient, type HerdrClient } from "./herdr-client.js";
import { isHerdrEnv } from "./readiness.js";

export function parseHerdrPaneId(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const data = JSON.parse(trimmed) as {
      result?: { pane?: { pane_id?: unknown } };
      pane?: { pane_id?: unknown };
    };
    const id = data.result?.pane?.pane_id ?? data.pane?.pane_id;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  } catch {
    // Fall back to the first token of plain-text Herdr output.
  }
  return trimmed.split(/\s+/)[0];
}

// Herdr reports failures as JSON ({"error":{"code":"...","message":"..."}}) on stdout or
// stderr depending on the command.
export function herdrError(result: { stdout: string; stderr: string }, action: string): string {
  for (const stream of [result.stdout, result.stderr]) {
    try {
      const data = JSON.parse(stream.trim()) as {
        error?: { code?: unknown; message?: unknown };
      };
      const code = typeof data.error?.code === "string" ? data.error.code : undefined;
      const message = typeof data.error?.message === "string" ? data.error.message : undefined;
      if (code || message) {
        return `${action}: ${[code, message].filter(Boolean).join(": ")}`;
      }
    } catch {
      // Not JSON; try the next stream.
    }
  }
  const stderr = result.stderr.trim();
  return stderr ? `${action}: ${stderr}` : action;
}

// Herdr agent names must be unique among live agents and match [a-z][a-z0-9_-]{0,31}.
// Deriving the name from the launch token keeps each launch distinct and lets a retry reuse it.
export function herdrAgentName(agent: AgentId, launchToken: string): string {
  const suffix = createHash("sha256").update(launchToken).digest("hex").slice(0, 6);
  return `router-${herdrAgentKind(agent)}-${suffix}`;
}

const HANDOFF_TIMEOUT_MS = 30_000;

export interface LaunchResult {
  ok: boolean;
  error?: string;
  paneCreated?: boolean;
  printed?: string;
  launchToken?: string;
  paneId?: string;
  agentName?: string;
}

export async function launchRoutedAgent(input: {
  env: NodeJS.Dict<string>;
  agent: AgentId;
  launchName: string;
  effort: ReasoningEffort;
  handoff: string;
  dryRun: boolean;
  existingLaunchToken?: string;
  existingPaneId?: string;
  herdr?: HerdrClient;
}): Promise<LaunchResult> {
  if (!isHerdrEnv(input.env) && !input.dryRun) {
    return { ok: false, error: "HERDR_ENV=1 is required to launch a pane" };
  }
  const command = buildAgentCommand({
    agent: input.agent,
    launchName: input.launchName,
    effort: input.effort,
  });
  const printed = redactCollectorText(`start ${command.join(" ")}; send handoff: ${input.handoff}`);
  const launchToken =
    input.existingLaunchToken ?? `launch_${Date.now()}_${randomBytes(4).toString("hex")}`;
  if (input.dryRun) {
    return { ok: true, paneCreated: false, printed, launchToken };
  }
  const agentName = herdrAgentName(input.agent, launchToken);
  const herdr =
    input.herdr ??
    createHerdrClient(async () => ({
      ok: false,
      code: 1,
      stdout: "",
      stderr: "herdr command adapter was not injected",
    }));
  let paneId = input.existingPaneId;
  let paneCreated = false;
  if (!paneId) {
    const split = await herdr.splitCurrent();
    if (!split.ok) {
      return { ok: false, error: herdrError(split, "herdr pane split failed"), launchToken };
    }
    paneId = parseHerdrPaneId(split.stdout);
    if (!paneId) {
      return { ok: false, error: "herdr pane split did not return a pane id", launchToken };
    }
    paneCreated = true;
  }
  if (!input.existingPaneId) {
    const started = await herdr.startAgent({
      name: agentName,
      kind: herdrAgentKind(input.agent),
      paneId,
      // Herdr runs the kind's own executable; pass only its native arguments after `--`.
      agentArgs: command.slice(1),
    });
    if (!started.ok) {
      const error = herdrError(started, "herdr agent start failed");
      if (paneCreated) {
        // Do not leave an empty shell pane behind for a launch that never started.
        await herdr.closePane(paneId);
        return { ok: false, error, launchToken, paneCreated: false, agentName };
      }
      return { ok: false, error, launchToken, paneId, paneCreated, agentName };
    }
    // `agent start` returns once the agent UI is detected; let startup (MCP, skills) settle
    // first, or a prompt pasted during startup can be dropped.
    const settled = await herdr.waitFor({ target: agentName, timeoutMs: HANDOFF_TIMEOUT_MS });
    if (!settled.ok) {
      return {
        ok: false,
        error: herdrError(settled, "herdr agent wait failed"),
        launchToken,
        paneId,
        paneCreated,
        agentName,
      };
    }
  }
  // Wait only until the agent starts working (or asks a question), not for the whole turn.
  // Herdr returns agent_prompt_stalled when the submission produced no activity.
  const prompted = await herdr.prompt({
    target: agentName,
    text: input.handoff,
    until: ["working", "blocked"],
    timeoutMs: HANDOFF_TIMEOUT_MS,
  });
  if (!prompted.ok) {
    const output = `${prompted.stdout}${prompted.stderr}`;
    return {
      ok: false,
      error: output.includes("agent_blocked")
        ? "agent is blocked; not resending the handoff"
        : output.includes("agent_prompt_stalled")
          ? `handoff not received by agent ${agentName} in pane ${paneId} (${herdrError(prompted, "").replace(/^: /, "")}); paste the task there or retry`
          : herdrError(prompted, "herdr agent prompt failed"),
      launchToken,
      paneId,
      paneCreated,
      printed,
      agentName,
    };
  }
  return { ok: true, paneCreated, printed, launchToken, paneId, agentName };
}
