import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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
  it("rejects remote plaintext base URLs before sending the writer token", () => {
    let called = false;
    expect(() =>
      createHeartbeatClient({
        baseUrl: "http://example.com",
        writerToken: "writer-secret",
        fingerprintSecret: "secret",
        fetchImpl: async () => {
          called = true;
          return new Response();
        },
      }),
    ).toThrow(/https|loopback/i);
    expect(called).toBe(false);
  });
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
        throw new Error("coordinator down with writer-secret and acct_shared");
      },
    });
    const diagnostics: string[] = [];
    const result = await wrapProviderRequest(client, "acct_shared", async () => 7, {
      onDiagnostic: (message) => diagnostics.push(message),
    });
    expect(result).toBe(7);
    expect(diagnostics[0]).toMatch(/heartbeat/i);
    expect(diagnostics.join(" ")).not.toMatch(/writer-secret|acct_shared/);
  });

  it.each([401, 403, 404, 429, 500])(
    "rejects coordinator HTTP %s without exposing the body",
    async (status) => {
      const client = createHeartbeatClient({
        baseUrl: "https://coordinator.example/",
        writerToken: "writer-secret",
        fingerprintSecret: "fingerprint-secret",
        fetchImpl: async () => new Response("secret response body", { status }),
      });
      await expect(client.create("acct_shared")).rejects.toThrow(
        `heartbeat request failed (${status})`,
      );
      await expect(client.create("acct_shared")).rejects.not.toThrow(
        /secret response body|writer-secret|acct_shared/,
      );
    },
  );

  it("normalizes a trailing slash and uses a unique lease path", async () => {
    const urls: string[] = [];
    const client = createHeartbeatClient({
      baseUrl: "https://coordinator.example/",
      writerToken: "writer",
      fingerprintSecret: "secret",
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response(null, { status: 201 });
      },
    });
    const lease = await client.create("acct_shared");
    await client.release(lease);
    expect(urls[0]).toBe("https://coordinator.example/leases");
    expect(urls[1]).toContain(`/leases/${lease.accountFingerprint}/${lease.leaseId}/release`);
  });

  it("keeps overlapping operations isolated and renews a long operation", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const client = createHeartbeatClient({
      baseUrl: "https://coordinator.example",
      writerToken: "writer",
      fingerprintSecret: "secret",
      ttlSeconds: 3,
      fetchImpl: async (url) => {
        events.push(new URL(String(url)).pathname);
        return new Response(null, { status: 200 });
      },
    });
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = wrapProviderRequest(
      client,
      "acct",
      () => new Promise<void>((resolve) => (finishFirst = resolve)),
    );
    const second = wrapProviderRequest(
      client,
      "acct",
      () => new Promise<void>((resolve) => (finishSecond = resolve)),
    );
    await vi.advanceTimersByTimeAsync(2_100);
    expect(events.filter((path) => path.endsWith("/renew"))).toHaveLength(2);
    finishFirst();
    await first;
    expect(events.filter((path) => path.endsWith("/release"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(events.filter((path) => path.endsWith("/renew"))).toHaveLength(3);
    finishSecond();
    await second;
    vi.useRealTimers();
  });
});
