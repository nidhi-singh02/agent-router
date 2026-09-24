import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeRun, type RunDeps } from "../../src/commands/run.js";
import { formatSession } from "../../src/commands/session.js";
import {
  RouterSessionSchema,
  type RouterSession,
  type Workspace,
} from "../../src/domain/session.js";
import { createHerdrClient } from "../../src/launch/herdr-client.js";
import { ReservationService } from "../../src/reservations/reservation-service.js";
import {
  createWorkspace,
  planWorkspace,
  validateWorkspace,
} from "../../src/workspaces/git-workspace.js";
import {
  claudeModel,
  cursorModel,
  fakeTypeSafe,
  now,
  personal,
  shared,
  usageFor,
} from "../cli/fixtures.js";
import { openDatabase } from "../../src/store/database.js";
import { SessionRepository } from "../../src/store/session-repository.js";
import { runCli } from "../../src/cli.js";

const areas: string[] = [];
function area() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "router-isolation-")));
  areas.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of areas.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}
function repo(parent = area(), name = "source repo with spaces") {
  const cwd = path.join(parent, name);
  mkdirSync(cwd);
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.email", "fixture@example.invalid");
  git(cwd, "config", "user.name", "Fixture");
  writeFileSync(path.join(cwd, "tracked.txt"), "original\n");
  writeFileSync(path.join(cwd, ".gitignore"), "ignored\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  return cwd;
}
function fixture(cwd = repo()) {
  const saved = new Map<string, RouterSession>();
  const calls: string[][] = [];
  const herdr = createHerdrClient(async (argv) => {
    calls.push([...argv]);
    return { ok: true, code: 0, stdout: "pane_test\n", stderr: "" };
  });
  const reservations = new ReservationService(() => now.getTime());
  const deps: RunDeps = {
    cwd,
    accounts: [personal],
    models: [cursorModel],
    usage: { [personal.id]: usageFor(personal.id, 0.8) },
    client: fakeTypeSafe({}),
    env: { HERDR_ENV: "1" },
    now,
    herdr,
    reservations,
    sessions: {
      save: (session) => {
        saved.set(session.id, session);
      },
      get: (id) => saved.get(id),
    },
  };
  return { cwd, deps, saved, calls, reservations };
}
async function launch(f: ReturnType<typeof fixture>) {
  const result = await executeRun("Implement the plan", { dryRun: false, worktree: true }, f.deps);
  expect(result.code, result.output).toBe(0);
  return [...f.saved.values()].at(-1)!;
}

describe("Git workspace isolation", () => {
  it("creates unique isolated branches at HEAD, leaves source branch, index and files unchanged, handles spaces", async () => {
    const f = fixture();
    const head = git(f.cwd, "rev-parse", "HEAD");
    const index = readFileSync(path.join(f.cwd, ".git/index"));
    const first = await launch(f);
    const second = await launch(f);
    const a = first.workspace!;
    const b = second.workspace!;
    expect(a.path).not.toBe(b.path);
    expect(a.branch).not.toBe(b.branch);
    for (const ws of [a, b]) {
      expect(ws.startingCommit).toBe(head);
      expect(git(ws.path, "rev-parse", "HEAD")).toBe(head);
      expect(git(ws.path, "branch", "--show-current")).toBe(ws.branch);
      expect(path.relative(f.cwd, ws.path).startsWith("..")).toBe(true);
      validateWorkspace(ws);
    }
    writeFileSync(path.join(a.path, "only-a"), "a");
    writeFileSync(path.join(b.path, "only-b"), "b");
    writeFileSync(path.join(a.path, "tracked.txt"), "changed a");
    expect(existsSync(path.join(b.path, "only-a"))).toBe(false);
    expect(existsSync(path.join(a.path, "only-b"))).toBe(false);
    expect(existsSync(path.join(f.cwd, "only-a"))).toBe(false);
    expect(readFileSync(path.join(b.path, "tracked.txt"), "utf8")).toBe("original\n");
    expect(readFileSync(path.join(f.cwd, "tracked.txt"), "utf8")).toBe("original\n");
    expect(readFileSync(path.join(f.cwd, ".git/index"))).toEqual(index);
    expect(git(f.cwd, "branch", "--show-current")).toBe("main");
    expect(git(f.cwd, "status", "--porcelain")).toBe("");
    const splits = f.calls.filter((a) => a[1] === "pane" && a[2] === "split");
    expect(splits.map((a) => a[a.indexOf("--cwd") + 1])).toEqual([a.path, b.path]);
    expect(f.calls.filter((a) => a[2] === "start").flat()).not.toContain("--worktree");
    expect(f.reservations.activeRatio(personal.id)).toBeCloseTo(0.04);
  });

  it.each(["staged", "unstaged", "untracked"])(
    "rejects %s changes without touching them or launching",
    async (kind) => {
      const f = fixture();
      const file = path.join(f.cwd, kind === "untracked" ? "new.txt" : "tracked.txt");
      writeFileSync(file, "user work");
      if (kind === "staged") git(f.cwd, "add", ".");
      const index = readFileSync(path.join(f.cwd, ".git/index"));
      const status = git(f.cwd, "status", "--porcelain");
      const result = await executeRun("task", { dryRun: false, worktree: true }, f.deps);
      expect(result.output).toContain("dirty");
      expect(result.code).toBe(2);
      expect(readFileSync(file, "utf8")).toBe("user work");
      expect(readFileSync(path.join(f.cwd, ".git/index"))).toEqual(index);
      expect(git(f.cwd, "status", "--porcelain")).toBe(status);
      expect(f.calls).toEqual([]);
      expect(f.deps.client.calls).toEqual([]);
    },
  );
  it("allows ignored files and a source subdirectory", async () => {
    const f = fixture();
    writeFileSync(path.join(f.cwd, "ignored"), "local");
    mkdirSync(path.join(f.cwd, "sub"));
    f.deps.cwd = path.join(f.cwd, "sub");
    const session = await launch(f);
    expect(existsSync(path.join(session.workspace!.path, "ignored"))).toBe(false);
  });
  it("rejects non-Git directories before routing or launch", async () => {
    const f = fixture(area());
    const result = await executeRun("task", { dryRun: false, worktree: true }, f.deps);
    expect(result.output).toContain("requires a Git checkout");
    expect(f.calls).toEqual([]);
    expect(f.saved.size).toBe(0);
    expect(f.deps.client.calls).toEqual([]);
  });
  it("creation failure never launches and releases the account reservation", async () => {
    const f = fixture();
    const original = f.reservations.tryCreate.bind(f.reservations);
    vi.spyOn(f.reservations, "tryCreate").mockImplementation((input) => {
      // Make Git refuse worktree registration without changing the source checkout.
      writeFileSync(path.join(f.cwd, ".git/worktrees"), "blocked");
      return original(input);
    });
    const result = await executeRun("task", { dryRun: false, worktree: true }, f.deps);
    expect(result.code).toBe(2);
    expect(result.output).toContain("Workspace setup failed");
    expect(f.calls).toEqual([]);
    expect(f.reservations.activeRatio(personal.id)).toBe(0);
  });
  it.each([false, true])(
    "startup failure (throw=%s) preserves and reports workspace",
    async (throws) => {
      const f = fixture();
      f.deps.herdr = createHerdrClient(async (argv) => {
        if (argv[2] === "start") {
          if (throws) throw new Error("synthetic startup failure");
          return { ok: false, code: 1, stdout: "", stderr: "synthetic startup failure" };
        }
        return { ok: true, code: 0, stdout: "pane_test", stderr: "" };
      });
      const result = await executeRun("task", { dryRun: false, worktree: true }, f.deps);
      const session = [...f.saved.values()][0]!;
      expect(result.code).toBe(1);
      expect(result.output).toContain("synthetic startup failure");
      expect(result.output).toContain(`Worktree preserved: ${session.workspace!.path}`);
      validateWorkspace(session.workspace!);
      expect(session.route!.status).toBe("launch-failed");
      expect(f.reservations.activeRatio(personal.id)).toBe(0);
    },
  );
  it("dry-run previews but creates no branches, worktrees, panes, sessions or reservations", async () => {
    const f = fixture();
    const before = git(f.cwd, "worktree", "list", "--porcelain");
    const refs = git(f.cwd, "show-ref");
    const reserve = vi.spyOn(f.reservations, "tryCreate");
    const result = await executeRun("task", { dryRun: true, worktree: true }, f.deps);
    expect(result.code).toBe(0);
    expect(result.output).toContain("Would create branch and worktree");
    const ws = (result.json as { workspace: Workspace }).workspace;
    expect(existsSync(ws.path)).toBe(false);
    expect(git(f.cwd, "show-ref")).toBe(refs);
    expect(git(f.cwd, "worktree", "list", "--porcelain")).toBe(before);
    expect(f.calls).toEqual([]);
    expect(f.saved.size).toBe(0);
    expect(reserve).not.toHaveBeenCalled();
    expect(f.deps.client.calls.length).toBeGreaterThan(0);
  });
  it("reuses dirty workspace from another directory with a different agent and no second worktree", async () => {
    const f = fixture();
    const first = await launch(f);
    const ws = first.workspace!;
    writeFileSync(path.join(ws.path, "phase-one"), "unfinished");
    const before = git(f.cwd, "worktree", "list", "--porcelain");
    f.deps.cwd = area();
    f.deps.accounts = [shared];
    f.deps.models = [claudeModel];
    f.deps.usage = { [shared.id]: usageFor(shared.id, 0.9) };
    f.deps.client = fakeTypeSafe({ phase: "review" });
    const result = await executeRun(
      "Review implementation",
      { dryRun: false, previousSessionId: first.id },
      f.deps,
    );
    expect(result.code, result.output).toBe(0);
    const next = [...f.saved.values()].at(-1)!;
    expect(next.workspace).toEqual(ws);
    expect(next.route!.agent).toBe("claude-code");
    expect(next.previousSessionId).toBe(first.id);
    const split = f.calls.filter((a) => a[2] === "split").at(-1)!;
    expect(split[split.indexOf("--cwd") + 1]).toBe(ws.path);
    expect(readFileSync(path.join(split[split.indexOf("--cwd") + 1]!, "phase-one"), "utf8")).toBe(
      "unfinished",
    );
    expect(git(ws.path, "worktree", "list", "--porcelain")).toBe(before);
  });
  it.each(["missing", "repository", "branch", "replacement"])(
    "rejects invalid continuation: %s",
    async (kind) => {
      const f = fixture();
      const first = await launch(f);
      const ws = first.workspace!;
      f.calls.length = 0;
      if (kind === "missing") rmSync(ws.path, { recursive: true });
      if (kind === "repository") ws.repositoryIdentity = path.join(area(), ".git");
      if (kind === "branch") ws.branch = "wrong";
      if (kind === "replacement") {
        rmSync(ws.path, { recursive: true });
        repo(path.dirname(ws.path), path.basename(ws.path));
      }
      const result = await executeRun(
        "next phase",
        { dryRun: false, previousSessionId: first.id },
        f.deps,
      );
      expect(result.code).toBe(2);
      expect(result.output).toContain("Cannot reuse isolated workspace");
      expect(f.calls).toEqual([]);
    },
  );
  it("older sessions preserve launch behavior without cwd", async () => {
    const f = fixture(area());
    const initial = await executeRun("task", { dryRun: false }, f.deps);
    expect(initial.code).toBe(0);
    const first = [...f.saved.values()][0]!;
    expect(first.workspace).toBeUndefined();
    expect(RouterSessionSchema.parse(first).workspace).toBeUndefined();
    expect(
      (await executeRun("next", { dryRun: false, previousSessionId: first.id }, f.deps)).code,
    ).toBe(0);
    expect(f.calls.flat()).not.toContain("--cwd");
  });
  it("persists metadata and includes it in human and JSON session output and CLI preview", async () => {
    const f = fixture();
    const session = await launch(f);
    const home = area();
    const db = openDatabase({ home });
    const sessions = new SessionRepository(db);
    sessions.save(session);
    expect(sessions.get(session.id)!.workspace).toEqual(session.workspace);
    db.close();
    const human = formatSession(session);
    for (const value of Object.values(session.workspace!))
      if (typeof value === "string") expect(human).toContain(value);
    let out = "";
    const io = {
      write: (text: string) => {
        out += text;
        return true;
      },
    };
    expect(
      await runCli(["node", "router", "session", session.id, "--json"], {
        env: { MODEL_ROUTER_HOME: home },
        stdout: io,
      }),
    ).toBe(0);
    expect(JSON.parse(out).workspace).toEqual(session.workspace);
    out = "";
    expect(
      await runCli(["node", "router", "run", "task", "--worktree", "--dry-run", "--json"], {
        runDeps: f.deps,
        stdout: io,
      }),
    ).toBe(0);
    expect(JSON.parse(out).workspace.isolationEnabled).toBe(true);
  });
  it("shares reservation limits across worktrees and prevents overbooking", async () => {
    const f = fixture();
    f.deps.accounts = [shared];
    f.deps.models = [claudeModel];
    f.deps.usage = { [shared.id]: usageFor(shared.id, 0.9) };
    await launch(f);
    const reserve = f.reservations.activeRatio(shared.id);
    expect(reserve).toBeGreaterThan(0);
    f.reservations.create({ accountId: shared.id, ratio: 0.9, ttlMs: 60000 });
    const count = f.calls.length;
    const result = await executeRun("task two", { dryRun: false, worktree: true }, f.deps);
    expect(result.code).toBe(2);
    expect(f.calls.length).toBe(count);
    expect(f.saved.size).toBe(1);
  });
  it("supports starting from an existing linked checkout and detects HEAD changes before creation", () => {
    const source = repo();
    const first = planWorkspace(source);
    createWorkspace(source, first);
    const next = planWorkspace(first.path);
    createWorkspace(first.path, next);
    validateWorkspace(next);
    expect(next.repositoryIdentity).toBe(first.repositoryIdentity);
    const stale = planWorkspace(source);
    git(source, "commit", "--allow-empty", "-m", "new head");
    expect(() => createWorkspace(source, stale)).toThrow("HEAD changed");
    expect(existsSync(stale.path)).toBe(false);
  });
  it("keeps task shell syntax out of Git operations", async () => {
    const f = fixture();
    const marker = path.join(path.dirname(f.cwd), "should-not-exist");
    const result = await executeRun(
      `Implement $(touch '${marker}'); echo task`,
      { dryRun: false, worktree: true },
      f.deps,
    );
    expect(result.code, result.output).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect([...f.saved.values()][0]!.workspace!.branch).toMatch(/^router\/[a-f0-9-]+$/);
  });
  it("allows committed progress and previews continuation without creating a reservation", async () => {
    const f = fixture();
    const session = await launch(f);
    const ws = session.workspace!;
    git(ws.path, "commit", "--allow-empty", "-m", "phase progress");
    writeFileSync(path.join(ws.path, "in-progress"), "keep");
    const reserve = vi.spyOn(f.reservations, "tryCreate");
    f.calls.length = 0;
    const result = await executeRun(
      "next",
      { dryRun: true, previousSessionId: session.id },
      f.deps,
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain("Would reuse workspace");
    expect((result.json as { workspace: Workspace }).workspace).toEqual(ws);
    expect(f.calls).toEqual([]);
    expect(reserve).not.toHaveBeenCalled();
    expect(f.saved.size).toBe(1);
  });
  it("resolves continuation enrichment in the workspace, not the caller directory", async () => {
    const f = fixture();
    const session = await launch(f);
    f.deps.cwd = area();
    const run = vi.fn(async () => ({
      ok: false,
      stdout: "",
      stderr: "",
      code: 1,
      timedOut: false,
      executedReturnedOutput: false as const,
    }));
    f.deps.runCommand = run;
    const result = await executeRun(
      "Review PR 12",
      { dryRun: true, previousSessionId: session.id },
      f.deps,
    );
    expect(result.code).toBe(0);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ command: "git", cwd: session.workspace!.path }),
    );
  });
  it("rechecks cleanliness after routing and releases the reservation on changed source", async () => {
    const f = fixture();
    const original = f.reservations.tryCreate.bind(f.reservations);
    vi.spyOn(f.reservations, "tryCreate").mockImplementation((input) => {
      writeFileSync(path.join(f.cwd, "late-change"), "keep");
      return original(input);
    });
    const result = await executeRun("task", { dryRun: false, worktree: true }, f.deps);
    expect(result.code).toBe(2);
    expect(result.output).toContain("dirty");
    expect(f.calls).toEqual([]);
    expect(f.reservations.activeRatio(personal.id)).toBe(0);
    expect(readFileSync(path.join(f.cwd, "late-change"), "utf8")).toBe("keep");
  });
  it("rejects a tampered worktree backlink", async () => {
    const f = fixture();
    const session = await launch(f);
    const ws = session.workspace!;
    const gitDir = git(ws.path, "rev-parse", "--absolute-git-dir");
    writeFileSync(path.join(gitDir, "gitdir"), path.join(f.cwd, ".git"));
    f.calls.length = 0;
    const result = await executeRun(
      "next",
      { dryRun: false, previousSessionId: session.id },
      f.deps,
    );
    expect(result.code).toBe(2);
    expect(result.output).toContain("metadata mismatch");
    expect(f.calls).toEqual([]);
  });
});
