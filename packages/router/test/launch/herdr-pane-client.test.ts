import { describe, expect, it } from "vitest";
import { createHerdrPaneClient, parseHerdrAgentInfo } from "../../src/launch/herdr-client.js";

describe("herdr pane client", () => {
  it("parses `herdr agent get`, failing closed on anything unexpected", () => {
    const agent = {
      agent: "claude",
      agent_status: "working",
      pane_id: "wJ:p1",
      cwd: "/repo",
      agent_session: { value: "0f8e1a2b-3c4d" },
    };
    expect(parseHerdrAgentInfo(`${JSON.stringify({ result: { agent } })}\n`)).toEqual({
      agent: "claude",
      status: "working",
      paneId: "wJ:p1",
    });
    expect(
      parseHerdrAgentInfo(
        JSON.stringify({
          result: { agent: { agent: "codex", agent_status: "napping", pane_id: "p" } },
        }),
      ),
    ).toEqual({ agent: "codex", status: "unknown", paneId: "p" });
    expect(parseHerdrAgentInfo(JSON.stringify({ result: { agent: { agent: "claude" } } }))).toBe(
      undefined,
    );
    expect(parseHerdrAgentInfo(JSON.stringify({ result: {} }))).toBeUndefined();
    expect(parseHerdrAgentInfo("not json")).toBeUndefined();
  });

  it("builds the Herdr argv for each call and hides failed reads", async () => {
    const calls: string[][] = [];
    let ok = true;
    const pane = createHerdrPaneClient(async (argv) => {
      calls.push([...argv]);
      return { ok, code: ok ? 0 : 1, stdout: ok ? "screen" : "", stderr: "" };
    });
    expect(await pane.readPane("wJ:p1", { source: "visible", lines: 60, ansi: true })).toBe(
      "screen",
    );
    await pane.readPane("wJ:p1", { source: "recent", lines: 200 });
    await pane.sendKeys("wJ:p1", ["left", "s"]);
    await pane.sendText("wJ:p1", "/effort");
    expect(calls).toEqual([
      [
        "herdr",
        "pane",
        "read",
        "wJ:p1",
        "--source",
        "visible",
        "--lines",
        "60",
        "--format",
        "ansi",
      ],
      [
        "herdr",
        "pane",
        "read",
        "wJ:p1",
        "--source",
        "recent",
        "--lines",
        "200",
        "--format",
        "text",
      ],
      ["herdr", "pane", "send-keys", "wJ:p1", "left", "s"],
      ["herdr", "pane", "send-text", "wJ:p1", "/effort"],
    ]);
    ok = false;
    expect(await pane.readPane("wJ:p1", { source: "visible", lines: 1 })).toBeUndefined();
    expect(await pane.getAgent("router-claude-abc")).toBeUndefined();
    expect(calls.at(-1)).toEqual(["herdr", "agent", "get", "router-claude-abc"]);
  });
});
