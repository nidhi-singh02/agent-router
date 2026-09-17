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
    expect(prompts).toMatch(/## Phase complete/);
  });

  it("routes the next phase through the recorded session after asking the user", () => {
    const skill = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    expect(skill).toMatch(/Router session:/);
    expect(skill).toMatch(/## End of a phase/);
    expect(skill).toMatch(/router session <id>/);
    expect(skill).toMatch(/router run --session <id> "<next-phase task>" --dry-run/);
    expect(skill).toMatch(/ask whether to route the next phase/i);
    expect(skill).toMatch(/Do not route again for the phase you are still in/);
  });
});
