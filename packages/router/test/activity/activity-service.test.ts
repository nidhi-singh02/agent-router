import { describe, expect, it } from "vitest";
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
    ).resolves.toMatchObject({ activity: "constrained", conservative: true });
  });
});
