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

export interface LaunchResult {
  ok: boolean;
  error?: string;
  paneCreated?: boolean;
  printed?: string;
  launchToken?: string;
  paneId?: string;
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
  const launchToken = input.existingLaunchToken ?? `launch_${Date.now()}`;
  if (input.dryRun) {
    return { ok: true, paneCreated: false, printed, launchToken };
  }
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
      return { ok: false, error: split.stderr || "herdr pane split failed", launchToken };
    }
    paneId = parseHerdrPaneId(split.stdout);
    if (!paneId) {
      return { ok: false, error: "herdr pane split did not return a pane id", launchToken };
    }
    paneCreated = true;
  }
  if (!input.existingPaneId) {
    const started = await herdr.startAgent({
      name: `router-${input.agent}`,
      kind: herdrAgentKind(input.agent),
      paneId,
      agentArgs: command,
    });
    if (!started.ok) {
      return {
        ok: false,
        error: started.stderr || "herdr agent start failed",
        launchToken,
        paneId,
        paneCreated,
      };
    }
  }
  const prompted = await herdr.prompt({ target: `router-${input.agent}`, text: input.handoff });
  if (!prompted.ok) {
    return {
      ok: false,
      error: prompted.stderr.includes("agent_blocked")
        ? "agent is blocked; not resending the handoff"
        : prompted.stderr || "herdr agent prompt failed",
      launchToken,
      paneId,
      paneCreated,
      printed,
    };
  }
  return { ok: true, paneCreated, printed, launchToken, paneId };
}
