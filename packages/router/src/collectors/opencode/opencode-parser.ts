export function parseOpenCodeStatus(raw: string): {
  harness: "opencode";
  authenticatedProviders: string[];
  models: Array<{ id: string; provider: string }>;
  usage?: never;
} {
  const data = JSON.parse(raw) as {
    harness?: string;
    authenticatedProviders?: string[];
    models?: Array<{ id: string; provider: string }>;
  };
  if (data.harness !== "opencode") {
    throw new Error("not an opencode status document");
  }
  return {
    harness: "opencode",
    authenticatedProviders: data.authenticatedProviders ?? [],
    models: data.models ?? [],
  };
}
