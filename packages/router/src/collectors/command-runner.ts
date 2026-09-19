import { spawn } from "node:child_process";

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  /**
   * `err.code` from a failed spawn (`ENOENT`, `EACCES`, `EMFILE`, ...), absent when the
   * child started. Callers cannot tell a missing binary from a local exec failure by exit
   * code alone: both surface as `code: null`.
   */
  spawnErrorCode?: string;
  executedReturnedOutput: false;
}

export async function runCommand(input: {
  command: string;
  args: string[];
  timeoutMs: number;
  maxBytes: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      env: input.env ?? process.env,
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (ok: boolean, code: number | null, spawnErrorCode?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        ok,
        stdout: stdout.slice(0, input.maxBytes),
        stderr: stderr.slice(0, input.maxBytes),
        code,
        timedOut,
        ...(spawnErrorCode === undefined ? {} : { spawnErrorCode }),
        executedReturnedOutput: false,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      finish(false, null);
    }, input.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < input.maxBytes) {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < input.maxBytes) {
        stderr += chunk.toString("utf8");
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish(false, null, typeof error.code === "string" ? error.code : "UNKNOWN");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0, code);
    });
  });
}
