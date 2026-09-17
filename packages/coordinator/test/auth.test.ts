import { describe, expect, it } from "vitest";
import worker, { handleCoordinatorRequest, type CoordinatorEnv } from "../src/index.js";
import { requireRole } from "../src/auth.js";

const secrets = { writerSecret: "writer-secret", readerSecret: "reader-secret" };

describe("coordinator auth", () => {
  it("accepts only the matching bearer token for each role", () => {
    expect(requireRole("Bearer writer-secret", secrets, "writer")).toBe(true);
    expect(requireRole("Bearer reader-secret", secrets, "reader")).toBe(true);
    expect(requireRole("Bearer reader-secret", secrets, "writer")).toBe(false);
    expect(requireRole("Bearer writer-secret", secrets, "reader")).toBe(false);
  });

  it.each([
    ["no header", null],
    ["a non-bearer header", "Basic writer-secret"],
    ["an empty bearer token", "Bearer "],
    ["a wrong token of the same length", "Bearer writer-secreT"],
    ["a token that is a prefix of the secret", "Bearer writer"],
    ["a token longer than the secret", "Bearer writer-secret-extra"],
  ])("rejects %s", (_label, header) => {
    expect(requireRole(header, secrets, "writer")).toBe(false);
  });

  it.each([
    ["unset", { writerSecret: undefined, readerSecret: undefined }],
    ["empty", { writerSecret: "", readerSecret: "" }],
  ])("fails closed when the secrets are %s", (_label, missing) => {
    const env = missing as unknown as typeof secrets;
    for (const role of ["writer", "reader"] as const) {
      expect(requireRole(null, env, role)).toBe(false);
      expect(requireRole("Bearer ", env, role)).toBe(false);
      expect(requireRole("Bearer undefined", env, role)).toBe(false);
    }
  });

  it("rejects writes and status reads over HTTP when secrets are not configured", async () => {
    const env = {
      writerSecret: undefined,
      readerSecret: "",
      maxTtlSeconds: 30,
      store: new Map(),
      now: () => Date.parse("2026-09-17T09:00:00.000Z"),
    } as unknown as CoordinatorEnv;
    const write = await handleCoordinatorRequest(
      new Request("https://coordinator.example/leases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountFingerprint: "fp", ttlSeconds: 10 }),
      }),
      env,
    );
    expect(write.status).toBe(403);
    const read = await handleCoordinatorRequest(
      new Request("https://coordinator.example/accounts/fp/status"),
      env,
    );
    expect(read.status).toBe(403);
    expect(env.store.size).toBe(0);
  });

  it("rejects requests to the deployed worker entry when its secrets are missing", async () => {
    const response = await worker.fetch(
      new Request("https://coordinator.example/leases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountFingerprint: "fp", ttlSeconds: 10 }),
      }),
      { LEASES: undefined } as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(response.status).toBe(403);
  });
});
