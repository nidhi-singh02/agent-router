import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProgram, runCli } from "../../src/cli.js";
import { UsageSnapshotSchema } from "../../src/domain/usage.js";
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

describe("router status quota", () => {
  it("prints each account's quota from its usage collectors", async () => {
    const home = homeWithConfig({
      accounts: [
        {
          id: "acct_personal_cursor",
          label: "personal cursor",
          provider: "cursor",
          agent: "cursor",
          ownership: "personal",
          collectorPreference: ["local-session"],
          enabledModels: ["cursor:composer-2.5"],
          enabled: true,
        },
        {
          id: "acct_personal_codex",
          label: "personal codex",
          provider: "openai",
          agent: "codex",
          ownership: "personal",
          collectorPreference: ["official-cli"],
          enabledModels: ["openai:gpt-5.5"],
          enabled: true,
        },
      ],
    });
    let out = "";
    const code = await runCli(["node", "router", "status", "--usage"], {
      stdout: {
        write(chunk: string) {
          out += chunk;
          return true;
        },
      },
      env: { MODEL_ROUTER_HOME: home },
      collectUsage: async (account) =>
        account.agent === "cursor"
          ? UsageSnapshotSchema.parse({
              accountId: account.id,
              windows: [
                { kind: "monthly", pool: "spend", remainingRatio: 0 },
                { kind: "monthly", pool: "auto", remainingRatio: 0.8 },
              ],
              collectedAt: "2026-09-17T09:58:25.000Z",
              source: "local-session",
              certainty: "estimated",
              expiresAt: "2026-09-17T10:05:00.000Z",
              activeReservationRatio: 0,
            })
          : UsageSnapshotSchema.parse({
              accountId: account.id,
              windows: [{ kind: "five-hour" }],
              collectedAt: "2026-09-17T09:58:25.000Z",
              source: "none",
              certainty: "unknown",
              expiresAt: "2026-09-17T10:05:00.000Z",
              activeReservationRatio: 0,
            }),
    });
    expect(code).toBe(0);
    expect(out).toContain(
      "acct_personal_cursor (personal)  quota: spend 0% left, auto 80% left (estimated local-session, as of 2026-09-17T09:58:25.000Z)",
    );
    expect(out).toContain(
      "acct_personal_codex (personal)  quota: unknown (no collector returned usage)",
    );
  });

  it("skips quota collection by default", async () => {
    const home = homeWithConfig({
      accounts: [
        {
          id: "acct_personal_cursor",
          label: "personal cursor",
          provider: "cursor",
          agent: "cursor",
          ownership: "personal",
          collectorPreference: ["local-session"],
          enabledModels: ["cursor:composer-2.5"],
          enabled: true,
        },
      ],
    });
    let out = "";
    const collectUsage = vi.fn();
    const code = await runCli(["node", "router", "status"], {
      stdout: {
        write(chunk: string) {
          out += chunk;
          return true;
        },
      },
      env: { MODEL_ROUTER_HOME: home },
      collectUsage,
    });
    expect(code).toBe(0);
    expect(collectUsage).not.toHaveBeenCalled();
    expect(out.trim()).toBe("acct_personal_cursor (personal)");
  });
});
