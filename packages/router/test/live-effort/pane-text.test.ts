import { describe, expect, it } from "vitest";
import {
  claudeCacheWarningOpen,
  codexInPlanMode,
  codexStatusEffort,
  inputLineState,
  lastClaudeOutcome,
  newClaudeOutcome,
} from "../../src/live-effort/pane-text.js";

const RULE = "─".repeat(40);
const DIM = (text: string) => `\u001b[2m${text}\u001b[0m`;

describe("inputLineState", () => {
  it("reads an empty Claude input box", () => {
    expect(inputLineState("claude", [RULE, "❯\u00a0", RULE, "  Opus 5.5 high"].join("\n"))).toBe(
      "empty",
    );
  });

  it("reads a Claude draft, including one wrapped onto the next line", () => {
    expect(inputLineState("claude", [RULE, "❯\u00a0lets push this", RULE].join("\n"))).toBe("busy");
    expect(inputLineState("claude", [RULE, "❯\u00a0", "  wrapped text", RULE].join("\n"))).toBe(
      "busy",
    );
  });

  it("treats dim placeholder text as empty", () => {
    expect(
      inputLineState("claude", [RULE, `❯\u00a0${DIM('Try "fix lint"')}`, RULE].join("\n")),
    ).toBe("empty");
    expect(
      inputLineState("codex", `› ${DIM("Ask Codex to do anything")}\n\n  GPT-6-Astra low`),
    ).toBe("empty");
  });

  it("uses the last prompt line, not one in the transcript above", () => {
    const screen = ["❯ /rename old", "  ⎿  Session renamed", RULE, "❯\u00a0", RULE].join("\n");
    expect(inputLineState("claude", screen)).toBe("empty");
  });

  it("fails closed when no input line is on screen", () => {
    expect(inputLineState("claude", "Working…")).toBe("unknown");
    expect(inputLineState("codex", "")).toBe("unknown");
  });

  it("ignores Codex's animated Braille particles on an empty input line", () => {
    const grey = (text: string) => `\u001b[38;2;163;165;169m${text}\u001b[0m`;
    const line = `› ${DIM("Ask Codex to do anything")}   ${grey("⠂")}      ${grey("⢀")}`;
    expect(inputLineState("codex", `${line}\n\n  GPT-6-Astra low`)).toBe("empty");
    expect(inputLineState("codex", `› fix it ${grey("⠂")}`)).toBe("busy");
  });

  it("reads a Codex draft", () => {
    expect(inputLineState("codex", "› half-typed\n")).toBe("busy");
  });
});

describe("Codex screen", () => {
  it("reads the effort from the model-with-reasoning status item", () => {
    expect(codexStatusEffort("  GPT-6-Astra medium · ~/Code/x")).toBe("medium");
    expect(codexStatusEffort("  gpt-6-astra xhigh")).toBe("xhigh");
    expect(codexStatusEffort("  ~/Code/x")).toBeUndefined();
  });

  it("detects Plan mode from the footer", () => {
    expect(codexInPlanMode("  gpt-6-astra medium    Plan mode (shift+tab to cycle)")).toBe(true);
    expect(codexInPlanMode("  gpt-6-astra medium")).toBe(false);
    // Codex 0.156.1 drops the hint when the status line is shown.
    expect(
      codexInPlanMode("› x\n\n  GPT-6-Astra medium · ~/Code/x      Plan mode    ⚠ 7 warnings"),
    ).toBe(true);
    expect(
      codexInPlanMode("• Wrote the Plan mode notes\n› \n\n  GPT-6-Astra medium\n  footer"),
    ).toBe(false);
  });
});

describe("Claude /effort outcomes", () => {
  it("recognizes each outcome", () => {
    expect(
      lastClaudeOutcome("⎿  Set effort level to high (this session only): x")?.outcome,
    ).toEqual({
      kind: "session-only",
      level: "high",
    });
    expect(
      lastClaudeOutcome("⎿  Set effort level to high (saved as your default for new sessions)")
        ?.outcome,
    ).toEqual({ kind: "saved-default", level: "high" });
    // The dialog is read from the bottom of the screen, never from scrollback.
    expect(lastClaudeOutcome("Change effort level?")).toBeUndefined();
    expect(claudeCacheWarningOpen("work\nChange effort level?\n❯ 1. Yes, switch to high")).toBe(
      true,
    );
    expect(
      claudeCacheWarningOpen(
        ["Change effort level?", ...Array.from({ length: 14 }, (_, i) => `later ${i}`)].join("\n"),
      ),
    ).toBe(false);
    expect(lastClaudeOutcome("  ⎿  Kept effort level as medium")?.outcome).toEqual({
      kind: "kept",
      level: "medium",
    });
  });

  it("ignores an outcome that was already the latest one before the switch", () => {
    const old = "⎿  Set effort level to high (this session only): x";
    expect(newClaudeOutcome(old, `${old}\nmore output`)).toBeUndefined();
  });

  it("accepts a repeat of the same message when it is new", () => {
    const old = "⎿  Set effort level to high (this session only): x";
    expect(newClaudeOutcome(old, `${old}\n${old}`)).toEqual({
      kind: "session-only",
      level: "high",
    });
  });

  it("accepts a different latest outcome", () => {
    const before = "⎿  Set effort level to high (this session only): x";
    const after = `${before}\n⎿  Set effort level to low (this session only): x`;
    expect(newClaudeOutcome(before, after)).toEqual({ kind: "session-only", level: "low" });
  });
});
