export interface HeartbeatPayload {
  accountFingerprint: string;
  modelFamily?: string;
  reservedCapacity?: number;
  ttlSeconds: number;
}

export function serializeHeartbeat(payload: HeartbeatPayload): HeartbeatPayload {
  return {
    accountFingerprint: payload.accountFingerprint,
    modelFamily: payload.modelFamily,
    reservedCapacity: payload.reservedCapacity,
    ttlSeconds: payload.ttlSeconds,
  };
}

export interface HeartbeatClient {
  create(accountId: string): Promise<HeartbeatLeaseHandle>;
  renew(lease: HeartbeatLeaseHandle): Promise<void>;
  release(lease: HeartbeatLeaseHandle): Promise<void>;
  renewalIntervalMs?: number;
}

export interface HeartbeatLeaseHandle {
  accountFingerprint: string;
  leaseId: string;
}

export async function wrapProviderRequest<T>(
  client: HeartbeatClient,
  accountId: string,
  operation: () => Promise<T>,
  options: { onDiagnostic?: (message: string) => void } = {},
): Promise<T> {
  let lease: HeartbeatLeaseHandle | undefined;
  let renewal: ReturnType<typeof setInterval> | undefined;
  try {
    lease = await client.create(accountId);
    if (client.renewalIntervalMs && client.renewalIntervalMs > 0) {
      renewal = setInterval(() => {
        void client.renew(lease!).catch(() => options.onDiagnostic?.("heartbeat renew failed"));
      }, client.renewalIntervalMs);
    }
  } catch {
    options.onDiagnostic?.("heartbeat create failed");
  }
  try {
    return await operation();
  } finally {
    if (renewal) clearInterval(renewal);
    try {
      if (lease) await client.release(lease);
    } catch {
      options.onDiagnostic?.("heartbeat release failed");
    }
  }
}
