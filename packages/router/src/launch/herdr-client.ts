import { spawn } from "node:child_process";

export interface CommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (argv: readonly string[]) => Promise<CommandResult>;

export interface HerdrClient {
  splitCurrent(options?: { direction?: "right" | "down" }): Promise<CommandResult>;
  startAgent(input: {
    name: string;
    kind: "cursor" | "claude" | "codex" | "opencode";
    paneId: string;
    agentArgs: string[];
  }): Promise<CommandResult>;
  prompt(input: { target: string; text: string; wait?: boolean }): Promise<CommandResult>;
}

export function createProcessCommandAdapter(options: { timeoutMs?: number } = {}): RunCommand {
  // Longer than Herdr's 30s agent start timeout, so Herdr reports its own error first.
  const timeoutMs = options.timeoutMs ?? 60_000;
  return (argv) =>
    new Promise((resolve) => {
      const [command, ...args] = argv;
      if (!command) {
        resolve({ ok: false, code: 1, stdout: "", stderr: "missing command" });
        return;
      }
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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
        argv.push("--wait");
      }
      return runCommand(argv);
    },
  };
}
