import { accountFingerprint } from "@model-router/hermes-heartbeat";
import type { CoordinatorActivity, CoordinatorClient } from "./coordinator-client.js";

export async function readSharedActivity(input: {
  account: { id: string; ownership: "personal" | "shared" };
  client: Pick<CoordinatorClient, "status">;
  fingerprintSecret?: string;
}): Promise<{
  activity: CoordinatorActivity;
  ownerMessage?: string;
  conservative: boolean;
}> {
  if (input.account.ownership !== "shared") {
    return { activity: "inactive", conservative: false };
  }
  try {
    const lookup = input.fingerprintSecret
      ? accountFingerprint(input.account.id, input.fingerprintSecret)
      : input.account.id;
    const activity = await input.client.status(lookup);
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
