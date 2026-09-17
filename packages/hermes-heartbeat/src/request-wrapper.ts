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
  create(accountId: string): Promise<void>;
  renew(accountId: string): Promise<void>;
  release(accountId: string): Promise<void>;
}

export async function wrapProviderRequest<T>(
  client: HeartbeatClient,
  accountId: string,
  operation: () => Promise<T>,
  options: { onDiagnostic?: (message: string) => void } = {},
): Promise<T> {
  try {
    await client.create(accountId);
  } catch (error) {
    options.onDiagnostic?.(`heartbeat create failed: ${String(error)}`);
  }
  try {
    return await operation();
  } finally {
    try {
      await client.release(accountId);
    } catch (error) {
      options.onDiagnostic?.(`heartbeat release failed: ${String(error)}`);
    }
  }
}
