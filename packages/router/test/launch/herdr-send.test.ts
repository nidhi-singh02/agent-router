import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createHerdrClient,
  createProcessCommandAdapter,
  parseHerdrSendResult,
  resolveHerdrSendBin,
  type CommandResult,
} from "../../src/launch/herdr-client.js";
import { launchRoutedAgent } from "../../src/launch/herdr-launcher.js";

type Reply = Omit<CommandResult, "ok"> & { ok?: boolean };

/** A fake Herdr whose `herdr-send` exits as told; every call is recorded. */
function fakeHerdr(send: Reply, options: { waitOk?: boolean; agentGet?: string } = {}) {
  const calls: string[][] = [];
  const client = createHerdrClient(async (argv) => {
    calls.push([...argv]);
    if (argv[0] === "herdr-send") {
      return { ok: send.code === 0, ...send };
    }
    if (argv[1] === "agent" && argv[2] === "get") {
      const stdout = options.agentGet ?? "";
      return { ok: stdout !== "", code: stdout ? 0 : 1, stdout, stderr: "" };
    }
    if (argv[1] === "agent" && argv[2] === "wait") {
      const ok = options.waitOk ?? true;
      return { ok, code: ok ? 0 : 1, stdout: "", stderr: ok ? "" : "timeout" };
    }
    const pane = argv[1] === "pane" && argv[2] === "split";
    return { ok: true, code: 0, stdout: pane ? "w1:p9\n" : "", stderr: "" };
  });
  return { client, calls };
}

function followUp(herdr: ReturnType<typeof fakeHerdr>, handoff = "next phase") {
  return launchRoutedAgent({
    env: { HERDR_ENV: "1" },
    agent: "claude-code",
    launchName: "opus",
    effort: "high",
    handoff,
    dryRun: false,
    herdr: herdr.client,
    existingLaunchToken: "launch_1_abcd",
    existingPaneId: "w1:p9",
  });
}

function paneOnly(
  herdr: ReturnType<typeof fakeHerdr>,
  overrides: Partial<Parameters<typeof launchRoutedAgent>[0]> = {},
) {
  return launchRoutedAgent({
    env: { HERDR_ENV: "1" },
    agent: "cursor",
    launchName: "grok-4.6",
    effort: "medium",
    handoff: "next",
    dryRun: false,
    herdr: herdr.client,
    existingPaneId: "w1:p3",
    ...overrides,
  });
}

const json = (value: object) => `${JSON.stringify(value)}\n`;

describe("follow-up injection through herdr-send", () => {
  it("sends with --wait-idle, --timeout and --json, never --force, and nothing else", async () => {
    const herdr = fakeHerdr({
      code: 0,
      stdout: json({ result: "ok", state: "working" }),
      stderr: "",
    });
    const result = await followUp(herdr, "--looks-like-a-flag");
    expect(result).toMatchObject({ ok: true, paneId: "w1:p9", paneCreated: false });
    expect(herdr.calls).toHaveLength(1);
    const argv = herdr.calls[0]!;
    expect(argv[0]).toBe("herdr-send");
    expect(argv).not.toContain("--force");
    expect(argv.slice(1, 7)).toEqual(["--wait-idle", "15", "--timeout", "30000", "--json", "--"]);
    expect(argv[7]).toMatch(/^router-claude-[0-9a-f]{6}$/);
    expect(argv[8]).toBe("--looks-like-a-flag");
  });

  it("addresses the pane id when there is no launch token to name the agent", async () => {
    const herdr = fakeHerdr({ code: 0, stdout: json({ result: "ok" }), stderr: "" });
    const result = await paneOnly(herdr);
    const sends = herdr.calls.filter((argv) => argv[0] === "herdr-send");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.slice(-2)).toEqual(["w1:p3", "next"]);
    expect(result).toMatchObject({ ok: true, paneId: "w1:p3", paneCreated: false });
  });

  it("pane-only reuse invents no token or agent name, so reusing the result keeps the pane", async () => {
    const herdr = fakeHerdr({ code: 0, stdout: json({ result: "ok" }), stderr: "" });
    const first = await paneOnly(herdr);
    expect(first.launchToken).toBeUndefined();
    expect(first.agentName).toBeUndefined();
    // Reuse exactly what the first follow-up returned.
    const second = await paneOnly(herdr, {
      existingLaunchToken: first.launchToken,
      existingPaneId: first.paneId,
    });
    expect(second.ok).toBe(true);
    const targets = herdr.calls.filter((argv) => argv[0] === "herdr-send").map((argv) => argv[7]);
    expect(targets).toEqual(["w1:p3", "w1:p3"]);
    expect(herdr.calls.flat().some((arg) => /^router-/.test(arg))).toBe(false);
    expect(herdr.calls.some((argv) => argv[2] === "start" || argv[2] === "split")).toBe(false);
  });

  it("pane-only reuse records the agent's real Herdr name but still sends to the pane", async () => {
    const agentGet = json({
      result: { agent: { agent: "cursor", agent_status: "idle", pane_id: "w1:p3", name: "mine" } },
    });
    const herdr = fakeHerdr({ code: 0, stdout: json({ result: "ok" }), stderr: "" }, { agentGet });
    const result = await paneOnly(herdr);
    expect(result).toMatchObject({ ok: true, agentName: "mine", paneId: "w1:p3" });
    expect(result.launchToken).toBeUndefined();
    expect(herdr.calls.find((argv) => argv[0] === "herdr-send")!.slice(-2)).toEqual([
      "w1:p3",
      "next",
    ]);
  });

  it("pane-only reuse ignores a name Herdr reports for a different pane", async () => {
    const agentGet = json({
      result: { agent: { agent: "cursor", agent_status: "idle", pane_id: "w2:p1", name: "other" } },
    });
    const herdr = fakeHerdr({ code: 0, stdout: json({ result: "ok" }), stderr: "" }, { agentGet });
    const result = await paneOnly(herdr);
    expect(result.agentName).toBeUndefined();
  });

  it("pane-only exit 4: the extra wait targets the pane, not a derived name", async () => {
    const herdr = fakeHerdr(
      {
        code: 4,
        stdout: json({ result: "sent_unconfirmed", reason: "agent_prompt_stalled", state: "idle" }),
        stderr: "",
      },
      { waitOk: false },
    );
    const result = await paneOnly(herdr);
    expect(result).toMatchObject({ ok: false, sentUnconfirmed: true, paneId: "w1:p3" });
    expect(result.agentName).toBeUndefined();
    const wait = herdr.calls.find((argv) => argv[2] === "wait")!;
    expect(wait[3]).toBe("w1:p3");
  });

  it("pane-only dry run prints no launch token", async () => {
    const herdr = fakeHerdr({ code: 0, stdout: "", stderr: "" });
    const result = await paneOnly(herdr, { dryRun: true });
    expect(result).toMatchObject({ ok: true, paneCreated: false });
    expect(result.launchToken).toBeUndefined();
    expect(herdr.calls).toEqual([]);
  });

  it("ignores cwd when reusing an existing pane", async () => {
    const herdr = fakeHerdr({ code: 0, stdout: json({ result: "ok" }), stderr: "" });
    const result = await paneOnly(herdr, { cwd: "/definitely/not/a/dir" });
    expect(result.ok).toBe(true);
    expect(herdr.calls.flat()).not.toContain("--cwd");
    expect(herdr.calls.flat()).not.toContain("/definitely/not/a/dir");
  });

  it.each([
    ["blocked", /approval or a question/],
    ["agent_blocked", /approval or a question/],
    ["blocked_screen", /dialog is open/],
    ["unknown_state", /could not tell/],
    ["no_agent", /no agent/],
    ["dialog_check_unavailable", /screen could not be checked/],
  ])("exit 2 (%s): refuses once, tells a person to answer the pane", async (reason, hint) => {
    const herdr = fakeHerdr({
      code: 2,
      stdout: json({ result: "refused", reason, state: "blocked" }),
      stderr: "",
    });
    const result = await followUp(herdr);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`reason=${reason}`);
    expect(result.error).toMatch(hint);
    expect(result.error).toMatch(/Nothing was sent and the router will not retry/);
    expect(result.error).toMatch(/answer or check that pane yourself/);
    // No retry, no --force, no fallback to a raw prompt.
    expect(herdr.calls).toHaveLength(1);
    expect(result.sentUnconfirmed).toBeUndefined();
  });

  it("exit 3 while still busy: the --wait-idle deadline passed and nothing was sent", async () => {
    const herdr = fakeHerdr({
      code: 3,
      stdout: json({ result: "timeout", state: "busy" }),
      stderr: "",
    });
    const result = await followUp(herdr);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/stayed busy for 15s, so the follow-up was not sent/);
    expect(result.sentUnconfirmed).toBeUndefined();
    expect(herdr.calls).toHaveLength(1);
  });

  it("exit 3 after an idle send: accepted and working past the wait, so not an error", async () => {
    const herdr = fakeHerdr({
      code: 3,
      stdout: json({ result: "timeout", state: "idle" }),
      stderr: "",
    });
    const result = await followUp(herdr);
    expect(result.ok).toBe(true);
    expect(result.sentUnconfirmed).toBeUndefined();
    expect(herdr.calls).toHaveLength(1);
  });

  it.each([
    ["broken JSON", "{not json\n"],
    ["no output", ""],
    ["JSON without a state", json({ result: "timeout" })],
    ["a state herdr-send does not emit on exit 3", json({ result: "timeout", state: "blocked" })],
  ])("exit 3 with %s: delivery unknown, neither success nor retry", async (_label, stdout) => {
    const herdr = fakeHerdr({ code: 3, stdout, stderr: "" });
    const result = await followUp(herdr);
    expect(result.ok).toBe(false);
    expect(result.sentUnconfirmed).toBe(true);
    expect(result.error).toMatch(/without saying whether the follow-up was sent/);
    expect(result.error).toMatch(/Do not resend it/);
    expect(herdr.calls).toHaveLength(1);
  });

  it("exit 4: confirms with one more wait and never resends", async () => {
    const herdr = fakeHerdr({
      code: 4,
      stdout: json({ result: "sent_unconfirmed", reason: "agent_prompt_stalled", state: "idle" }),
      stderr: "",
    });
    const result = await followUp(herdr);
    expect(result.ok).toBe(true);
    expect(
      herdr.calls.map((argv) => argv[0] === "herdr-send" || argv.slice(1, 3).join(" ")),
    ).toEqual([true, "agent wait"]);
    expect(herdr.calls[1]).toEqual(
      expect.arrayContaining(["--until", "working", "--until", "blocked"]),
    );
  });

  it("exit 4 still unconfirmed: reports it as sent-unconfirmed with do-not-resend", async () => {
    const herdr = fakeHerdr(
      {
        code: 4,
        stdout: json({
          result: "sent_unconfirmed",
          reason: "agent_prompt_stalled",
          state: "idle",
          confirmed_by_screen: false,
        }),
        stderr: "",
      },
      { waitOk: false },
    );
    const result = await followUp(herdr);
    expect(result.ok).toBe(false);
    expect(result.sentUnconfirmed).toBe(true);
    expect(result.error).toMatch(/Do not resend it/);
    expect(herdr.calls.filter((argv) => argv[0] === "herdr-send")).toHaveLength(1);
  });

  it("exit 1: reports herdr-send's error code", async () => {
    const herdr = fakeHerdr({
      code: 1,
      stdout: json({ result: "error", reason: "herdr_error", state: "idle" }),
      stderr: "",
    });
    const result = await followUp(herdr);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/herdr-send failed .*exit 1, reason=herdr_error/);
  });

  it("a missing binary fails clearly instead of as a spawn error", async () => {
    const herdr = fakeHerdr({ code: 1, stdout: "", stderr: "Error: spawn herdr-send ENOENT" });
    const result = await followUp(herdr);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot send a follow-up .*ENOENT/);
  });

  it("does not spawn anything when herdr-send was not resolved", async () => {
    const calls: string[][] = [];
    const client = createHerdrClient(
      async (argv) => {
        calls.push([...argv]);
        return { ok: true, code: 0, stdout: "", stderr: "" };
      },
      { herdrSendMissing: "herdr-send was not found on PATH" },
    );
    const result = await followUp({ client, calls });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/herdr-send was not found on PATH/);
    expect(calls).toEqual([]);
  });

  it("uses the resolved herdr-send path", async () => {
    const calls: string[][] = [];
    const client = createHerdrClient(
      async (argv) => {
        calls.push([...argv]);
        return { ok: true, code: 0, stdout: json({ result: "ok" }), stderr: "" };
      },
      { herdrSendBin: "/opt/bin/herdr-send" },
    );
    await followUp({ client, calls });
    expect(calls[0]![0]).toBe("/opt/bin/herdr-send");
  });
});

describe("fresh launch handoff", () => {
  it("keeps the first handoff on `herdr agent prompt --until working --until blocked`", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "router-cwd-"));
    const herdr = fakeHerdr({ code: 0, stdout: "", stderr: "" });
    const result = await launchRoutedAgent({
      env: { HERDR_ENV: "1" },
      agent: "claude-code",
      launchName: "opus",
      effort: "high",
      handoff: "task",
      dryRun: false,
      herdr: herdr.client,
      cwd: dir,
    });
    expect(result.ok).toBe(true);
    expect(herdr.calls.some((argv) => argv[0] === "herdr-send")).toBe(false);
    const prompt = herdr.calls.find((argv) => argv[2] === "prompt")!;
    expect(prompt).toEqual(expect.arrayContaining(["--until", "working", "--until", "blocked"]));
    expect(herdr.calls[0]).toEqual([
      "herdr",
      "pane",
      "split",
      "--current",
      "--direction",
      "right",
      "--cwd",
      dir,
      "--no-focus",
    ]);
  });
});

describe("launch directory", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-cwd-"));
  const launch = (herdr: ReturnType<typeof fakeHerdr>, cwd: string) =>
    launchRoutedAgent({
      env: { HERDR_ENV: "1" },
      agent: "claude-code",
      launchName: "opus",
      effort: "high",
      handoff: "task",
      dryRun: false,
      herdr: herdr.client,
      cwd,
    });
  const splitCwd = (herdr: ReturnType<typeof fakeHerdr>) => {
    const split = herdr.calls.find((argv) => argv[2] === "split")!;
    return split[split.indexOf("--cwd") + 1];
  };

  it.each([
    ["spaces", "with some spaces"],
    ["Korean characters", "작업 폴더"],
  ])("passes a path with %s as one argv element, unquoted", async (_label, name) => {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    const herdr = fakeHerdr({ code: 0, stdout: "", stderr: "" });
    expect((await launch(herdr, dir)).ok).toBe(true);
    expect(splitCwd(herdr)).toBe(dir);
  });

  it("resolves a relative path against this process's directory, not Herdr's", async () => {
    const herdr = fakeHerdr({ code: 0, stdout: "", stderr: "" });
    const relative = path.relative(process.cwd(), root);
    expect(path.isAbsolute(relative)).toBe(false);
    expect((await launch(herdr, relative)).ok).toBe(true);
    expect(splitCwd(herdr)).toBe(root);
  });

  it("fails before splitting when the directory was deleted, without falling back", async () => {
    const dir = mkdtempSync(path.join(root, "gone-"));
    rmSync(dir, { recursive: true });
    const herdr = fakeHerdr({ code: 0, stdout: "", stderr: "" });
    const result = await launch(herdr, dir);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      `launch directory ${dir} does not exist or is not a directory; no pane was opened`,
    );
    expect(result.paneId).toBeUndefined();
    expect(herdr.calls).toEqual([]);
  });

  it("fails before splitting when the path is a file", async () => {
    const file = path.join(root, "a-file");
    writeFileSync(file, "");
    const herdr = fakeHerdr({ code: 0, stdout: "", stderr: "" });
    expect((await launch(herdr, file)).ok).toBe(false);
    expect(herdr.calls).toEqual([]);
  });
});

/**
 * Runs the real `herdr-send` wrapper (when installed) against a fake `herdr`, to check that
 * the argv the client builds is what the wrapper's parser expects and that its JSON matches
 * what the launcher reads. Skipped where herdr-send is not on PATH.
 */
describe.skipIf(resolveHerdrSendBin(process.env).bin === undefined)("real herdr-send", () => {
  const herdrSend = resolveHerdrSendBin(process.env).bin!;
  const dir = mkdtempSync(path.join(os.tmpdir(), "herdr-send-real-"));
  const log = path.join(dir, "calls.log");
  const fakeHerdrBin = path.join(dir, "herdr");
  // One line per call: the argv joined with US (0x1f).
  writeFileSync(
    fakeHerdrBin,
    [
      "#!/usr/bin/env bash",
      `(IFS=$'\x1f'; printf '%s\n' "$*") >> "$FAKE_HERDR_LOG"`,
      'case "$1 $2" in',
      '  "agent get") printf \'{"result":{"agent":{"agent_status":"%s"}}}\' "$FAKE_STATUS" ;;',
      '  "agent read") printf "screen" ;;',
      '  "agent prompt")',
      '    if [[ -n "${FAKE_PROMPT_ERROR:-}" ]]; then',
      '      printf \'{"error":{"code":"%s"}}\' "$FAKE_PROMPT_ERROR"; exit 1',
      "    fi",
      '    printf \'{"result":{"state":"working"}}\' ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const dialogLib = path.join(dir, "dialog.py");
  writeFileSync(dialogLib, "print('{\"has_dialog\": false}')\n");

  const run = (env: Record<string, string>) => {
    writeFileSync(log, "");
    return createHerdrClient(
      createProcessCommandAdapter({
        env: {
          ...process.env,
          HERDR_BIN_PATH: fakeHerdrBin,
          HERDR_DIALOG_LIB: dialogLib,
          FAKE_HERDR_LOG: log,
          ...env,
        },
      }),
      { herdrSendBin: herdrSend },
    );
  };
  const calls = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\x1f"));

  it("parses the client's argv: target and dash-leading text after `--`, timeout passed on", async () => {
    const client = run({ FAKE_STATUS: "idle" });
    const sent = await client.send({
      target: "w1:p3",
      text: "--looks-like-a-flag 작업",
      waitIdleSec: 15,
      timeoutMs: 30_000,
    });
    expect(sent).toEqual({ result: "ok", code: 0, state: "working" });
    expect(calls().find((argv) => argv[1] === "prompt")).toEqual([
      "agent",
      "prompt",
      "w1:p3",
      "--looks-like-a-flag 작업",
      "--wait",
      "--timeout",
      "30000",
    ]);
  });

  it("exit 3 after an idle send reports state idle, which the launcher treats as sent", async () => {
    const client = run({ FAKE_STATUS: "idle", FAKE_PROMPT_ERROR: "timeout" });
    const sent = await client.send({ target: "w1:p3", text: "t", waitIdleSec: 15, timeoutMs: 1 });
    expect(sent).toEqual({ result: "timeout", code: 3, state: "idle" });
  });

  it("exit 3 at the --wait-idle deadline reports state busy and sends nothing", async () => {
    const client = run({ FAKE_STATUS: "working" });
    const sent = await client.send({ target: "w1:p3", text: "t", waitIdleSec: 0, timeoutMs: 1 });
    expect(sent).toEqual({ result: "timeout", code: 3, state: "busy" });
    expect(calls().some((argv) => argv[1] === "prompt")).toBe(false);
  });

  it("exit 4 reports sent_unconfirmed with the screen hint", async () => {
    const client = run({ FAKE_STATUS: "idle", FAKE_PROMPT_ERROR: "agent_prompt_stalled" });
    const sent = await client.send({ target: "w1:p3", text: "t", waitIdleSec: 15, timeoutMs: 1 });
    expect(sent).toEqual({
      result: "sent_unconfirmed",
      code: 4,
      reason: "agent_prompt_stalled",
      state: "idle",
      confirmedByScreen: false,
    });
  });
});

describe("parseHerdrSendResult", () => {
  it("lets the exit code decide and JSON fill in reason and state", () => {
    expect(
      parseHerdrSendResult({
        ok: false,
        code: 2,
        stdout: json({ result: "refused", reason: "busy", state: "busy" }),
        stderr: "",
      }),
    ).toEqual({ result: "refused", code: 2, reason: "busy", state: "busy" });
    expect(
      parseHerdrSendResult({ ok: false, code: 1, stdout: "", stderr: "usage: herdr-send ..." }),
    ).toEqual({ result: "error", code: 1, detail: "usage: herdr-send ..." });
    expect(
      parseHerdrSendResult({
        ok: false,
        code: 4,
        stdout: json({
          result: "sent_unconfirmed",
          reason: "agent_prompt_stalled",
          state: "idle",
          confirmed_by_screen: true,
        }),
        stderr: "",
      }),
    ).toEqual({
      result: "sent_unconfirmed",
      code: 4,
      reason: "agent_prompt_stalled",
      state: "idle",
      confirmedByScreen: true,
    });
  });
});

describe("resolveHerdrSendBin", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "herdr-send-path-"));
  const bin = path.join(dir, "herdr-send");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const plain = path.join(dir, "not-executable");
  writeFileSync(plain, "", { mode: 0o644 });

  it("finds herdr-send on PATH", () => {
    expect(resolveHerdrSendBin({ PATH: `/nonexistent:${dir}` })).toEqual({ bin });
  });

  it("prefers HERDR_SEND_BIN", () => {
    expect(resolveHerdrSendBin({ PATH: "", HERDR_SEND_BIN: bin })).toEqual({ bin });
  });

  it("explains what is missing", () => {
    expect(resolveHerdrSendBin({ PATH: "/nonexistent" }).error).toMatch(
      /herdr-send was not found on PATH.*HERDR_SEND_BIN/,
    );
    expect(resolveHerdrSendBin({ PATH: dir, HERDR_SEND_BIN: plain }).error).toMatch(
      /is not an executable file/,
    );
  });

  it("does not take a directory for the executable", () => {
    const shadow = mkdtempSync(path.join(os.tmpdir(), "herdr-send-dir-"));
    mkdirSync(path.join(shadow, "herdr-send"));
    expect(resolveHerdrSendBin({ PATH: `${shadow}:${dir}` })).toEqual({ bin });
    expect(
      resolveHerdrSendBin({ PATH: "", HERDR_SEND_BIN: path.join(shadow, "herdr-send") }).error,
    ).toMatch(/is not an executable file/);
  });
});
