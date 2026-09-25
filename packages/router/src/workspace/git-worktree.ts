import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { runCommand } from "../collectors/command-runner.js";
import type { SessionWorkspace } from "../domain/session.js";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Runs `git <args>` in `cwd` as an argv array, never through a shell, so paths with spaces
 * and task-derived values cannot be reinterpreted.
 */
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BYTES = 1_048_576;

/**
 * `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and friends would point every call at
 * another repository, so none of the parent's `GIT_*` variables are forwarded.
 */
export function gitEnv(env: NodeJS.Dict<string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !key.startsWith("GIT_")) {
      out[key] = value;
    }
  }
  out.GIT_TERMINAL_PROMPT = "0";
  out.LC_ALL = "C";
  return out;
}

export function createGitRunner(env: NodeJS.Dict<string> = process.env): GitRunner {
  const childEnv = gitEnv(env);
  return async (args, cwd) => {
    const result = await runCommand({
      command: "git",
      args,
      cwd,
      env: childEnv,
      timeoutMs: GIT_TIMEOUT_MS,
      maxBytes: GIT_MAX_BYTES,
    });
    const stderr =
      result.spawnErrorCode !== undefined
        ? `git could not start (${result.spawnErrorCode})`
        : result.timedOut
          ? "git timed out"
          : result.stderr;
    return { ok: result.ok, stdout: result.stdout, stderr };
  };
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function canonical(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/** `canonical` for a path that may not exist yet: resolves its nearest existing ancestor. */
function canonicalFuture(target: string): string {
  const resolved = path.resolve(target);
  let existing = resolved;
  while (!existsSync(existing) && path.dirname(existing) !== existing) {
    existing = path.dirname(existing);
  }
  return path.join(canonical(existing), path.relative(existing, resolved));
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export interface SourceCheckout {
  /** Top level of the checkout `router run` was started from. */
  sourceRoot: string;
  /** The repository's shared `.git` directory; every worktree of it resolves here. */
  gitCommonDir: string;
  /** Committed HEAD the new worktree starts from. */
  baseCommit: string;
  /** Branch checked out in the source, or undefined when HEAD is detached. */
  sourceBranch?: string;
}

export type Checked<T> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Confirms `cwd` is inside a Git work tree with at least one commit and no staged,
 * unstaged, or untracked (non-ignored) changes. Read-only: nothing is stashed or reset.
 */
export async function inspectSourceCheckout(
  git: GitRunner,
  cwd: string,
): Promise<Checked<SourceCheckout>> {
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return { ok: false, error: `--worktree needs a Git repository; ${cwd} is not a directory.` };
  }
  const inside = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return {
      ok: false,
      error: `--worktree needs a Git repository; ${cwd} is not inside a Git work tree.`,
    };
  }
  const dirs = await git(
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
    cwd,
  );
  const [toplevel, commonDir] = dirs.stdout.trim().split("\n");
  if (!dirs.ok || !toplevel || !commonDir) {
    return {
      ok: false,
      error: `Could not read the Git repository at ${cwd}: ${firstLine(dirs.stderr)}`,
    };
  }
  const sourceRoot = canonical(toplevel);
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], sourceRoot);
  const baseCommit = head.stdout.trim();
  if (!head.ok || !/^[0-9a-f]{40,64}$/.test(baseCommit)) {
    return {
      ok: false,
      error: `--worktree needs a committed HEAD; ${sourceRoot} has no commits yet.`,
    };
  }
  const status = await git(
    ["status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=none"],
    sourceRoot,
  );
  if (!status.ok) {
    return {
      ok: false,
      error: `Could not read the status of ${sourceRoot}: ${firstLine(status.stderr)}`,
    };
  }
  const changes = status.stdout.split("\n").filter((line) => line.length > 0);
  if (changes.length > 0) {
    const shown = changes.slice(0, 5).map((line) => `  ${line}`);
    if (changes.length > shown.length) {
      shown.push(`  ... and ${changes.length - shown.length} more`);
    }
    return {
      ok: false,
      error: [
        `--worktree needs a clean checkout; ${sourceRoot} has ${changes.length} uncommitted ` +
          `change${changes.length === 1 ? "" : "s"} (staged, unstaged, or untracked).`,
        ...shown,
        "Commit, stash, or remove them yourself and retry; the router does not touch them.",
      ].join("\n"),
    };
  }
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], sourceRoot);
  return {
    ok: true,
    sourceRoot,
    gitCommonDir: canonical(commonDir),
    baseCommit,
    sourceBranch: branch.ok && branch.stdout.trim() ? branch.stdout.trim() : undefined,
  };
}

/**
 * Confirms the checkout preflight recorded is still the one creation should use.
 * Routing can take long enough for HEAD to move or for the tree to become dirty.
 */
export async function recheckSourceCheckout(
  git: GitRunner,
  source: SourceCheckout,
): Promise<Checked<SourceCheckout>> {
  const again = await inspectSourceCheckout(git, source.sourceRoot);
  if (!again.ok) {
    return {
      ok: false,
      error: `The source checkout changed while routing; no worktree was created.\n${again.error}`,
    };
  }
  if (again.gitCommonDir !== source.gitCommonDir) {
    return {
      ok: false,
      error:
        `The source repository changed while routing; no worktree was created. ` +
        `Expected ${source.gitCommonDir}, found ${again.gitCommonDir}. Retry.`,
    };
  }
  if (again.baseCommit !== source.baseCommit) {
    return {
      ok: false,
      error:
        `Source HEAD changed while routing (${source.baseCommit.slice(0, 12)} -> ${again.baseCommit.slice(0, 12)}); ` +
        "no worktree was created. Retry.",
    };
  }
  return again;
}

export interface WorktreePlan {
  path: string;
  branch: string;
}

function repoSlug(sourceRoot: string): string {
  const slug = path
    .basename(sourceRoot)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return (slug || "repo").slice(0, 40);
}

/**
 * Picks a branch and directory that do not exist yet. Neither contains task text: the
 * branch is `router/wt-<timestamp>-<random>` and the directory sits under `root`,
 * grouped by repository.
 */
export async function planWorktree(input: {
  git: GitRunner;
  source: SourceCheckout;
  root: string;
  now: Date;
  random?: () => string;
}): Promise<Checked<WorktreePlan>> {
  const root = canonicalFuture(input.root);
  if (isInside(input.source.sourceRoot, root)) {
    return {
      ok: false,
      error: `Worktree root ${root} is inside the source checkout ${input.source.sourceRoot}; choose a directory outside it.`,
    };
  }
  const group = `${repoSlug(input.source.sourceRoot)}-${createHash("sha256")
    .update(input.source.gitCommonDir)
    .digest("hex")
    .slice(0, 8)}`;
  const stamp = input.now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");
  const random = input.random ?? (() => randomBytes(4).toString("hex"));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = `wt-${stamp}-${random()}`;
    const branch = `router/${id}`;
    const target = path.join(root, group, id);
    if (existsSync(target)) {
      continue;
    }
    const exists = await input.git(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      input.source.sourceRoot,
    );
    if (exists.ok) {
      continue;
    }
    return { ok: true, path: target, branch };
  }
  return { ok: false, error: "Could not pick an unused worktree branch and directory." };
}

/**
 * `git worktree add -b <branch> <path> <commit>` from the source checkout. It writes only
 * the new branch ref and the worktree's admin files in the shared `.git`; the source
 * checkout's branch, index, and files are left alone.
 */
export async function createWorktree(input: {
  git: GitRunner;
  source: SourceCheckout;
  plan: WorktreePlan;
  now: Date;
}): Promise<Checked<{ workspace: SessionWorkspace }>> {
  try {
    mkdirSync(path.dirname(input.plan.path), { recursive: true });
  } catch (error) {
    return {
      ok: false,
      error: `Could not create the worktree parent directory ${path.dirname(input.plan.path)}: ${String(error)}`,
    };
  }
  const added = await input.git(
    [
      "worktree",
      "add",
      "--quiet",
      "-b",
      input.plan.branch,
      input.plan.path,
      input.source.baseCommit,
    ],
    input.source.sourceRoot,
  );
  if (!added.ok) {
    return {
      ok: false,
      error: `git worktree add failed for ${input.plan.path}: ${firstLine(added.stderr) || "unknown error"}`,
    };
  }
  const workspace: SessionWorkspace = {
    isolated: true,
    path: canonical(input.plan.path),
    branch: input.plan.branch,
    repository: {
      gitCommonDir: input.source.gitCommonDir,
      sourceRoot: input.source.sourceRoot,
    },
    baseCommit: input.source.baseCommit,
    createdAt: input.now.toISOString(),
  };
  const checked = await validateWorkspace(input.git, workspace);
  if (!checked.ok) {
    return { ok: false, error: `Created worktree failed validation: ${checked.error}` };
  }
  return { ok: true, workspace };
}

interface WorktreeEntry {
  path: string;
  branch?: string;
}

function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const field of stdout.split("\0")) {
    if (field.startsWith("worktree ")) {
      current = { path: field.slice("worktree ".length) };
      entries.push(current);
    } else if (field.startsWith("branch ") && current) {
      current.branch = field.slice("branch ".length);
    }
  }
  return entries;
}

/**
 * Confirms a recorded workspace is still the linked worktree the router created: the
 * directory exists, it is the top level of a work tree, it shares the recorded repository's
 * `.git`, and Git's own worktree list has it on the recorded branch.
 */
export async function validateWorkspace(
  git: GitRunner,
  workspace: SessionWorkspace,
): Promise<Checked<object>> {
  const where = workspace.path;
  if (!existsSync(where) || !statSync(where).isDirectory()) {
    return { ok: false, error: `Recorded workspace no longer exists: ${where}` };
  }
  const dirs = await git(
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
    where,
  );
  const [toplevel, commonDir] = dirs.stdout.trim().split("\n");
  if (!dirs.ok || !toplevel || !commonDir) {
    return { ok: false, error: `Recorded workspace ${where} is no longer a Git worktree.` };
  }
  if (canonical(toplevel) !== canonical(where)) {
    return {
      ok: false,
      error: `Recorded workspace ${where} is no longer the top level of a Git worktree (found ${toplevel}).`,
    };
  }
  if (canonical(commonDir) !== canonical(workspace.repository.gitCommonDir)) {
    return {
      ok: false,
      error: `Recorded workspace ${where} belongs to a different repository (${canonical(commonDir)}, expected ${workspace.repository.gitCommonDir}).`,
    };
  }
  const listed = await git(["worktree", "list", "--porcelain", "-z"], where);
  if (!listed.ok) {
    return {
      ok: false,
      error: `Could not list worktrees for ${where}: ${firstLine(listed.stderr)}`,
    };
  }
  const entries = parseWorktreeList(listed.stdout);
  const index = entries.findIndex((entry) => canonical(entry.path) === canonical(where));
  if (index === -1) {
    return {
      ok: false,
      error: `Recorded workspace ${where} is not registered as a worktree of ${workspace.repository.sourceRoot}.`,
    };
  }
  if (index === 0) {
    return {
      ok: false,
      error: `Recorded workspace ${where} is the repository's main checkout, not an isolated worktree.`,
    };
  }
  const expected = `refs/heads/${workspace.branch}`;
  const actual = entries[index]!.branch;
  if (actual !== expected) {
    return {
      ok: false,
      error: `Recorded workspace ${where} is on ${actual ? actual.replace(/^refs\/heads\//, "") : "a detached HEAD"}, expected branch ${workspace.branch}.`,
    };
  }
  return { ok: true };
}
