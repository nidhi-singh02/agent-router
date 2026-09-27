import { describe, expect, it } from "vitest";
import { liveEffortCallerEnv } from "../../src/commands/runtime.js";
import { toSignalShapes } from "../../src/live-effort/signals.js";

describe("live effort privacy", () => {
  it("buckets every count at its edges and carries no caller secret", () => {
    const bucket = (signals: Parameters<typeof toSignalShapes>[0]) => toSignalShapes(signals);
    expect(
      [0, 1, 2, 3, 99].map((n) => bucket({ consecutiveFailures: n }).consecutiveFailures),
    ).toEqual(["0", "1", "2", "3+", "3+"]);
    expect([0, 1, 5, 6, 20, 21].map((n) => bucket({ filesTouched: n }).filesTouched)).toEqual([
      "0",
      "1-5",
      "1-5",
      "6-20",
      "6-20",
      "21+",
    ]);
    expect([0, 49, 50, 299, 300, 999, 1000].map((n) => bucket({ diffLines: n }).diffLines)).toEqual(
      ["<50", "<50", "50-300", "50-300", "300-1000", "300-1000", "1000+"],
    );
    expect(bucket({ testsFailing: false, blocked: true })).toEqual({
      testsFailing: false,
      blocked: true,
    });
    expect(bucket({})).toEqual({});

    expect(
      liveEffortCallerEnv({
        HERDR_PANE_ID: "wJ:p1",
        CLAUDE_EFFORT: "high",
        CLAUDE_CONFIG_DIR: "/cfg",
        HOME: "/home/dev",
        CLAUDECODE: "1",
        CODEX_THREAD_ID: "t1",
        CODEX_SANDBOX: "seatbelt",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        TYPESAFE_API_KEY: "ts-secret",
        PATH: "/usr/bin",
        CLAUDE_EFFORT_EMPTY: "",
      }),
    ).toEqual({
      HERDR_PANE_ID: "wJ:p1",
      CLAUDE_EFFORT: "high",
      CLAUDECODE: "1",
      CODEX_THREAD_ID: "t1",
      CODEX_SANDBOX: "seatbelt",
    });
    expect(liveEffortCallerEnv({ HERDR_PANE_ID: "" })).toEqual({});
  });
});
