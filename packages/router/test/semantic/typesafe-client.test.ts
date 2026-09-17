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
