import { accountFingerprint } from "./fingerprint.js";
import { serializeHeartbeat, type HeartbeatClient } from "./request-wrapper.js";

export interface HeartbeatClientOptions {
  baseUrl: string;
  writerToken: string;
  fingerprintSecret: string;
  fetchImpl?: typeof fetch;
  ttlSeconds?: number;
}

export function createHeartbeatClient(options: HeartbeatClientOptions): HeartbeatClient & {
  create(accountId: string): Promise<void>;
} {
  const fetchImpl = options.fetchImpl ?? fetch;
  const ttlSeconds = options.ttlSeconds ?? 15;
  async function send(path: string, method: string, body?: unknown): Promise<void> {
    await fetchImpl(`${options.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.writerToken}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  return {
    async create(accountId: string) {
      const accountFingerprintValue = accountFingerprint(accountId, options.fingerprintSecret);
      await send(
        "/leases",
        "POST",
        serializeHeartbeat({ accountFingerprint: accountFingerprintValue, ttlSeconds }),
      );
    },
    async renew(accountId: string) {
      const fingerprint = accountFingerprint(accountId, options.fingerprintSecret);
      await send(`/leases/${fingerprint}/renew`, "POST", { ttlSeconds });
    },
    async release(accountId: string) {
      const fingerprint = accountFingerprint(accountId, options.fingerprintSecret);
      await send(`/leases/${fingerprint}/release`, "POST");
    },
  };
}
