import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSafeState, createRecordingClient } from "../../src/semantic/typesafe-client.js";

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

  it.each([
    ["GitHub token", "github_pat_1234567890abcdefghijklmnop"],
    ["Slack bot token", "xoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwxyzABCD"],
    ["Slack user token", "xoxp-123456789012-123456789012-abcdefghijklmnopqrstuvwxyzABCD"],
    ["AWS access-key ID", "AKIAIOSFODNN7EXAMPLE"],
    ["Google API key", "AIzaSyA1234567890abcdefghijklmnopqrst"],
    ["password", "password=hunter2"],
    ["cookie", "cookie: session=abc123"],
    ["private key", "-----BEGIN PRIVATE KEY-----"],
    ["credential URL", "postgres://user:password@db.example/app"],
    ["AMQP credential URL", "amqps://worker:queue-password@mq.example/vhost"],
    ["generic credential URL", "custom+tls://agent:service-password@host.example/path"],
    ["Telegram token", "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"],
  ])("rejects %s without echoing its value", (_label, secret) => {
    expect(() => assertSafeState({ task: `debug ${secret}` })).toThrow(/sensitive/i);
    try {
      assertSafeState({ task: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it.each([
    "Discuss Slack xoxb token rotation without including the token.",
    "The AWS key prefix is AKIA.",
    "Document an amqps service URL with credentials removed.",
  ])("allows benign credential-related prose: %s", (task) => {
    expect(() => assertSafeState({ task })).not.toThrow();
  });
});

describe("createRecordingClient", () => {
  afterEach(() => vi.useRealTimers());

  const request = { state: { task: "Implement the plan" }, questions: {} };
  const result = { model: "fake-jev", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } };

  it.each(["503 Service temporarily unavailable", "Temporarily Unavailable"])(
    "retries %s once after 600ms and records both attempts",
    async (message) => {
      vi.useFakeTimers();
      const systemOne = vi.fn().mockRejectedValueOnce(new Error(message)).mockResolvedValue(result);
      const client = createRecordingClient({ systemOne });
      const pending = client.systemOne(request);
      await vi.advanceTimersByTimeAsync(599);
      expect(systemOne).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual(result);
      expect(systemOne.mock.calls).toEqual([[request], [request]]);
      expect(client.calls).toEqual([request, request]);
      expect(client.traces).toEqual([
        { request, success: false, error: message },
        { request, success: true },
      ]);
    },
  );

  it("rethrows the second failure without another retry", async () => {
    vi.useFakeTimers();
    const error = new Error("503 still unavailable");
    const systemOne = vi.fn().mockRejectedValue(error);
    const client = createRecordingClient({ systemOne });
    const assertion = expect(client.systemOne(request)).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await assertion;
    expect(systemOne).toHaveBeenCalledTimes(2);
    expect(client.traces).toEqual([
      { request, success: false, error: error.message },
      { request, success: false, error: error.message },
    ]);
  });

  it("does not retry unrelated errors", async () => {
    const error = new Error("401 Unauthorized");
    const systemOne = vi.fn().mockRejectedValue(error);
    const client = createRecordingClient({ systemOne });
    await expect(client.systemOne(request)).rejects.toBe(error);
    expect(systemOne).toHaveBeenCalledTimes(1);
    expect(client.traces).toEqual([{ request, success: false, error: error.message }]);
  });
});
