import type { CoordinatorActivity, CoordinatorClient } from "./coordinator-client.js";

export async function readSharedActivity(input: {
  account: { id: string; ownership: "personal" | "shared" };
  client: Pick<CoordinatorClient, "status">;
}): Promise<{
  activity: CoordinatorActivity;
  ownerMessage?: string;
  conservative: boolean;
}> {
  if (input.account.ownership !== "shared") {
    return { activity: "inactive", conservative: false };
  }
  try {
    const activity = await input.client.status(input.account.id);
    if (activity === "active") {
      return {
        activity,
        ownerMessage: "shared subscription currently active",
        conservative: false,
      };
    }
    if (activity === "unreachable" || activity === "unauthorized" || activity === "stale") {
      return { activity: "constrained", conservative: true };
    }
    return { activity, conservative: activity === "constrained" };
  } catch {
    return { activity: "constrained", conservative: true };
  }
}
