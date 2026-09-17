import { describe, expect, it } from "vitest";
import { createHeartbeatClient } from "../src/client.js";
import { serializeHeartbeat } from "../src/request-wrapper.js";

describe("heartbeat privacy", () => {
  it("serializes no telegram or task metadata", () => {
    const payload = serializeHeartbeat({
      accountFingerprint: "fp",
      modelFamily: "claude",
      reservedCapacity: 0.05,
      ttlSeconds: 15,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/telegram|username|message|prompt|task|nidhi|@/i);
    expect(payload).toEqual({
      accountFingerprint: "fp",
      modelFamily: "claude",
      reservedCapacity: 0.05,
      ttlSeconds: 15,
    });
  });

  it("keeps fingerprints out of payloads as raw account ids", async () => {
    const bodies: string[] = [];
    const client = createHeartbeatClient({
      baseUrl: "https://coordinator.example",
      writerToken: "writer",
      fingerprintSecret: "secret",
      fetchImpl: async (_url, init) => {
        bodies.push(String(init?.body ?? ""));
        return new Response(null, { status: 201 });
      },
    });
    await client.create("acct_shared_anthropic");
    expect(bodies.join()).not.toContain("acct_shared_anthropic");
  });
});
