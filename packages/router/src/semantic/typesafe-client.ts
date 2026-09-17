import {
  TypeSafeClient,
  type Questions,
  type SystemOneRequest,
  type SystemOneResult,
} from "@typesafe-ai/sdk";

export interface TypeSafePort {
  calls: SystemOneRequest[];
  systemOne<const Q extends Questions>(request: SystemOneRequest<Q>): Promise<SystemOneResult<Q>>;
}

export function createRecordingClient(inner: Pick<TypeSafeClient, "systemOne">): TypeSafePort {
  const calls: SystemOneRequest[] = [];
  return {
    calls,
    async systemOne(request) {
      assertSafeState(request.state);
      calls.push(request as SystemOneRequest);
      return inner.systemOne(request);
    },
  };
}

export function createLiveTypeSafeClient(apiKey: string): TypeSafePort {
  return createRecordingClient(new TypeSafeClient({ apiKey }));
}

const FORBIDDEN = /sk-[A-Za-z0-9_-]+|cookie|telegram|Bearer\s+\S+/i;

export function assertSafeState(state: unknown): void {
  const serialized = JSON.stringify(state);
  if (FORBIDDEN.test(serialized)) {
    throw new Error("TypeSafe state contains forbidden sensitive data");
  }
}
