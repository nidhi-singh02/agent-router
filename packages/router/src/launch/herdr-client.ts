import { spawn } from "node:child_process";

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

export function createHerdrClient(runCommand: RunCommand): HerdrClient {
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
  };
}
