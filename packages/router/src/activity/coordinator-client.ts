import { isSecureCoordinatorUrl } from "../config/config-schema.js";

export type CoordinatorActivity =
  "inactive" | "active" | "constrained" | "unauthorized" | "stale" | "unreachable";

export interface CoordinatorClient {
  status(accountFingerprint: string): Promise<CoordinatorActivity>;
}

export function createCoordinatorClient(input: {
  baseUrl: string;
  readerToken: string;
  fetchImpl?: typeof fetch;
}): CoordinatorClient {
  if (!isSecureCoordinatorUrl(input.baseUrl))
    throw new Error("coordinator URL must use HTTPS or HTTP loopback");
  const fetchImpl = input.fetchImpl ?? fetch;
  return {
    async status(accountFingerprint: string) {
      try {
        const response = await fetchImpl(`${input.baseUrl}/accounts/${accountFingerprint}/status`, {
          headers: { authorization: `Bearer ${input.readerToken}` },
        });
        if (response.status === 401 || response.status === 403) {
          return "unauthorized";
        }
        if (!response.ok) {
          return "unreachable";
        }
        const body = (await response.json()) as { activity?: CoordinatorActivity };
        return body.activity ?? "unreachable";
      } catch {
        return "unreachable";
      }
    },
  };
}
