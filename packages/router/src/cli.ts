#!/usr/bin/env node
import { Command } from "commander";
import { executeRun, type RunDeps } from "./commands/run.js";
import { formatStatus } from "./commands/status.js";
import { formatSession } from "./commands/session.js";
import { formatAccounts } from "./commands/accounts.js";
import { usageRefresh } from "./commands/usage.js";
import { loadConfig } from "./config/config-loader.js";
import { formatError } from "./presentation/errors.js";

export interface CliIo {
  write(chunk: string): boolean;
}

export interface CliOptions {
  stdout?: CliIo;
  stderr?: CliIo;
  env?: NodeJS.Dict<string>;
  run?: typeof executeRun;
  runDeps?: RunDeps;
}

export function createProgram(options: CliOptions = {}): Command & { exitCode?: number } {
  const stdout: CliIo = options.stdout ?? {
    write(chunk: string) {
      process.stdout.write(chunk);
      return true;
    },
  };
  const stderr: CliIo = options.stderr ?? {
    write(chunk: string) {
      process.stderr.write(chunk);
      return true;
    },
  };
  const env = options.env ?? process.env;
  const program = new Command() as Command & { exitCode?: number };
  program.name("router").description("Explicit model router CLI");
  program.configureOutput({
    writeOut: (chunk) => {
      stdout.write(chunk);
    },
    writeErr: (chunk) => {
      stderr.write(chunk);
    },
  });
  program.exitOverride();
  program
    .command("run")
    .argument("<task>")
    .option("--dry-run", "Print the route without launching", false)
    .option("--json", "Emit JSON for plugins", false)
    .action(async (task: string, flags: { dryRun?: boolean; json?: boolean }) => {
      try {
        if (!options.runDeps && !options.run) {
          throw new Error(
            "router run requires injected run dependencies in tests or a loaded config",
          );
        }
        const result = await (options.run ?? executeRun)(
          task,
          { dryRun: Boolean(flags.dryRun) },
          options.runDeps ?? {
            accounts: [],
            models: [],
            usage: {},
            client: {
              calls: [],
              systemOne: async () => {
                throw new Error("TypeSafe client not configured");
              },
            },
            env,
          },
        );
        stdout.write(`${flags.json ? JSON.stringify(result.json) : result.output}\n`);
        program.exitCode = result.code;
      } catch (error) {
        stderr.write(`${formatError(error)}\n`);
        program.exitCode = 1;
      }
    });
  program.command("status").action(() => {
    try {
      const config = loadConfig({ env });
      stdout.write(`${formatStatus({ accounts: config.accounts })}\n`);
    } catch (error) {
      stderr.write(`${formatError(error)}\n`);
      program.exitCode = 1;
    }
  });
  program.command("session").action(() => {
    stdout.write(`${formatSession({ id: "none", phase: "none" })}\n`);
  });
  program.command("accounts").action(() => {
    try {
      const config = loadConfig({ env });
      stdout.write(`${formatAccounts(config.accounts)}\n`);
    } catch (error) {
      stderr.write(`${formatError(error)}\n`);
      program.exitCode = 1;
    }
  });
  program
    .command("usage")
    .command("refresh")
    .option("--source <source>", "official-cli|browser", "official-cli")
    .option("--dry-run", "Do not persist", false)
    .action((flags: { source?: string; dryRun?: boolean }) => {
      stdout.write(
        `${usageRefresh({ source: flags.source ?? "official-cli", dryRun: Boolean(flags.dryRun) })}\n`,
      );
    });
  return program;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const program = createProgram();
  await program.parseAsync(process.argv);
  process.exitCode = program.exitCode ?? 0;
}
