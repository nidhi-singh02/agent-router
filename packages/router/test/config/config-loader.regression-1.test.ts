// Regression: ISSUE-002 — config and flag validation errors printed as raw Zod JSON without the file path
// Found by /qa on 2026-11-11
// Report: .gstack/qa-reports/qa-report-router-cli-2026-11-11.md
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../src/config/config-loader.js";
import { formatError } from "../../src/presentation/errors.js";

function homeWithRawConfig(raw: string): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "router-config-regression-"));
  writeFileSync(path.join(home, "config.json"), raw);
  return home;
}

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return formatError(error);
  }
  throw new Error("expected an error");
}

describe("config errors", () => {
  it("names the config file when its JSON is malformed", () => {
    const home = homeWithRawConfig("{bad json");
    const message = messageOf(() => loadConfig({ env: { MODEL_ROUTER_HOME: home } }));
    expect(message).toContain(path.join(home, "config.json"));
  });

  it("names the config file and the failing field, not a raw JSON dump", () => {
    const home = homeWithRawConfig(JSON.stringify({ accounts: [{ id: 1 }] }));
    const message = messageOf(() => loadConfig({ env: { MODEL_ROUTER_HOME: home } }));
    expect(message).toContain(path.join(home, "config.json"));
    expect(message).toContain("accounts[0].id");
    expect(message.trimStart().startsWith("[")).toBe(false);
  });

  it("formats a bare ZodError readably", () => {
    const result = z.object({ stepKind: z.enum(["explore", "edit"]) }).safeParse({
      stepKind: "nonsense",
    });
    expect(result.success).toBe(false);
    const message = formatError(result.error);
    expect(message).toContain("stepKind");
    expect(message.trimStart().startsWith("[")).toBe(false);
  });
});
