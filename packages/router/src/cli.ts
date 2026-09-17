#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { executeRun, type RunDeps } from "./commands/run.js";
import { formatStatus } from "./commands/status.js";
import { formatSession, formatSessionList } from "./commands/session.js";
import { openDatabase } from "./store/database.js";
import { SessionRepository } from "./store/session-repository.js";

const NO_SESSIONS = "No router sessions yet. Sessions are recorded when `router run` launches.\n";
import { formatAccounts } from "./commands/accounts.js";
import { usageRefresh } from "./commands/usage.js";
import { loadConfig } from "./config/config-loader.js";
import { createDefaultRunDeps } from "./commands/runtime.js";
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
        const result = await (options.run ?? executeRun)(
          task,
          { dryRun: Boolean(flags.dryRun) },
          options.runDeps ?? (await createDefaultRunDeps(env)),
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
  program
    .command("session")
    .argument("[id]", "Session id (defaults to the latest session)")
    .option("--list", "List recent sessions, newest first", false)
    .option("--limit <n>", "How many sessions --list shows", "20")
    .option("--json", "Emit JSON for plugins", false)
    .action((id: string | undefined, flags: { list?: boolean; limit: string; json?: boolean }) => {
      let db;
      try {
        db = openDatabase({ home: loadConfig({ env }).home });
        const sessions = new SessionRepository(db);
        if (flags.list) {
          const limit = Math.max(1, Number.parseInt(flags.limit, 10) || 20);
          const listed = sessions.list(limit);
          if (flags.json) {
            stdout.write(`${JSON.stringify(listed)}\n`);
          } else {
            stdout.write(listed.length > 0 ? `${formatSessionList(listed)}\n` : NO_SESSIONS);
          }
          return;
        }
        const session = id ? sessions.get(id) : sessions.latest();
        if (!session) {
          if (id) {
            stderr.write(`Session not found: ${id}\n`);
            program.exitCode = 1;
          } else {
            stdout.write(flags.json ? "null\n" : NO_SESSIONS);
          }
          return;
        }
        stdout.write(`${flags.json ? JSON.stringify(session) : formatSession(session)}\n`);
      } catch (error) {
        stderr.write(`${formatError(error)}\n`);
        program.exitCode = 1;
      } finally {
        db?.close();
      }
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

export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const program = createProgram(options);
  try {
    await program.parseAsync(argv);
  } catch (error) {
    // exitOverride turns --help, --version, and usage errors into thrown CommanderErrors.
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    throw error;
  }
  return program.exitCode ?? 0;
}

// npm link and global installs start the CLI through a symlink, so compare real paths.
export function isEntrypoint(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) {
    return false;
  }
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  process.exitCode = await runCli(process.argv);
}
