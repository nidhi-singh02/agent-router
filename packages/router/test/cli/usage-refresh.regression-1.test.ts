// Regression: ISSUE-001 — `router usage refresh` crashed with an uncaught stack trace on a bad config
// Regression: ISSUE-003 — `router usage refresh --source <unknown>` silently ran local-session
// Found by /qa on 2026-11-11
// Report: .gstack/qa-reports/qa-report-router-cli-2026-11-11.md
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";

function homeWithRawConfig(raw: string): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "router-usage-refresh-"));
  writeFileSync(path.join(home, "config.json"), raw);
  return home;
}

async function run(argv: string[], env: NodeJS.Dict<string>) {
  let out = "";
  let err = "";
  const code = await runCli(["node", "router", ...argv], {
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
  return { code, out, err };
}

describe("router usage refresh", () => {
  it.each([
    ["malformed JSON", "{bad json"],
    ["a config that fails the schema", JSON.stringify({ accounts: [{ id: 1 }] })],
  ])("reports %s on stderr with exit 1 instead of throwing", async (_label, raw) => {
    const home = homeWithRawConfig(raw);
    const result = await run(["usage", "refresh", "--dry-run"], { MODEL_ROUTER_HOME: home });
    expect(result.code).toBe(1);
    expect(result.err).toContain("config.json");
    expect(result.out).toBe("");
  });

  it("rejects an unknown --source instead of falling back to local-session", async () => {
    const home = homeWithRawConfig(JSON.stringify({ accounts: [] }));
    const result = await run(["usage", "refresh", "--source", "bogus", "--dry-run"], {
      MODEL_ROUTER_HOME: home,
    });
    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/bogus/);
    expect(result.err).toMatch(/local-session/);
  });
});
