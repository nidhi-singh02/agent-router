import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli.js";
import { executeRun, type RunDeps } from "../../src/commands/run.js";
import { createHerdrClient } from "../../src/launch/herdr-client.js";
import { ReservationService } from "../../src/reservations/reservation-service.js";
import { openDatabase } from "../../src/store/database.js";
import { ReservationRepository } from "../../src/store/reservation-repository.js";
import { SessionRepository } from "../../src/store/session-repository.js";
import { createGitRunner, type GitRunner } from "../../src/workspace/git-worktree.js";
import type { RouterSession } from "../../src/domain/session.js";
import {
  claudeModel,
  cursorModel,
  fakeTypeSafe,
  now,
  personal,
  shared,
  usageFor,
} from "./fixtures.js";
import {
  branches,
  checkoutState,
  cleanupTempDirs,
  git,
  head,
  initRepo,
  tempDir,
  worktreePaths,
} from "../workspace/git-fixtures.js";

afterAll(cleanupTempDirs);

interface HerdrCall {
  argv: string[];
  /** For a pane split with --cwd: the files visible in that directory at launch time. */
  visible?: string[];
}

/** A fake Herdr that records every command and never starts a process. */
function fakeHerdr(options: { failStart?: boolean } = {}) {
  const calls: HerdrCall[] = [];
  const client = createHerdrClient(async (argv) => {
    const call: HerdrCall = { argv: [...argv] };
    const cwdAt = argv.indexOf("--cwd");
    if (argv[1] === "pane" && argv[2] === "split" && cwdAt !== -1) {
      const dir = argv[cwdAt + 1]!;
      call.visible = existsSync(dir)
        ? git(dir, "ls-files", "--others", "--cached").split("\n")
        : [];
    }
    calls.push(call);
    if (options.failStart && argv[1] === "agent" && argv[2] === "start") {
      return {
        ok: false,
        code: 1,
        stdout: JSON.stringify({ error: { code: "agent_not_detected", message: "no agent" } }),
        stderr: "",
      };
    }
    return { ok: true, code: 0, stdout: "pane_wt\n", stderr: "" };
  });
  const splits = () => calls.filter((call) => call.argv[1] === "pane" && call.argv[2] === "split");
  const starts = () => calls.filter((call) => call.argv[1] === "agent" && call.argv[2] === "start");
  const prompts = () =>
    calls.filter((call) => call.argv[1] === "agent" && call.argv[2] === "prompt");
  const splitCwd = (index = 0) => {
    const argv = splits()[index]?.argv ?? [];
    const at = argv.indexOf("--cwd");
    return at === -1 ? undefined : argv[at + 1];
  };
  return { client, calls, splits, starts, prompts, splitCwd };
}

function setup(options: { repoName?: string; base?: string } = {}) {
  const base = options.base ?? tempDir();
  const repo = initRepo(path.join(base, options.repoName ?? "repo"));
  const home = path.join(base, "router home");
  const db = openDatabase({ home });
  const sessions = new SessionRepository(db);
  const reservations = new ReservationService(Date.now, new ReservationRepository(db));
  const herdr = fakeHerdr();
  const deps: RunDeps = {
    accounts: [personal],
    models: [cursorModel],
    usage: { [personal.id]: usageFor(personal.id, 0.8) },
    client: fakeTypeSafe({ family: "implementation", phase: "implementation" }),
    env: { HERDR_ENV: "1" },
    now,
    herdr: herdr.client,
    sessions,
    reservations,
    cwd: repo,
    worktreeRoot: path.join(home, "worktrees"),
  };
  return { base, repo, home, db, sessions, reservations, herdr, deps };
}

type RunJson = {
  ok: boolean;
  sessionId?: string;
  error?: string;
  workspace?: {
    isolated: boolean;
    action: string;
    created: boolean;
    path: string;
    branch: string;
    baseCommit: string;
    repository: { gitCommonDir: string; sourceRoot: string };
  };
};

async function run(
  deps: RunDeps,
  task: string,
  options: Partial<Parameters<typeof executeRun>[1]> = {},
) {
  const result = await executeRun(task, { dryRun: false, worktree: true, ...options }, deps);
  return { ...result, json: result.json as RunJson };
}

async function cli(home: string, args: string[]) {
  let out = "";
  let err = "";
  const write = (sink: (chunk: string) => void) => ({
    write(chunk: string) {
      sink(chunk);
      return true;
    },
  });
  const code = await runCli(["node", "router", ...args], {
    stdout: write((chunk) => (out += chunk)),
    stderr: write((chunk) => (err += chunk)),
    env: { MODEL_ROUTER_HOME: home },
  });
  return { out, err, code };
}

function spyGit(): { git: GitRunner; calls: string[][] } {
  const real = createGitRunner();
  const calls: string[][] = [];
  return {
    calls,
    git: (args, cwd) => {
      calls.push(args);
      return real(args, cwd);
    },
  };
}

describe("router run --worktree", () => {
  it("creates a unique branch and worktree from HEAD and launches the agent in it", async () => {
    const ctx = setup();
    const before = checkoutState(ctx.repo);
    const result = await run(ctx.deps, "Implement the approved plan.");

    expect(result.code).toBe(0);
    const workspace = result.json.workspace!;
    expect(workspace).toMatchObject({
      isolated: true,
      action: "create",
      created: true,
      baseCommit: before.head,
      repository: {
        gitCommonDir: realpathSync(path.join(ctx.repo, ".git")),
        sourceRoot: realpathSync(ctx.repo),
      },
    });
    expect(workspace.branch).toMatch(/^router\/wt-/);
    expect(head(ctx.repo, workspace.branch)).toBe(before.head);
    expect(worktreePaths(ctx.repo)).toContain(workspace.path);
    expect(path.relative(realpathSync(ctx.repo), workspace.path)).toMatch(/^\.\./);
    expect(ctx.herdr.splitCwd()).toBe(workspace.path);
    expect(result.output).toContain(`Workspace: created worktree ${workspace.path}`);

    // The router owns workspace creation; no native agent worktree flag is passed.
    const startArgs = ctx.herdr.starts()[0]!.argv;
    expect(startArgs).not.toContain("--worktree");
    expect(startArgs).not.toContain("-w");
    expect(ctx.herdr.prompts()[0]!.argv[4]).toContain(
      `Workspace: isolated Git worktree ${workspace.path} on branch ${workspace.branch}`,
    );

    const session = ctx.sessions.get(result.json.sessionId!)!;
    expect(session.workspace).toEqual({
      isolated: true,
      path: workspace.path,
      branch: workspace.branch,
      repository: workspace.repository,
      baseCommit: before.head,
      createdAt: expect.any(String),
    });
    expect(checkoutState(ctx.repo)).toEqual(before);
    ctx.db.close();
  });

  it("isolates two tasks from each other and from the original checkout", async () => {
    const ctx = setup();
    const before = checkoutState(ctx.repo);
    const first = await run(ctx.deps, "Implement feature A.");
    const second = await run(ctx.deps, "Implement feature B.");
    const a = first.json.workspace!;
    const b = second.json.workspace!;

    expect(a.path).not.toBe(b.path);
    expect(a.branch).not.toBe(b.branch);
    expect(ctx.herdr.splitCwd(0)).toBe(a.path);
    expect(ctx.herdr.splitCwd(1)).toBe(b.path);

    writeFileSync(path.join(a.path, "a.txt"), "from A\n");
    writeFileSync(path.join(a.path, "README.md"), "edited in A\n");
    writeFileSync(path.join(b.path, "b.txt"), "from B\n");
    git(b.path, "add", "b.txt");
    git(b.path, "commit", "--quiet", "-m", "B work");

    expect(existsSync(path.join(b.path, "a.txt"))).toBe(false);
    expect(readFileSync(path.join(b.path, "README.md"), "utf8")).toBe("hello\n");
    expect(existsSync(path.join(a.path, "b.txt"))).toBe(false);
    expect(existsSync(path.join(ctx.repo, "a.txt"))).toBe(false);
    expect(existsSync(path.join(ctx.repo, "b.txt"))).toBe(false);
    expect(readFileSync(path.join(ctx.repo, "README.md"), "utf8")).toBe("hello\n");
    expect(head(ctx.repo, a.branch)).toBe(before.head);
    expect(head(ctx.repo, b.branch)).not.toBe(before.head);
    // Branch, HEAD, index, working files, and stash of the original checkout are unchanged.
    expect(checkoutState(ctx.repo)).toEqual(before);
    ctx.db.close();
  });

  it("handles a repository path containing spaces", async () => {
    const ctx = setup({ base: tempDir("router wt space "), repoName: "my project repo" });
    const result = await run(ctx.deps, "Implement the approved plan.");
    expect(result.code).toBe(0);
    const workspace = result.json.workspace!;
    expect(workspace.repository.sourceRoot).toBe(realpathSync(ctx.repo));
    expect(workspace.path).toContain("router home");
    expect(ctx.herdr.splitCwd()).toBe(workspace.path);
    expect(existsSync(path.join(workspace.path, "README.md"))).toBe(true);
    ctx.db.close();
  });

  it("never interpolates task text into Git arguments", async () => {
    const ctx = setup();
    const spy = spyGit();
    const task = "Fix it\"; touch pwned; echo \"$(whoami) `id` 'quoted'";
    const result = await run({ ...ctx.deps, git: spy.git }, task);
    expect(result.code).toBe(0);
    for (const args of spy.calls) {
      for (const arg of args) {
        expect(arg).not.toContain("pwned");
        expect(arg).not.toContain("whoami");
      }
    }
    expect(existsSync(path.join(ctx.repo, "pwned"))).toBe(false);
    ctx.db.close();
  });

  it.each([
    [
      "staged",
      (repo: string) => {
        writeFileSync(path.join(repo, "staged.txt"), "s\n");
        git(repo, "add", "staged.txt");
      },
    ],
    ["unstaged", (repo: string) => writeFileSync(path.join(repo, "README.md"), "local edit\n")],
    ["untracked", (repo: string) => writeFileSync(path.join(repo, "notes.txt"), "mine\n")],
  ])("rejects a checkout with %s changes without touching them", async (_kind, dirty) => {
    const ctx = setup();
    dirty(ctx.repo);
    const before = checkoutState(ctx.repo);
    const files = ["README.md", "staged.txt", "notes.txt"].map((file) =>
      existsSync(path.join(ctx.repo, file))
        ? readFileSync(path.join(ctx.repo, file), "utf8")
        : undefined,
    );
    const result = await run(ctx.deps, "Implement the approved plan.");

    expect(result.code).toBe(2);
    expect(result.output).toMatch(/needs a clean checkout/);
    expect(result.output).toMatch(/does not touch them/);
    expect(ctx.herdr.calls).toEqual([]);
    expect((ctx.deps.client as { calls: unknown[] }).calls).toEqual([]);
    expect(worktreePaths(ctx.repo)).toHaveLength(1);
    expect(branches(ctx.repo)).toEqual(["main"]);
    expect(ctx.sessions.latest()).toBeUndefined();
    expect(checkoutState(ctx.repo)).toEqual(before);
    expect(
      ["README.md", "staged.txt", "notes.txt"].map((file) =>
        existsSync(path.join(ctx.repo, file))
          ? readFileSync(path.join(ctx.repo, file), "utf8")
          : undefined,
      ),
    ).toEqual(files);
    ctx.db.close();
  });

  it("accepts ignored files in the source checkout", async () => {
    const ctx = setup();
    mkdirSync(path.join(ctx.repo, "build"));
    writeFileSync(path.join(ctx.repo, "build", "out.js"), "x\n");
    const result = await run(ctx.deps, "Implement the approved plan.");
    expect(result.code).toBe(0);
    expect(existsSync(path.join(result.json.workspace!.path, "build"))).toBe(false);
    ctx.db.close();
  });

  it("rejects a non-Git directory before routing, panes, or agents", async () => {
    const ctx = setup();
    const outside = tempDir();
    const result = await run({ ...ctx.deps, cwd: outside }, "Implement the approved plan.");
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/--worktree needs a Git repository/);
    expect(result.json).toMatchObject({ ok: false });
    expect(ctx.herdr.calls).toEqual([]);
    expect((ctx.deps.client as { calls: unknown[] }).calls).toEqual([]);
    expect(ctx.sessions.latest()).toBeUndefined();
    expect(ctx.reservations.activeRatio(personal.id)).toBe(0);
    ctx.db.close();
  });

  it("does not launch anywhere when worktree creation fails", async () => {
    const ctx = setup();
    const before = checkoutState(ctx.repo);
    const real = createGitRunner();
    const failingAdd: GitRunner = (args, cwd) =>
      args[0] === "worktree" && args[1] === "add"
        ? Promise.resolve({ ok: false, stdout: "", stderr: "fatal: simulated failure\n" })
        : real(args, cwd);
    const result = await run({ ...ctx.deps, git: failingAdd }, "Implement the approved plan.");

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/Worktree creation failed; no agent was launched/);
    expect(result.output).toContain("simulated failure");
    expect(ctx.herdr.calls).toEqual([]);
    expect(ctx.sessions.latest()).toBeUndefined();
    expect(ctx.reservations.activeRatio(personal.id)).toBe(0);
    expect(checkoutState(ctx.repo)).toEqual(before);
    ctx.db.close();
  });

  it("keeps and reports the worktree when agent startup fails", async () => {
    const ctx = setup();
    const herdr = fakeHerdr({ failStart: true });
    const result = await run({ ...ctx.deps, herdr: herdr.client }, "Implement the approved plan.");

    expect(result.code).toBe(1);
    const workspace = result.json.workspace!;
    expect(existsSync(workspace.path)).toBe(true);
    expect(worktreePaths(ctx.repo)).toContain(workspace.path);
    expect(branches(ctx.repo)).toContain(workspace.branch);
    expect(result.output).toContain("herdr agent start failed");
    expect(result.output).toContain(
      `The worktree was kept, not deleted: ${workspace.path} (branch ${workspace.branch}).`,
    );
    expect(result.json).toMatchObject({ ok: false, error: expect.stringMatching(/agent start/) });
    // The pane Herdr created was in the worktree, never the original checkout.
    expect(herdr.splitCwd()).toBe(workspace.path);
    const session = ctx.sessions.latest()!;
    expect(session.route?.status).toBe("launch-failed");
    expect(session.workspace?.path).toBe(workspace.path);
    expect(ctx.reservations.activeRatio(personal.id)).toBe(0);
    ctx.db.close();
  });

  it("previews a dry run without creating a branch, worktree, pane, session, or reservation", async () => {
    const ctx = setup();
    const before = checkoutState(ctx.repo);
    const tryCreate = vi.spyOn(ctx.reservations, "tryCreate");
    const create = vi.spyOn(ctx.reservations, "create");
    const result = await run(ctx.deps, "Implement the approved plan.", { dryRun: true });

    expect(result.code).toBe(0);
    const workspace = result.json.workspace!;
    expect(workspace).toMatchObject({ isolated: true, action: "create", created: false });
    expect(result.output).toContain(
      `Workspace: would create worktree ${workspace.path} on new branch ${workspace.branch} from ${before.head.slice(0, 12)} (main)`,
    );
    expect(existsSync(workspace.path)).toBe(false);
    expect(existsSync(path.join(ctx.home, "worktrees"))).toBe(false);
    expect(branches(ctx.repo)).toEqual(["main"]);
    expect(worktreePaths(ctx.repo)).toHaveLength(1);
    expect(ctx.herdr.calls).toEqual([]);
    expect(ctx.sessions.latest()).toBeUndefined();
    expect(tryCreate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(ctx.reservations.activeRatio(personal.id)).toBe(0);
    expect(checkoutState(ctx.repo)).toEqual(before);
    ctx.db.close();
  });

  it("keeps the TypeSafe calls of a dry run the same with and without --worktree", async () => {
    const ctx = setup();
    const plain = fakeTypeSafe({ family: "implementation", phase: "implementation" });
    const isolated = fakeTypeSafe({ family: "implementation", phase: "implementation" });
    const withoutFlag = await executeRun(
      "Implement the approved plan.",
      { dryRun: true },
      { ...ctx.deps, client: plain },
    );
    const withFlag = await run({ ...ctx.deps, client: isolated }, "Implement the approved plan.", {
      dryRun: true,
    });
    expect(withFlag.code).toBe(withoutFlag.code);
    expect(isolated.calls).toEqual(plain.calls);
    for (const call of isolated.calls) {
      expect(JSON.stringify(call)).not.toContain(ctx.repo);
    }
    ctx.db.close();
  });

  it("reports a dirty checkout in a dry run as well", async () => {
    const ctx = setup();
    writeFileSync(path.join(ctx.repo, "wip.txt"), "wip\n");
    const result = await run(ctx.deps, "Implement the approved plan.", { dryRun: true });
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/needs a clean checkout/);
    ctx.db.close();
  });
});

describe("continuing an isolated session", () => {
  async function isolatedSession(ctx: ReturnType<typeof setup>, phase = "planning") {
    const first = await run(ctx.deps, "Plan the billing feature.");
    expect(first.code).toBe(0);
    const session = ctx.sessions.get(first.json.sessionId!)!;
    ctx.sessions.save({ ...session, phase: phase as RouterSession["phase"] });
    return { id: session.id, workspace: session.workspace! };
  }

  it("reuses the recorded worktree and sees the previous phase's uncommitted files", async () => {
    const ctx = setup();
    const { id, workspace } = await isolatedSession(ctx);
    writeFileSync(path.join(workspace.path, "plan.md"), "the plan\n");
    const worktreesBefore = worktreePaths(ctx.repo);
    const branchesBefore = branches(ctx.repo);

    const next = await run(ctx.deps, "Implement the plan in plan.md.", {
      previousSessionId: id,
      worktree: undefined,
    });

    expect(next.code).toBe(0);
    expect(next.json.workspace).toMatchObject({
      action: "reuse",
      created: false,
      path: workspace.path,
      branch: workspace.branch,
    });
    expect(ctx.herdr.splitCwd(1)).toBe(workspace.path);
    expect(ctx.herdr.splits()[1]!.visible).toContain("plan.md");
    expect(readFileSync(path.join(workspace.path, "plan.md"), "utf8")).toBe("the plan\n");
    expect(worktreePaths(ctx.repo)).toEqual(worktreesBefore);
    expect(branches(ctx.repo)).toEqual(branchesBefore);
    expect(next.output).toContain(`Workspace: reused worktree ${workspace.path}`);
    const saved = ctx.sessions.get(next.json.sessionId!)!;
    expect(saved.previousSessionId).toBe(id);
    expect(saved.workspace).toEqual(workspace);
    ctx.db.close();
  });

  it("does not create a second worktree when --worktree is passed again", async () => {
    const ctx = setup();
    const { id, workspace } = await isolatedSession(ctx);
    const count = worktreePaths(ctx.repo).length;
    const next = await run(ctx.deps, "Implement it.", { previousSessionId: id, worktree: true });
    expect(next.code).toBe(0);
    expect(next.json.workspace?.path).toBe(workspace.path);
    expect(worktreePaths(ctx.repo)).toHaveLength(count);
    ctx.db.close();
  });

  it("uses the recorded workspace when continued from another directory", async () => {
    const ctx = setup();
    const { id, workspace } = await isolatedSession(ctx);
    const elsewhere = tempDir();
    const next = await run({ ...ctx.deps, cwd: elsewhere }, "Implement it.", {
      previousSessionId: id,
      worktree: undefined,
    });
    expect(next.code).toBe(0);
    expect(ctx.herdr.splitCwd(1)).toBe(workspace.path);
    ctx.db.close();
  });

  it("lets the next phase use a different agent in the same worktree", async () => {
    const ctx = setup();
    ctx.deps.accounts = [personal, shared];
    ctx.deps.models = [cursorModel, claudeModel];
    ctx.deps.usage = {
      [personal.id]: usageFor(personal.id, 0.8),
      [shared.id]: usageFor(shared.id, 0.95),
    };
    ctx.deps.client = fakeTypeSafe({
      family: "planning",
      phase: "planning",
      route: `${personal.id}:${cursorModel.id}`,
    });
    const first = await run(ctx.deps, "Plan the billing feature.");
    expect(first.code).toBe(0);
    const workspace = first.json.workspace!;
    expect(ctx.herdr.starts()[0]!.argv).toContain("cursor");

    const next = await run(
      {
        ...ctx.deps,
        client: fakeTypeSafe({
          family: "implementation",
          phase: "implementation",
          route: `${shared.id}:${claudeModel.id}`,
        }),
      },
      "Implement the plan.",
      { previousSessionId: first.json.sessionId, worktree: undefined },
    );
    expect(next.code).toBe(0);
    expect(ctx.herdr.starts()[1]!.argv).toEqual(expect.arrayContaining(["--kind", "claude"]));
    expect(ctx.herdr.splitCwd(1)).toBe(workspace.path);
    ctx.db.close();
  });

  it("refuses to continue when the recorded worktree is missing", async () => {
    const ctx = setup();
    const { id, workspace } = await isolatedSession(ctx);
    git(ctx.repo, "worktree", "remove", "--force", workspace.path);
    const splitsBefore = ctx.herdr.splits().length;
    const next = await run(ctx.deps, "Implement it.", {
      previousSessionId: id,
      worktree: undefined,
    });
    expect(next.code).toBe(2);
    expect(next.output).toContain(`Recorded workspace no longer exists: ${workspace.path}`);
    expect(next.output).toMatch(/does not fall back to the current directory/);
    expect(ctx.herdr.splits()).toHaveLength(splitsBefore);
    ctx.db.close();
  });

  it("refuses to continue when the repository identity does not match", async () => {
    const ctx = setup();
    const { id, workspace } = await isolatedSession(ctx);
    const other = initRepo(path.join(ctx.base, "other"));
    const session = ctx.sessions.get(id)!;
    ctx.sessions.save({
      ...session,
      workspace: {
        ...workspace,
        repository: {
          gitCommonDir: realpathSync(path.join(other, ".git")),
          sourceRoot: realpathSync(other),
        },
      },
    });
    const splitsBefore = ctx.herdr.splits().length;
    const next = await run(ctx.deps, "Implement it.", {
      previousSessionId: id,
      worktree: undefined,
    });
    expect(next.code).toBe(2);
    expect(next.output).toMatch(/belongs to a different repository/);
    expect(ctx.herdr.splits()).toHaveLength(splitsBefore);
    expect(next.json).toMatchObject({ ok: false, workspace: { path: workspace.path } });
    ctx.db.close();
  });

  it("refuses to continue when the worktree is on another branch", async () => {
    const ctx = setup();
    const { id, workspace } = await isolatedSession(ctx);
    git(workspace.path, "checkout", "--quiet", "-b", "moved");
    const next = await run(ctx.deps, "Implement it.", {
      previousSessionId: id,
      worktree: undefined,
    });
    expect(next.code).toBe(2);
    expect(next.output).toMatch(/expected branch router\/wt-/);
    ctx.db.close();
  });

  it("keeps the old behavior for sessions without workspace metadata", async () => {
    const ctx = setup();
    const first = await executeRun("Plan the billing feature.", { dryRun: false }, ctx.deps);
    const old = ctx.sessions.get((first.json as RunJson).sessionId!)!;
    expect(old.workspace).toBeUndefined();
    ctx.sessions.save({ ...old, phase: "planning" });
    const spy = spyGit();
    const next = await executeRun(
      "Implement the plan.",
      { dryRun: false, previousSessionId: old.id },
      { ...ctx.deps, git: spy.git, cwd: tempDir() },
    );
    expect(next.code).toBe(0);
    expect(spy.calls).toEqual([]);
    expect(ctx.herdr.splitCwd(1)).toBeUndefined();
    expect(next.json).not.toHaveProperty("workspace");
    expect(worktreePaths(ctx.repo)).toHaveLength(1);
    ctx.db.close();
  });
});

describe("runs without --worktree", () => {
  it("make no Git calls and split the pane exactly as before", async () => {
    const ctx = setup();
    const spy = spyGit();
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: false },
      { ...ctx.deps, git: spy.git },
    );
    expect(result.code).toBe(0);
    expect(spy.calls).toEqual([]);
    expect(ctx.herdr.splits()[0]!.argv).toEqual([
      "herdr",
      "pane",
      "split",
      "--current",
      "--direction",
      "right",
      "--no-focus",
    ]);
    expect(result.json).not.toHaveProperty("workspace");
    expect(result.output).not.toContain("Workspace:");
    expect(ctx.sessions.latest()?.workspace).toBeUndefined();
    ctx.db.close();
  });
});

describe("workspace metadata in session output", () => {
  it("shows the workspace in human-readable and JSON session output", async () => {
    const ctx = setup();
    const result = await run(ctx.deps, "Implement the approved plan.");
    const workspace = result.json.workspace!;
    ctx.db.close();

    const human = await cli(ctx.home, ["session", result.json.sessionId!]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("Workspace isolation: enabled");
    expect(human.out).toContain(`Worktree: ${workspace.path}`);
    expect(human.out).toContain(`Branch: ${workspace.branch}`);
    expect(human.out).toContain(
      `Repository: ${workspace.repository.sourceRoot} (git dir ${workspace.repository.gitCommonDir})`,
    );
    expect(human.out).toContain(`Base commit: ${workspace.baseCommit}`);

    const json = await cli(ctx.home, ["session", "--json"]);
    expect(JSON.parse(json.out)).toMatchObject({
      workspace: {
        isolated: true,
        path: workspace.path,
        branch: workspace.branch,
        baseCommit: workspace.baseCommit,
        repository: workspace.repository,
      },
    });
    const listed = await cli(ctx.home, ["session", "--list", "--json"]);
    expect(JSON.parse(listed.out)[0].workspace.path).toBe(workspace.path);
  });

  it("prints sessions without workspace metadata as before", async () => {
    const ctx = setup();
    await executeRun("Implement the approved plan.", { dryRun: false }, ctx.deps);
    ctx.db.close();
    const human = await cli(ctx.home, ["session"]);
    expect(human.out).not.toMatch(/Workspace|Worktree:|Branch:|Base commit:/);
    const json = await cli(ctx.home, ["session", "--json"]);
    expect(JSON.parse(json.out)).not.toHaveProperty("workspace");
  });
});

describe("quota and reservations with --worktree", () => {
  it("reserves against the same account pool as a normal run", async () => {
    const ctx = setup();
    ctx.deps.accounts = [shared];
    ctx.deps.models = [claudeModel];
    ctx.deps.usage = { [shared.id]: usageFor(shared.id, 0.95) };
    const plain = await executeRun("Implement A.", { dryRun: false }, ctx.deps);
    const isolated = await run(ctx.deps, "Implement B.");
    const plainSession = ctx.sessions.get((plain.json as RunJson).sessionId!)!;
    const isolatedSession = ctx.sessions.get(isolated.json.sessionId!)!;
    expect(isolatedSession.reservations).toHaveLength(1);
    expect(isolatedSession.reservations[0]!.accountId).toBe(
      plainSession.reservations[0]!.accountId,
    );
    expect(isolatedSession.reservations[0]!.ratio).toBe(plainSession.reservations[0]!.ratio);
    expect(ctx.reservations.activeRatio(shared.id)).toBeCloseTo(
      plainSession.reservations[0]!.ratio * 2,
    );
    ctx.db.close();
  });

  it("does not bypass an exhausted reservation budget or leave a worktree behind", async () => {
    const ctx = setup();
    ctx.deps.accounts = [shared];
    ctx.deps.models = [claudeModel];
    ctx.deps.usage = { [shared.id]: usageFor(shared.id, 0.95) };
    // 95% left - 40% reserve floor = 55% routable; leave less than one task's estimate.
    ctx.reservations.create({ accountId: shared.id, ratio: 0.54, ttlMs: 60_000 });
    const plain = await executeRun("Implement A.", { dryRun: false }, ctx.deps);
    const isolated = await run(ctx.deps, "Implement B.");
    const preview = await run(ctx.deps, "Implement C.", { dryRun: true });
    expect(plain.code).toBe(2);
    expect(plain.output).toMatch(/below-reserve/);
    expect(isolated.code).toBe(plain.code);
    expect(isolated.output).toBe(plain.output);
    expect(preview.output).toBe(plain.output);
    expect(worktreePaths(ctx.repo)).toHaveLength(1);
    expect(branches(ctx.repo)).toEqual(["main"]);
    expect(ctx.herdr.calls).toEqual([]);
    ctx.db.close();
  });

  it("stops on a reservation conflict at launch revalidation before creating a worktree", async () => {
    const ctx = setup();
    // Another process took the capacity between eligibility and the reservation.
    const racing = new ReservationService(() => now.getTime());
    racing.activeRatio = () => 0;
    racing.tryCreate = () => undefined;
    racing.wouldFit = () => false;
    const deps = { ...ctx.deps, reservations: racing };
    const plain = await executeRun("Implement A.", { dryRun: false }, deps);
    const isolated = await run(deps, "Implement B.");
    const preview = await run(deps, "Implement C.", { dryRun: true });
    for (const result of [plain, isolated, preview]) {
      expect(result.code).toBe(2);
      expect(result.output).toBe("Launch revalidation failed: reservation-conflict");
    }
    expect(worktreePaths(ctx.repo)).toHaveLength(1);
    expect(branches(ctx.repo)).toEqual(["main"]);
    expect(ctx.herdr.calls).toEqual([]);
    ctx.db.close();
  });
});

describe("router run --worktree from the CLI", () => {
  it("passes the flag through only when it is set", async () => {
    const runSpy = vi.fn(async () => ({ output: "ok", json: {}, code: 0 }));
    const silent = { write: () => true };
    const runDeps = { accounts: [], models: [], usage: {}, client: fakeTypeSafe({}), env: {} };
    const home = tempDir();
    await runCli(["node", "router", "run", "Do it", "--worktree", "--dry-run"], {
      stdout: silent,
      stderr: silent,
      env: { MODEL_ROUTER_HOME: home },
      run: runSpy,
      runDeps,
    });
    await runCli(["node", "router", "run", "Next", "--session", "sess_x", "--worktree"], {
      stdout: silent,
      stderr: silent,
      env: { MODEL_ROUTER_HOME: home },
      run: runSpy,
      runDeps,
    });
    await runCli(["node", "router", "run", "Plain"], {
      stdout: silent,
      stderr: silent,
      env: { MODEL_ROUTER_HOME: home },
      run: runSpy,
      runDeps,
    });
    expect(runSpy.mock.calls[0]![1]).toEqual({ dryRun: true, noEnrich: false, worktree: true });
    expect(runSpy.mock.calls[1]![1]).toEqual({
      dryRun: false,
      previousSessionId: "sess_x",
      noEnrich: false,
      worktree: true,
    });
    expect(runSpy.mock.calls[2]![1]).toEqual({ dryRun: false, noEnrich: false });
  });

  it("creates the worktree end to end through runCli", async () => {
    const ctx = setup();
    let out = "";
    const code = await runCli(["node", "router", "run", "Implement it", "--worktree", "--json"], {
      stdout: {
        write(chunk: string) {
          out += chunk;
          return true;
        },
      },
      stderr: { write: () => true },
      env: { MODEL_ROUTER_HOME: ctx.home },
      runDeps: ctx.deps,
    });
    expect(code).toBe(0);
    const json = JSON.parse(out) as RunJson;
    expect(json.workspace?.created).toBe(true);
    expect(worktreePaths(ctx.repo)).toContain(json.workspace!.path);
    ctx.db.close();
  });
});
