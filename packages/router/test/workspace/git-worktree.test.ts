import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createGitRunner,
  createWorktree,
  gitEnv,
  inspectSourceCheckout,
  planWorktree,
  validateWorkspace,
  type SourceCheckout,
} from "../../src/workspace/git-worktree.js";
import {
  branches,
  checkoutState,
  cleanupTempDirs,
  git,
  head,
  initRepo,
  tempDir,
  worktreePaths,
} from "./git-fixtures.js";

const runner = createGitRunner();
const now = new Date("2026-09-24T10:00:00.000Z");

afterAll(cleanupTempDirs);

async function cleanSource(repo: string): Promise<SourceCheckout> {
  const source = await inspectSourceCheckout(runner, repo);
  if (!source.ok) throw new Error(source.error);
  return source;
}

async function makeWorktree(repo: string, root: string) {
  const source = await cleanSource(repo);
  const plan = await planWorktree({ git: runner, source, root, now });
  if (!plan.ok) throw new Error(plan.error);
  const created = await createWorktree({ git: runner, source, plan, now });
  if (!created.ok) throw new Error(created.error);
  return created.workspace;
}

describe("gitEnv", () => {
  it("drops GIT_* redirects and disables prompts", () => {
    const env = gitEnv({ PATH: "/bin", GIT_DIR: "/elsewhere", GIT_WORK_TREE: "/x", HOME: "/h" });
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/h", GIT_TERMINAL_PROMPT: "0" });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
  });
});

describe("inspectSourceCheckout", () => {
  it("accepts a clean checkout and reports its identity and HEAD", async () => {
    const repo = initRepo(path.join(tempDir(), "repo"));
    mkdirSync(path.join(repo, "build"));
    writeFileSync(path.join(repo, "build", "out.js"), "ignored\n");
    const source = await cleanSource(path.join(repo));
    expect(source).toMatchObject({
      sourceRoot: realpathSync(repo),
      gitCommonDir: realpathSync(path.join(repo, ".git")),
      baseCommit: head(repo),
      sourceBranch: "main",
    });
  });

  it("resolves the repository from a subdirectory", async () => {
    const repo = initRepo(path.join(tempDir(), "repo"));
    mkdirSync(path.join(repo, "src"));
    const source = await cleanSource(path.join(repo, "src"));
    expect(source.sourceRoot).toBe(realpathSync(repo));
  });

  it("rejects a directory that is not in a Git repository", async () => {
    const dir = tempDir();
    const result = await inspectSourceCheckout(runner, dir);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toMatch(/not inside a Git work tree/);
  });

  it("rejects a repository without commits", async () => {
    const dir = tempDir();
    git(dir, "init", "--quiet");
    const result = await inspectSourceCheckout(runner, dir);
    expect(!result.ok && result.error).toMatch(/no commits yet/);
  });

  it.each([
    [
      "staged",
      (repo: string) => {
        writeFileSync(path.join(repo, "staged.txt"), "s\n");
        git(repo, "add", "staged.txt");
      },
    ],
    ["unstaged", (repo: string) => writeFileSync(path.join(repo, "README.md"), "changed\n")],
    ["untracked", (repo: string) => writeFileSync(path.join(repo, "new.txt"), "n\n")],
  ])("rejects %s changes and leaves them in place", async (_kind, dirty) => {
    const repo = initRepo(path.join(tempDir(), "repo"));
    dirty(repo);
    const before = checkoutState(repo);
    const result = await inspectSourceCheckout(runner, repo);
    expect(!result.ok && result.error).toMatch(/needs a clean checkout/);
    expect(checkoutState(repo)).toEqual(before);
  });
});

describe("planWorktree and createWorktree", () => {
  it("creates a branch and worktree at the source HEAD outside the checkout", async () => {
    const base = tempDir();
    const repo = initRepo(path.join(base, "repo"));
    git(repo, "checkout", "--quiet", "-b", "feature");
    writeFileSync(path.join(repo, "feature.txt"), "f\n");
    git(repo, "add", "feature.txt");
    git(repo, "commit", "--quiet", "-m", "feature");
    const before = checkoutState(repo);

    const workspace = await makeWorktree(repo, path.join(base, "worktrees"));

    expect(workspace.branch).toMatch(/^router\/wt-\d{8}-\d{6}-[0-9a-f]{8}$/);
    expect(workspace.baseCommit).toBe(before.head);
    expect(head(repo, workspace.branch)).toBe(before.head);
    expect(head(workspace.path)).toBe(before.head);
    expect(path.relative(realpathSync(repo), workspace.path)).toMatch(/^\.\./);
    expect(readFileSync(path.join(workspace.path, "feature.txt"), "utf8")).toBe("f\n");
    expect(worktreePaths(repo)).toContain(workspace.path);
    expect(checkoutState(repo)).toEqual(before);
    expect(await validateWorkspace(runner, workspace)).toEqual({ ok: true });
  });

  it("handles repository and worktree paths containing spaces", async () => {
    const base = tempDir("router wt spaces ");
    const repo = initRepo(path.join(base, "my repo"));
    const workspace = await makeWorktree(repo, path.join(base, "router home", "worktrees"));
    expect(workspace.path).toContain("router home");
    expect(existsSync(path.join(workspace.path, "README.md"))).toBe(true);
    expect(workspace.repository.sourceRoot).toBe(realpathSync(repo));
  });

  it("gives two worktrees different branches and directories", async () => {
    const base = tempDir();
    const repo = initRepo(path.join(base, "repo"));
    const first = await makeWorktree(repo, path.join(base, "wt"));
    const second = await makeWorktree(repo, path.join(base, "wt"));
    expect(first.path).not.toBe(second.path);
    expect(first.branch).not.toBe(second.branch);
    expect(branches(repo)).toEqual(expect.arrayContaining([first.branch, second.branch]));
  });

  it("skips a name whose branch already exists", async () => {
    const base = tempDir();
    const repo = initRepo(path.join(base, "repo"));
    const source = await cleanSource(repo);
    git(repo, "branch", "router/wt-20260924-100000-taken000");
    const names = ["taken000", "free0000"];
    const plan = await planWorktree({
      git: runner,
      source,
      root: path.join(base, "wt"),
      now,
      random: () => names.shift()!,
    });
    expect(plan).toMatchObject({ ok: true, branch: "router/wt-20260924-100000-free0000" });
  });

  it("refuses a worktree root inside the source checkout", async () => {
    const repo = initRepo(path.join(tempDir(), "repo"));
    const source = await cleanSource(repo);
    const plan = await planWorktree({
      git: runner,
      source,
      root: path.join(repo, ".worktrees"),
      now,
    });
    expect(!plan.ok && plan.error).toMatch(/inside the source checkout/);
  });
});

describe("validateWorkspace", () => {
  it("reports a workspace that no longer exists", async () => {
    const base = tempDir();
    const repo = initRepo(path.join(base, "repo"));
    const workspace = await makeWorktree(repo, path.join(base, "wt"));
    git(repo, "worktree", "remove", workspace.path);
    const result = await validateWorkspace(runner, workspace);
    expect(!result.ok && result.error).toMatch(/no longer exists/);
  });

  it("reports a workspace that belongs to another repository", async () => {
    const base = tempDir();
    const repo = initRepo(path.join(base, "repo"));
    const other = initRepo(path.join(base, "other"));
    const workspace = await makeWorktree(repo, path.join(base, "wt"));
    const result = await validateWorkspace(runner, {
      ...workspace,
      repository: {
        gitCommonDir: realpathSync(path.join(other, ".git")),
        sourceRoot: realpathSync(other),
      },
    });
    expect(!result.ok && result.error).toMatch(/belongs to a different repository/);
  });

  it("reports a worktree that is on a different branch", async () => {
    const base = tempDir();
    const repo = initRepo(path.join(base, "repo"));
    const workspace = await makeWorktree(repo, path.join(base, "wt"));
    git(workspace.path, "checkout", "--quiet", "-b", "someone-else");
    const result = await validateWorkspace(runner, workspace);
    expect(!result.ok && result.error).toMatch(/on someone-else, expected branch router\/wt-/);
  });

  it("refuses the main checkout as a recorded workspace", async () => {
    const base = tempDir();
    const repo = initRepo(path.join(base, "repo"));
    const workspace = await makeWorktree(repo, path.join(base, "wt"));
    const result = await validateWorkspace(runner, {
      ...workspace,
      path: realpathSync(repo),
      branch: "main",
    });
    expect(!result.ok && result.error).toMatch(/main checkout/);
  });

  it("reports a directory that is not a Git worktree", async () => {
    const base = tempDir();
    const repo = initRepo(path.join(base, "repo"));
    const workspace = await makeWorktree(repo, path.join(base, "wt"));
    const plain = tempDir();
    const result = await validateWorkspace(runner, { ...workspace, path: realpathSync(plain) });
    expect(result.ok).toBe(false);
  });
});
