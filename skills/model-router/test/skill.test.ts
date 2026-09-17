import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skillDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("model-router skill", () => {
  it("stays thin and does not embed secrets or catalogs", () => {
    const skill = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    const prompts = readFileSync(path.join(skillDir, "test/prompts.md"), "utf8");
    expect(skill).toMatch(/router run/);
    expect(skill).toMatch(/--dry-run/);
    expect(skill).not.toMatch(/sk-|TYPESAFE_API_KEY=sk/);
    expect(skill).not.toMatch(/always pick grok/i);
    expect(prompts).toMatch(/## Route/);
    expect(prompts).toMatch(/## Status/);
    expect(prompts).toMatch(/## Refresh/);
    expect(prompts).toMatch(/## Resume/);
  });
});
