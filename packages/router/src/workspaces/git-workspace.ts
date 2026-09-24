import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Workspace } from "../domain/session.js";

// Ignore inherited Git overrides: all operations must describe the supplied checkout.
function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  }).trimEnd();
}

function identity(cwd: string): string {
  return realpathSync(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
}

function cleanRoot(cwd: string): string {
  let root: string;
  try {
    root = realpathSync(git(cwd, "rev-parse", "--show-toplevel"));
  } catch {
    throw new Error(`Workspace isolation requires a Git checkout: ${cwd}`);
  }
  if (git(root, "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none")) {
    throw new Error(
      `Source checkout is dirty: ${root}. Commit or move changes yourself before using --worktree.`,
    );
  }
  return root;
}

export function planWorkspace(cwd: string): Workspace {
  const root = cleanRoot(cwd);
  const id = randomUUID();
  return {
    isolationEnabled: true,
    path: path.join(path.dirname(root), `${path.basename(root)}-router-${id}`),
    branch: `router/${id}`,
    repositoryIdentity: identity(root),
    startingCommit: git(root, "rev-parse", "--verify", "HEAD^{commit}"),
  };
}

export function createWorkspace(cwd: string, workspace: Workspace): void {
  const root = cleanRoot(cwd);
  if (
    identity(root) !== workspace.repositoryIdentity ||
    git(root, "rev-parse", "HEAD") !== workspace.startingCommit
  ) {
    throw new Error("Source repository or HEAD changed while routing; retry.");
  }
  git(root, "worktree", "add", "-b", workspace.branch, workspace.path, workspace.startingCommit);
  validateWorkspace(workspace);
}

export function validateWorkspace(workspace: Workspace): void {
  try {
    const root = realpathSync(workspace.path);
    if (
      !path.isAbsolute(workspace.path) ||
      root !== workspace.path ||
      realpathSync(git(root, "rev-parse", "--show-toplevel")) !== root ||
      identity(root) !== workspace.repositoryIdentity ||
      git(root, "symbolic-ref", "HEAD") !== `refs/heads/${workspace.branch}`
    ) {
      throw new Error("repository, path or branch mismatch");
    }
    // Require an actual registered linked worktree, not a replacement checkout.
    const gitDir = realpathSync(git(root, "rev-parse", "--absolute-git-dir"));
    if (
      path.dirname(gitDir) !== path.join(workspace.repositoryIdentity, "worktrees") ||
      realpathSync(readFileSync(path.join(gitDir, "gitdir"), "utf8").trim()) !==
        path.join(root, ".git")
    ) {
      throw new Error("linked worktree metadata mismatch");
    }
    const entries = git(root, "worktree", "list", "--porcelain", "-z").split("\0\0");
    if (
      !entries.some((entry) => {
        const fields = entry.split("\0");
        return (
          fields.includes(`worktree ${root}`) &&
          fields.includes(`branch refs/heads/${workspace.branch}`)
        );
      })
    )
      throw new Error("worktree registration mismatch");
  } catch (error) {
    throw new Error(
      `Cannot reuse isolated workspace ${workspace.path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function formatWorkspace(workspace: Workspace): string {
  return `Workspace isolation: enabled\nWorktree: ${workspace.path}\nBranch: ${workspace.branch}\nRepository identity: ${workspace.repositoryIdentity}\nStarting commit: ${workspace.startingCommit}`;
}
