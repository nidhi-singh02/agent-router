import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli.js";
import { formatError } from "../../src/presentation/errors.js";
import { formatStatus } from "../../src/commands/status.js";

function homeWithConfig(config: unknown): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "router-status-"));
  writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
  return home;
}

async function runStatus(
  env: NodeJS.Dict<string>,
): Promise<{ out: string; err: string; code: number }> {
  let out = "";
  let err = "";
  const program = createProgram({
    stdout: {
      write(chunk: string) {
        out += chunk;
        return true;
      },
    },
    stderr: {
      write(chunk: string) {
        err += chunk;
        return true;
      },
    },
    env,
  });
  program.exitOverride();
  try {
    await program.parseAsync(["node", "router", "status"]);
  } catch (error) {
    err += error instanceof Error ? error.message : String(error);
  }
  return { out, err, code: program.exitCode ?? 0 };
}

describe("router status", () => {
  it("surfaces a configuration error without secrets", async () => {
    const home = homeWithConfig({
      accounts: [
        {
          id: "acct_shared",
          label: "family claude",
          provider: "anthropic",
          agent: "claude-code",
          ownership: "shared",
          reserveFloor: 0.3,
          collectorPreference: ["official-cli"],
          enabledModels: ["anthropic:claude-sonnet"],
          enabled: true,
          credentialRef: "env:ANTHROPIC_API_KEY",
        },
      ],
    });
    const result = await runStatus({
      MODEL_ROUTER_HOME: home,
      ANTHROPIC_API_KEY: "sk-secret-123",
    });
    expect(result.err.length + result.out.length).toBeGreaterThan(0);
    expect(`${result.out}${result.err}`).toMatch(/reserve/i);
    expect(`${result.out}${result.err}`).not.toContain("sk-secret-123");
  });

  it("never prints friend identity on shared activity", () => {
    const printed = formatStatus({
      accounts: [{ id: "acct_shared", ownership: "shared", label: "family claude" }],
      activity: "shared subscription currently active",
    });
    expect(printed).toContain("shared subscription currently active");
    expect(printed).not.toMatch(/telegram|@friend|alice/i);
  });

  it("redacts secrets in error output", () => {
    expect(formatError(new Error("auth failed Bearer sk-secret-123"))).not.toContain(
      "sk-secret-123",
    );
  });
});
