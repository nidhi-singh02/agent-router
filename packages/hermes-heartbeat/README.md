# Hermes heartbeat client

Call `wrapProviderRequest` around Hermes provider requests. This package does not
modify an external Hermes checkout.

```ts
import { createHeartbeatClient, wrapProviderRequest } from "@model-router/hermes-heartbeat";

const heartbeats = createHeartbeatClient({
  baseUrl: process.env.COORDINATOR_URL!,
  writerToken: process.env.COORDINATOR_WRITER_TOKEN!,
  fingerprintSecret: process.env.HEARTBEAT_FINGERPRINT_SECRET!,
});

export async function withHeartbeat<T>(accountId: string, run: () => Promise<T>): Promise<T> {
  return wrapProviderRequest(heartbeats, accountId, run);
}
```

Heartbeat failures are non-fatal. Confirm the Hermes checkout path before integrating.
