import { describe, expect, it } from "vitest";
import { executeEffort, type EffortDeps } from "../../src/commands/effort.js";
import { AccountSchema } from "../../src/domain/account.js";
import { switchEffort } from "../../src/live-effort/switcher.js";
import { FakePane, noSleep } from "./fake-pane.js";
import { effortTypeSafe, launchedSession, opusAccount, opusModel, store } from "./fixtures.js";

const NOW = new Date("2026-09-26T10:00:00.000Z");

function setup(overrides: Partial<EffortDeps> = {}) {
  const { sessions, effortChanges } = store();
  sessions.save(launchedSession({ agent: "claude-code", effort: "medium" }));
  const pane = new FakePane({ agent: "claude", level: "medium" });
  const deps: EffortDeps = {
    sessions,
    effortChanges,
    pane,
    client: effortTypeSafe("high"),
    accounts: [opusAccount],
    models: [opusModel],
    usage: {},
    env: { HERDR_PANE_ID: "wJ:p1", CLAUDECODE: "1" },
    liveEffortEnabled: true,
    now: () => NOW,
    sleep: noSleep,
    switchTimeoutMs: 100,
    ...overrides,
  };
  return { deps, sessions, pane };
}

describe("review pass 2 regressions", () => {
  it("refuses a session id that a newer in-place phase has superseded", async () => {
    const { deps, sessions, pane } = setup();
    sessions.save(
      launchedSession({
        id: "sess_newer",
        agent: "claude-code",
        effort: "medium",
        extras: { createdAt: "2026-09-26T09:30:00.000Z", continuation: "in-place" },
      }),
    );
    const old = await executeEffort("sess_live", { kind: "manual", level: "high" }, deps);
    expect(old).toMatchObject({ code: 4, json: { reason: "superseded-session", ok: false } });
    expect(pane.keys).toEqual([]);
    const current = await executeEffort("sess_newer", { kind: "manual", level: "high" }, deps);
    expect(current).toMatchObject({ code: 0, json: { ok: true, status: "applied" } });
  });

  it("names a missing Herdr, and reports ok only for a switch", async () => {
    const { deps } = setup({ pane: undefined });
    expect(await executeEffort("sess_live", { kind: "manual", level: "high" }, deps)).toMatchObject(
      { code: 4, json: { ok: false, reason: "not-in-herdr" } },
    );
  });

  it("gives exit 2 the same JSON shape as every other result", async () => {
    const { deps } = setup();
    expect(await executeEffort("sess_nope", { kind: "manual", level: "high" }, deps)).toMatchObject(
      {
        code: 2,
        json: { ok: false, sessionId: "sess_nope", status: "failed", reason: "unknown-session" },
      },
    );
  });

  it("refuses a manual raise on a shared account with no known usage", async () => {
    const shared = AccountSchema.parse({ ...opusAccount, ownership: "shared", reserveFloor: 0.4 });
    const { deps, pane } = setup({ accounts: [shared] });
    expect(await executeEffort("sess_live", { kind: "manual", level: "high" }, deps)).toMatchObject(
      { code: 4, json: { reason: "quota" } },
    );
    expect(pane.keys).toEqual([]);
  });

  it("does not mistake a quoted slider hint in the conversation for the slider", async () => {
    const pane = new FakePane({
      agent: "claude",
      level: "medium",
      sliderBroken: true,
      history: ["⏺ The hint reads ←/→ adjust · enter confirm · s for this session only"],
    });
    const result = await switchEffort(
      {
        agent: "claude-code",
        paneId: pane.paneId,
        agentName: pane.agentName,
        from: "medium",
        to: "high",
        callerIsTarget: false,
        callerEnv: {},
      },
      { pane, sleep: noSleep, timeoutMs: 100, pollMs: 10 },
    );
    expect(result).toMatchObject({ status: "failed", reason: "slider-not-opened" });
    expect(pane.keys).toEqual(["enter"]);
  });
});
