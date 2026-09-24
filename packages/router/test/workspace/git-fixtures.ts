import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitEnv } from "../../src/workspace/git-worktree.js";

const env = gitEnv(process.env);
const identity = [
  "-c",
  "user.name=Router Test",
  "-c",
  "user.email=router-test@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "init.defaultBranch=main",
];

/** Runs real Git synchronously for fixtures; argv only, no shell. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...identity, ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const created: string[] = [];

/** A fresh temporary directory, removed by `cleanupTempDirs`. */
export function tempDir(prefix = "router-wt-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A repository with one commit and an ignored `build/` directory. */
export function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet");
  writeFileSync(path.join(dir, "README.md"), "hello\n");
  writeFileSync(path.join(dir, ".gitignore"), "build/\n");
  git(dir, "add", "README.md", ".gitignore");
  git(dir, "commit", "--quiet", "-m", "initial");
  return dir;
}

export function head(dir: string, ref = "HEAD"): string {
  return git(dir, "rev-parse", ref).trim();
}

export function currentBranch(dir: string): string {
  return git(dir, "symbolic-ref", "--short", "HEAD").trim();
}

export function status(dir: string): string {
  return git(dir, "status", "--porcelain=v1", "--untracked-files=all");
}

export function branches(dir: string): string[] {
  return git(dir, "branch", "--list", "--format=%(refname:short)").split("\n").filter(Boolean);
}

export function worktreePaths(dir: string): string[] {
  return git(dir, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

/** A snapshot of everything `--worktree` must leave untouched in the source checkout. */
export function checkoutState(dir: string) {
  return {
    head: head(dir),
    branch: currentBranch(dir),
    index: git(dir, "ls-files", "--stage"),
    status: status(dir),
    stash: git(dir, "stash", "list"),
  };
}
