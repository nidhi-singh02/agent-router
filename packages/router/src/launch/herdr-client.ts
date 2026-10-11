import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

export interface CommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (argv: readonly string[]) => Promise<CommandResult>;

export interface HerdrClient {
  /** `cwd` starts the new pane's shell in that directory (`herdr pane split --cwd`). */
  splitCurrent(options?: { direction?: "right" | "down"; cwd?: string }): Promise<CommandResult>;
  startAgent(input: {
    name: string;
    kind: "cursor" | "claude" | "codex" | "opencode";
    paneId: string;
    agentArgs: string[];
  }): Promise<CommandResult>;
  prompt(input: {
    target: string;
    text: string;
    wait?: boolean;
    until?: HerdrAgentState[];
    timeoutMs?: number;
  }): Promise<CommandResult>;
  waitFor(input: {
    target: string;
    until?: HerdrAgentState[];
    timeoutMs?: number;
  }): Promise<CommandResult>;
  closePane(paneId: string): Promise<CommandResult>;
  /**
   * Follow-up text for an agent that is already running goes through `herdr-send`, the
   * guarded injection wrapper shared by every host: it refuses blocked/unknown panes
   * instead of typing into an approval or question screen. Never passes `--force`.
   */
  send(input: {
    target: string;
    text: string;
    waitIdleSec: number;
    timeoutMs: number;
  }): Promise<HerdrSendResult>;
  /**
   * `herdr agent get <target>`; undefined when Herdr does not report an agent there. Optional
   * so a client without it still works: callers then keep addressing the pane id.
   */
  getAgent?(target: string): Promise<HerdrAgentInfo | undefined>;
}

/**
 * `herdr-send` outcome, by exit code: 0 ok, 2 refused, 3 timeout, 4 sent_unconfirmed (the
 * text WAS submitted; never resend), 1 error. `unavailable` means the binary is missing.
 */
export interface HerdrSendResult {
  result: "ok" | "refused" | "timeout" | "sent_unconfirmed" | "error" | "unavailable";
  code: number;
  /** `reason` from `--json`, e.g. blocked, busy, unknown_state, agent_prompt_stalled. */
  reason?: string;
  /** Bridge state when herdr-send decided: idle, busy, blocked or unknown. */
  state?: string;
  confirmedByScreen?: boolean;
  /** Raw stderr/stdout (or the missing-binary message) for an unexpected failure. */
  detail?: string;
}

export interface HerdrClientOptions {
  /** `herdr-send` executable; default `herdr-send` looked up on PATH at spawn time. */
  herdrSendBin?: string;
  /** Set when the executable could not be resolved: `send` fails with this message. */
  herdrSendMissing?: string;
}

const HERDR_SEND_RESULTS = new Set(["ok", "refused", "timeout", "sent_unconfirmed", "error"]);

function isExecutable(file: string): boolean {
  try {
    // X_OK alone also passes for a directory, which cannot be spawned.
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds `herdr-send`: `HERDR_SEND_BIN` (a path, or a name looked up on PATH) overrides the
 * default `herdr-send` on PATH. Returns the path as found (a relative HERDR_SEND_BIN or a
 * relative PATH entry stays relative to the current directory), or a message saying what is
 * missing.
 */
export function resolveHerdrSendBin(
  env: NodeJS.Dict<string>,
): { bin: string; error?: undefined } | { bin?: undefined; error: string } {
  const override = env.HERDR_SEND_BIN?.trim();
  const name = override || "herdr-send";
  if (name.includes("/")) {
    return isExecutable(name)
      ? { bin: name }
      : { error: `HERDR_SEND_BIN=${name} is not an executable file` };
  }
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) {
      return { bin: candidate };
    }
  }
  return {
    error: override
      ? `HERDR_SEND_BIN=${name} was not found on PATH`
      : "herdr-send was not found on PATH; install it (dotfiles files/herdr/bin/herdr-send) or set HERDR_SEND_BIN",
  };
}

export function parseHerdrSendResult(result: CommandResult): HerdrSendResult {
  let parsed: {
    result?: unknown;
    reason?: unknown;
    state?: unknown;
    confirmed_by_screen?: unknown;
  } = {};
  const lastLine = result.stdout.trim().split("\n").pop() ?? "";
  try {
    const data: unknown = JSON.parse(lastLine);
    if (data && typeof data === "object") {
      parsed = data as typeof parsed;
    }
  } catch {
    // Not JSON (usage error, crash); the exit code still decides.
  }
  const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
  const state = typeof parsed.state === "string" ? parsed.state : undefined;
  const confirmedByScreen =
    typeof parsed.confirmed_by_screen === "boolean" ? parsed.confirmed_by_screen : undefined;
  const byCode: Record<number, HerdrSendResult["result"]> = {
    0: "ok",
    2: "refused",
    3: "timeout",
    4: "sent_unconfirmed",
  };
  const fromJson =
    typeof parsed.result === "string" && HERDR_SEND_RESULTS.has(parsed.result)
      ? (parsed.result as HerdrSendResult["result"])
      : undefined;
  // The exit code is the contract; JSON only fills in reason/state.
  let outcome = byCode[result.code] ?? "error";
  if (outcome === "error" && fromJson === undefined && /ENOENT/.test(result.stderr)) {
    outcome = "unavailable";
  }
  const detail = result.stderr.trim() || (fromJson ? "" : result.stdout.trim()) || undefined;
  return {
    result: outcome,
    code: result.code,
    ...(reason ? { reason } : {}),
    ...(state ? { state } : {}),
    ...(confirmedByScreen === undefined ? {} : { confirmedByScreen }),
    ...(outcome === "ok" || !detail ? {} : { detail }),
  };
}

export function createProcessCommandAdapter(
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): RunCommand {
  // Longer than Herdr's 30s agent start timeout, so Herdr reports its own error first.
  const timeoutMs = options.timeoutMs ?? 60_000;
  return (argv) =>
    new Promise((resolve) => {
      const [command, ...args] = argv;
      if (!command) {
        resolve({ ok: false, code: 1, stdout: "", stderr: "missing command" });
        return;
      }
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: options.env });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ ok: false, code: 1, stdout, stderr: String(error) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const exit = code ?? 1;
        resolve({ ok: exit === 0, code: exit, stdout, stderr });
      });
    });
}

export type HerdrAgentState = "idle" | "working" | "blocked" | "done" | "unknown";

function stateArgs(until: HerdrAgentState[] = [], timeoutMs?: number): string[] {
  return [
    ...until.flatMap((state) => ["--until", state]),
    ...(timeoutMs === undefined ? [] : ["--timeout", String(timeoutMs)]),
  ];
}

export function createHerdrClient(
  runCommand: RunCommand,
  options: HerdrClientOptions = {},
): HerdrClient {
  return {
    splitCurrent(options) {
      return runCommand([
        "herdr",
        "pane",
        "split",
        "--current",
        "--direction",
        options?.direction ?? "right",
        ...(options?.cwd === undefined ? [] : ["--cwd", options.cwd]),
        "--no-focus",
      ]);
    },
    startAgent(input) {
      return runCommand([
        "herdr",
        "agent",
        "start",
        input.name,
        "--kind",
        input.kind,
        "--pane",
        input.paneId,
        "--",
        ...input.agentArgs,
      ]);
    },
    prompt(input) {
      const argv = ["herdr", "agent", "prompt", input.target, input.text];
      if (input.wait !== false) {
        argv.push("--wait", ...stateArgs(input.until, input.timeoutMs));
      }
      return runCommand(argv);
    },
    waitFor(input) {
      return runCommand([
        "herdr",
        "agent",
        "wait",
        input.target,
        ...stateArgs(input.until, input.timeoutMs),
      ]);
    },
    closePane(paneId) {
      return runCommand(["herdr", "pane", "close", paneId]);
    },
    async getAgent(target) {
      const result = await runCommand(["herdr", "agent", "get", target]);
      return result.ok ? parseHerdrAgentInfo(result.stdout) : undefined;
    },
    async send(input) {
      if (options.herdrSendMissing !== undefined) {
        return { result: "unavailable", code: 127, detail: options.herdrSendMissing };
      }
      const result = await runCommand([
        options.herdrSendBin ?? "herdr-send",
        "--wait-idle",
        String(input.waitIdleSec),
        "--timeout",
        String(input.timeoutMs),
        "--json",
        // Text that starts with "-" must not be read as an option.
        "--",
        input.target,
        input.text,
      ]);
      return parseHerdrSendResult(result);
    },
  };
}

/** What `herdr agent get` reports about a running agent. */
export interface HerdrAgentInfo {
  /** The agent kind, e.g. claude or codex. */
  agent: string;
  status: HerdrAgentState;
  paneId: string;
  /** The agent's Herdr name (`herdr agent start <name>`), when Herdr reports one. */
  name?: string;
}

/** Controls an already-running agent pane; used by in-place effort switching. */
export interface HerdrPaneClient {
  getAgent(target: string): Promise<HerdrAgentInfo | undefined>;
  readPane(
    paneId: string,
    options: { source: "visible" | "recent"; lines: number; ansi?: boolean },
  ): Promise<string | undefined>;
  sendKeys(paneId: string, keys: readonly string[]): Promise<CommandResult>;
  sendText(paneId: string, text: string): Promise<CommandResult>;
}

const AGENT_STATES = new Set<HerdrAgentState>(["idle", "working", "blocked", "done", "unknown"]);

export function parseHerdrAgentInfo(stdout: string): HerdrAgentInfo | undefined {
  try {
    const data = JSON.parse(stdout.trim()) as {
      result?: {
        agent?: {
          agent?: unknown;
          agent_status?: unknown;
          pane_id?: unknown;
          name?: unknown;
        };
      };
    };
    const agent = data.result?.agent;
    if (!agent || typeof agent.agent !== "string" || typeof agent.pane_id !== "string") {
      return undefined;
    }
    const status = AGENT_STATES.has(agent.agent_status as HerdrAgentState)
      ? (agent.agent_status as HerdrAgentState)
      : "unknown";
    return {
      agent: agent.agent,
      status,
      paneId: agent.pane_id,
      ...(typeof agent.name === "string" && agent.name.length > 0 ? { name: agent.name } : {}),
    };
  } catch {
    return undefined;
  }
}

export function createHerdrPaneClient(runCommand: RunCommand): HerdrPaneClient {
  return {
    async getAgent(target) {
      const result = await runCommand(["herdr", "agent", "get", target]);
      return result.ok ? parseHerdrAgentInfo(result.stdout) : undefined;
    },
    async readPane(paneId, options) {
      const result = await runCommand([
        "herdr",
        "pane",
        "read",
        paneId,
        "--source",
        options.source,
        "--lines",
        String(options.lines),
        "--format",
        options.ansi ? "ansi" : "text",
      ]);
      return result.ok ? result.stdout : undefined;
    },
    sendKeys(paneId, keys) {
      return runCommand(["herdr", "pane", "send-keys", paneId, ...keys]);
    },
    sendText(paneId, text) {
      return runCommand(["herdr", "pane", "send-text", paneId, text]);
    },
  };
}
