import { describe, expect, it } from "vitest";
import { accountFingerprint } from "@model-router/hermes-heartbeat";
import { readSharedActivity } from "../../src/activity/activity-service.js";

const account = {
  id: "acct_shared",
  ownership: "shared" as const,
};

describe("activity service", () => {
  it("maps coordinator states without exposing identity", async () => {
    const client = {
      status: async () => "active" as const,
    };
    const result = await readSharedActivity({ account, client });
    expect(result.ownerMessage).toBe("shared subscription currently active");
    expect(JSON.stringify(result)).not.toMatch(/telegram|friend|@/i);
  });

  it("derives the coordinator lookup key with the HMAC fingerprint contract", async () => {
    const secret = "test-fingerprint-secret";
    const seen: string[] = [];
    const result = await readSharedActivity({
      account,
      fingerprintSecret: secret,
      client: {
        status: async (lookup) => {
          seen.push(lookup);
          return "inactive";
        },
      },
    });
    expect(result.activity).toBe("inactive");
    expect(seen).toEqual([accountFingerprint(account.id, secret)]);
    expect(seen[0]).not.toContain("acct_shared");
  });

  it("treats outages conservatively for shared accounts", async () => {
    await expect(
      readSharedActivity({
        account,
        client: {
          status: async () => {
            throw new Error("timeout");
          },
        },
      }),
    ).resolves.toMatchObject({
      activity: "constrained",
      conservative: true,
      coordinatorUnavailable: true,
    });
  });

  it.each(["unreachable", "unauthorized", "stale"] as const)(
    "marks a %s coordinator as unavailable",
    async (state) => {
      await expect(
        readSharedActivity({ account, client: { status: async () => state } }),
      ).resolves.toMatchObject({ conservative: true, coordinatorUnavailable: true });
    },
  );

  it("does not mark an explicit constrained status as unavailable", async () => {
    await expect(
      readSharedActivity({ account, client: { status: async () => "constrained" } }),
    ).resolves.toMatchObject({ conservative: true, coordinatorUnavailable: false });
  });
});
