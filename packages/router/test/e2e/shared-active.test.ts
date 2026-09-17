import { describe, expect, it } from "vitest";
import { executeRun } from "../../src/commands/run.js";
import { readSharedActivity } from "../../src/activity/activity-service.js";
import {
  claudeModel,
  cursorModel,
  fakeTypeSafe,
  now,
  personal,
  shared,
  usageFor,
} from "../cli/fixtures.js";

describe("shared activity and reserve", () => {
  it("excludes a shared account below 40% before TypeSafe ranking", async () => {
    const client = fakeTypeSafe({ family: "implementation" });
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: true },
      {
        accounts: [personal, shared],
        models: [cursorModel, claudeModel],
        usage: {
          [personal.id]: usageFor(personal.id, 0.9),
          [shared.id]: usageFor(shared.id, 0.41, { activeReservationRatio: 0.02 }),
        },
        client,
        env: {},
        now,
      },
    );
    expect(result.code).toBe(0);
    expect(JSON.stringify(result.json)).not.toContain(shared.id);
    expect(client.calls.some((call) => "route" in call.questions)).toBe(true);
    const ranked = client.calls.find((call) => "route" in call.questions);
    expect(JSON.stringify(ranked)).not.toContain(shared.id);
  });

  it("shows only the owner-visible shared activity phrase", async () => {
    const activity = await readSharedActivity({
      account: shared,
      client: { status: async () => "active" },
    });
    expect(activity.ownerMessage).toBe("shared subscription currently active");
    expect(JSON.stringify(activity)).not.toMatch(/family claude|telegram/i);
  });

  it("treats coordinator outage conservatively for shared accounts", async () => {
    const activity = await readSharedActivity({
      account: shared,
      client: {
        status: async () => {
          throw new Error("unreachable");
        },
      },
    });
    expect(activity.conservative).toBe(true);
    expect(activity.activity).toBe("constrained");
  });
});
