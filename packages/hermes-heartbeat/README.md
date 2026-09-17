# Hermes heartbeat client

Call `wrapProviderRequest` around Hermes provider requests. This package does not
modify an external Hermes checkout.

```ts
import { createHeartbeatClient, wrapProviderRequest } from "@agent-router/hermes-heartbeat";

const heartbeats = createHeartbeatClient({
  baseUrl: process.env.COORDINATOR_URL!,
  writerToken: process.env.COORDINATOR_WRITER_TOKEN!,
  fingerprintSecret: process.env.HEARTBEAT_FINGERPRINT_SECRET!,
});

export async function withHeartbeat<T>(accountId: string, run: () => Promise<T>): Promise<T> {
  return wrapProviderRequest(heartbeats, accountId, run);
}
```

Heartbeat failures are non-fatal to the wrapped provider request, but non-2xx coordinator
responses produce sanitized diagnostics. Each wrapped request gets an independent lease,
renews it below the configured TTL, and releases only that lease. Confirm the Hermes
checkout path before integrating.
