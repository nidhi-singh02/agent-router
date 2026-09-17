import { describe, expect, it } from "vitest";
import { handleCoordinatorRequest, type CoordinatorEnv } from "../src/index.js";
import { InMemoryLeaseRepository } from "../src/leases.js";

function env(overrides: Partial<CoordinatorEnv> = {}): CoordinatorEnv {
  return {
    writerSecret: "writer-secret",
    readerSecret: "reader-secret",
    maxTtlSeconds: 30,
    repository: new InMemoryLeaseRepository(),
    now: () => Date.parse("2026-09-17T09:00:00.000Z"),
    ...overrides,
  };
}

async function invoke(
  envValue: CoordinatorEnv,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return handleCoordinatorRequest(
    new Request(`https://coordinator.example${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    envValue,
  );
}

describe("heartbeat coordinator", () => {
  it("rejects a reader credential on write routes", async () => {
    const response = await invoke(
      env(),
      "POST",
      "/leases",
      { accountFingerprint: "abc", leaseId: "lease_1", ttlSeconds: 10 },
      {
        authorization: "Bearer reader-secret",
      },
    );
    expect(response.status).toBe(403);
  });

  it("creates, renews, and reads normalized status without listing raw leases", async () => {
    const writer = env();
    const created = await invoke(
      writer,
      "POST",
      "/leases",
      {
        accountFingerprint: "fp_shared",
        leaseId: "lease_1",
        ttlSeconds: 20,
        modelFamily: "claude",
        reservedCapacity: 0.05,
      },
      { authorization: "Bearer writer-secret" },
    );
    expect(created.status).toBe(201);

    const renewed = await invoke(
      writer,
      "POST",
      "/leases/fp_shared/lease_1/renew",
      { ttlSeconds: 20 },
      {
        authorization: "Bearer writer-secret",
      },
    );
    expect(renewed.status).toBe(200);

    const status = await invoke(writer, "GET", "/accounts/fp_shared/status", undefined, {
      authorization: "Bearer reader-secret",
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ activity: "active" });

    const list = await invoke(writer, "GET", "/leases", undefined, {
      authorization: "Bearer reader-secret",
    });
    expect(list.status).toBe(404);
  });

  it("returns inactive after expiry and deletes the row", async () => {
    let now = Date.parse("2026-09-17T09:00:00.000Z");
    const runtime = env({ now: () => now });
    await invoke(
      runtime,
      "POST",
      "/leases",
      { accountFingerprint: "fp", leaseId: "lease_1", ttlSeconds: 5 },
      {
        authorization: "Bearer writer-secret",
      },
    );
    now = Date.parse("2026-09-17T09:00:06.000Z");
    const status = await invoke(runtime, "GET", "/accounts/fp/status", undefined, {
      authorization: "Bearer reader-secret",
    });
    expect(await status.json()).toEqual({ activity: "inactive" });
  });

  it("rejects malformed input and oversize TTLs", async () => {
    const runtime = env();
    const bad = await invoke(
      runtime,
      "POST",
      "/leases",
      { accountFingerprint: "fp", leaseId: "lease_1", ttlSeconds: 999 },
      {
        authorization: "Bearer writer-secret",
      },
    );
    expect(bad.status).toBe(400);
    const missing = await invoke(
      runtime,
      "POST",
      "/leases",
      { ttlSeconds: 10 },
      {
        authorization: "Bearer writer-secret",
      },
    );
    expect(missing.status).toBe(400);
  });

  it("releases a lease", async () => {
    const runtime = env();
    await invoke(
      runtime,
      "POST",
      "/leases",
      { accountFingerprint: "fp", leaseId: "lease_1", ttlSeconds: 10 },
      {
        authorization: "Bearer writer-secret",
      },
    );
    const released = await invoke(runtime, "POST", "/leases/fp/lease_1/release", undefined, {
      authorization: "Bearer writer-secret",
    });
    expect(released.status).toBe(204);
    const status = await invoke(runtime, "GET", "/accounts/fp/status", undefined, {
      authorization: "Bearer reader-secret",
    });
    expect(await status.json()).toEqual({ activity: "inactive" });
  });

  it("releasing one overlapping lease keeps the account active", async () => {
    const runtime = env();
    for (const leaseId of ["lease_1", "lease_2"]) {
      expect(
        (
          await invoke(
            runtime,
            "POST",
            "/leases",
            { accountFingerprint: "fp", leaseId, ttlSeconds: 10 },
            { authorization: "Bearer writer-secret" },
          )
        ).status,
      ).toBe(201);
    }
    await invoke(runtime, "POST", "/leases/fp/lease_1/release", undefined, {
      authorization: "Bearer writer-secret",
    });
    const status = await invoke(runtime, "GET", "/accounts/fp/status", undefined, {
      authorization: "Bearer reader-secret",
    });
    expect(await status.json()).toEqual({ activity: "active" });
  });

  it("returns 400 for malformed JSON and percent encoding", async () => {
    const runtime = env();
    const malformed = await handleCoordinatorRequest(
      new Request("https://coordinator.example/leases", {
        method: "POST",
        headers: { authorization: "Bearer writer-secret", "content-type": "application/json" },
        body: "{",
      }),
      runtime,
    );
    expect(malformed.status).toBe(400);
    const encoded = await invoke(runtime, "POST", "/leases/%E0%A4%A/lease/release", undefined, {
      authorization: "Bearer writer-secret",
    });
    expect(encoded.status).toBe(400);
  });
});
