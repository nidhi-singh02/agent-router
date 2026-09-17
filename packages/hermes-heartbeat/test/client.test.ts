import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accountFingerprint } from "../src/fingerprint.js";
import { wrapProviderRequest } from "../src/request-wrapper.js";
import { createHeartbeatClient } from "../src/client.js";

describe("fingerprint", () => {
  it("is stable with the same secret and never contains the raw account id", () => {
    const first = accountFingerprint("acct_shared_anthropic", "secret");
    const second = accountFingerprint("acct_shared_anthropic", "secret");
    expect(first).toBe(second);
    expect(first).not.toContain("acct_shared_anthropic");
    expect(first).not.toBe(
      createHmac("sha256", "secret").update("acct_shared_anthropic").digest("hex"),
    );
  });

  it("is unlinkable without the secret", () => {
    const left = accountFingerprint("acct_shared_anthropic", "secret-a");
    const right = accountFingerprint("acct_shared_anthropic", "secret-b");
    expect(left).not.toBe(right);
  });
});

describe("request wrapper", () => {
  it("creates, renews conceptually via TTL, and releases around a provider request", async () => {
    const events: string[] = [];
    const client = createHeartbeatClient({
      baseUrl: "https://coordinator.example",
      writerToken: "writer",
      fingerprintSecret: "secret",
      fetchImpl: async (url, init) => {
        events.push(`${init?.method}:${new URL(url).pathname}`);
        return new Response(null, { status: url.includes("release") ? 204 : 201 });
      },
    });
    const result = await wrapProviderRequest(client, "acct_shared", async () => "ok");
    expect(result).toBe("ok");
    expect(events[0]).toMatch(/POST:\/leases$/);
    expect(events.at(-1)).toMatch(/release/);
  });

  it("does not fail the Hermes request when heartbeat writes fail", async () => {
    const client = createHeartbeatClient({
      baseUrl: "https://coordinator.example",
      writerToken: "writer",
      fingerprintSecret: "secret",
      fetchImpl: async () => {
        throw new Error("coordinator down");
      },
    });
    const diagnostics: string[] = [];
    const result = await wrapProviderRequest(client, "acct_shared", async () => 7, {
      onDiagnostic: (message) => diagnostics.push(message),
    });
    expect(result).toBe(7);
    expect(diagnostics[0]).toMatch(/heartbeat/i);
  });
});
