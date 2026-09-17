import { accountFingerprint } from "./fingerprint.js";
import { randomUUID } from "node:crypto";
import {
  serializeHeartbeat,
  type HeartbeatClient,
  type HeartbeatLeaseHandle,
} from "./request-wrapper.js";

export interface HeartbeatClientOptions {
  baseUrl: string;
  writerToken: string;
  fingerprintSecret: string;
  fetchImpl?: typeof fetch;
  ttlSeconds?: number;
}

export function createHeartbeatClient(options: HeartbeatClientOptions): HeartbeatClient & {
  create(accountId: string): Promise<HeartbeatLeaseHandle>;
} {
  const parsedBaseUrl = new URL(options.baseUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsedBaseUrl.hostname);
  if (parsedBaseUrl.protocol !== "https:" && !(parsedBaseUrl.protocol === "http:" && loopback))
    throw new Error("coordinator URL must use HTTPS or HTTP loopback");
  const fetchImpl = options.fetchImpl ?? fetch;
  const ttlSeconds = options.ttlSeconds ?? 15;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  async function send(path: string, method: string, body?: unknown): Promise<void> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.writerToken}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`heartbeat request failed (${response.status})`);
  }
  return {
    renewalIntervalMs: Math.max(250, Math.floor((ttlSeconds * 1000 * 2) / 3)),
    async create(accountId: string) {
      const accountFingerprintValue = accountFingerprint(accountId, options.fingerprintSecret);
      const lease = { accountFingerprint: accountFingerprintValue, leaseId: randomUUID() };
      await send("/leases", "POST", {
        ...serializeHeartbeat({ accountFingerprint: accountFingerprintValue, ttlSeconds }),
        leaseId: lease.leaseId,
      });
      return lease;
    },
    async renew(lease) {
      await send(`/leases/${lease.accountFingerprint}/${lease.leaseId}/renew`, "POST", {
        ttlSeconds,
      });
    },
    async release(lease) {
      await send(`/leases/${lease.accountFingerprint}/${lease.leaseId}/release`, "POST");
    },
  };
}
