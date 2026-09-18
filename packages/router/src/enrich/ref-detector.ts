/** Largest PR number accepted; keeps prompt-derived values well inside safe integers. */
const MAX_PR_NUMBER = 9_999_999;

/**
 * Detects explicit pull request references in a task string.
 *
 * Only the explicit forms are accepted (`PR 9`, `pr #9`, `PR#9`, `PRs 9, 10`). A bare `#9` is the
 * canonical issue reference, and matching it would fire an authenticated network
 * request on a prompt pasted from a chat message or an issue body.
 */
export function detectPrRefs(task: string): number[] {
  const pattern = /(?<![A-Za-z0-9])(?:PR|pr|Pr|pR)s?(?:\s+#?\s*|#\s*)(\d{1,8})(?![0-9])/g;
  const found: number[] = [];
  for (const match of task.matchAll(pattern)) {
    const parsed = Number.parseInt(match[1]!, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PR_NUMBER) {
      continue;
    }
    if (!found.includes(parsed)) {
      found.push(parsed);
    }
  }
  return found;
}
