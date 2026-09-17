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

const SENSITIVE_PATTERNS = [
  /\b(?:sk-[A-Za-z0-9_-]+|Bearer\s+\S+|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+)\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bAIza[A-Za-z0-9_-]{30,}\b/,
  /\b(?:password|passwd|secret|cookie|authorization)\s*[:=]\s*\S+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'/:@]+:[^\s"'@]+@[^\s"']+/i,
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/,
];

export function assertSafeState(state: unknown): void {
  const serialized = JSON.stringify(state);
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(serialized))) {
    throw new Error("TypeSafe state contains forbidden sensitive data");
  }
}
