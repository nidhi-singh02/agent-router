import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCursorDashboard } from "../../src/collectors/browser/parsers/cursor-dashboard.js";
import { parseAnthropicDashboard } from "../../src/collectors/browser/parsers/anthropic-dashboard.js";
import { parseOpenaiDashboard } from "../../src/collectors/browser/parsers/openai-dashboard.js";
import { dryRunBrowserUsage } from "../../src/collectors/browser/dashboard-collector.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/dashboards");

describe("browser dashboard parsers", () => {
  it("parses sanitized Cursor dashboard HTML as fragile estimated usage", () => {
    const parsed = parseCursorDashboard(readFileSync(path.join(dir, "cursor.html"), "utf8"));
    expect(parsed.snapshot.certainty).toBe("estimated");
    expect(parsed.snapshot.source).toBe("browser-dashboard");
    expect(parsed.fragile).toBe(true);
    expect(parsed.snapshot.windows[0]?.remainingRatio).toBeCloseTo(0.62);
  });

  it("parses Anthropic dashboard fragments without inventing five-hour quota", () => {
    const parsed = parseAnthropicDashboard(readFileSync(path.join(dir, "anthropic.html"), "utf8"));
    expect(parsed.snapshot.windows.find((window) => window.kind === "five-hour")?.remainingRatio).toBeUndefined();
    expect(parsed.snapshot.certainty).toBe("estimated");
  });

  it("returns unknown when selectors fail", () => {
    const parsed = parseOpenaiDashboard("<html>no usage here</html>");
    expect(parsed.snapshot.certainty).toBe("unknown");
  });

  it("dry-runs redacted facts without persisting them", () => {
    const result = dryRunBrowserUsage({
      html: readFileSync(path.join(dir, "openai.html"), "utf8"),
      provider: "openai",
    });
    expect(result.persisted).toBe(false);
    expect(result.printed).not.toMatch(/sk-|cookie/i);
    expect(result.printed).toMatch(/remaining/i);
  });
});
