import { describe, expect, it } from "vitest";
import { assertSafeState } from "../../src/semantic/typesafe-client.js";

describe("assertSafeState", () => {
  it("allows legitimate task text that mentions Telegram or cookie", () => {
    expect(() =>
      assertSafeState({
        task: "Reply on Telegram after the session cookie banner copy is approved.",
      }),
    ).not.toThrow();
  });

  it("still rejects actual secret values", () => {
    expect(() => assertSafeState({ task: "token sk-secret-123" })).toThrow(/forbidden/i);
    expect(() => assertSafeState({ authorization: "Bearer sk-secret-123" })).toThrow(/forbidden/i);
  });
});
