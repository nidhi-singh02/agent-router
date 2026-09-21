import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Git worktrees live inside the repo, so their copies of `packages/*` match the
    // default include glob and run as if they were this checkout's tests. They carry
    // their own branch's source and lockfile, so a worktree on an older scope fails on
    // imports that have since been renamed, and a root `npm test` goes red for reasons
    // that have nothing to do with the working branch.
    exclude: [...configDefaults.exclude, "**/.kilo/**", "**/.worktrees/**"],
  },
});
