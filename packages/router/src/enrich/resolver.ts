import type { CommandResult, runCommand } from "../collectors/command-runner.js";
import { detectPrRefs } from "./ref-detector.js";

export type UnresolvedReason =
  | "not-a-repository"
  | "gh-not-installed"
  | "gh-not-authenticated"
  | "github-unavailable"
  | "timed-out"
  | "pr-not-found"
  | "repo-mismatch"
  | "empty-diff"
  | "malformed-response";

export type Resolution =
  | {
      status: "resolved";
      churn: number;
      changedFiles: number;
      prNumber: number;
      repo: { owner: string; name: string };
      isCrossRepository: boolean;
    }
  | { status: "skipped" }
  | { status: "unresolved"; reason: UnresolvedReason };

/** One network hop on an interactive path; the 5s collector timeout is too generous. */
const RESOLVER_TIMEOUT_MS = 2_000;
/** Spent across every subprocess in one run, so three sequential calls cannot stack. */
const RESOLVER_BUDGET_MS = 3_000;
const RESOLVER_MAX_BYTES = 65_536;

/**
 * Variables `gh` reads that redirect the request or the credential are never forwarded.
 * `GH_REPO` accepts `[HOST/]OWNER/REPO`, the same redirect the `-R` flag provides.
 */
const FORWARDED = [
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "LANG",
  "LC_ALL",
  "TMPDIR",
] as const;

export function resolverEnv(env: NodeJS.Dict<string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of FORWARDED) {
    const value = env[key];
    if (value) {
      out[key] = value;
    }
  }
  return out;
}

export async function resolveEnrichment(input: {
  task: string;
  run: typeof runCommand;
  env: NodeJS.Dict<string>;
  now?: () => number;
}): Promise<Resolution> {
  const prNumber = detectPrRefs(input.task)[0];
  if (prNumber === undefined) {
    return { status: "skipped" };
  }

  const now = input.now ?? Date.now;
  const deadline = now() + RESOLVER_BUDGET_MS;

  const run = async (
    command: string,
    args: string[],
    cwd?: string,
  ): Promise<CommandResult | undefined> => {
    const remaining = deadline - now();
    if (remaining <= 0) {
      return undefined;
    }
    return input.run({
      command,
      args,
      timeoutMs: Math.min(RESOLVER_TIMEOUT_MS, remaining),
      maxBytes: RESOLVER_MAX_BYTES,
      env: resolverEnv(input.env),
      cwd,
    });
  };

  const toplevel = await run("git", ["rev-parse", "--show-toplevel"]);
  if (!toplevel || toplevel.timedOut) {
    return { status: "unresolved", reason: "timed-out" };
  }
  const cwd = toplevel.stdout.trim();
  if (!toplevel.ok || cwd.length === 0) {
    return { status: "unresolved", reason: "not-a-repository" };
  }

  const remote = await run("git", ["remote", "get-url", "origin"], cwd);
  if (!remote || remote.timedOut) {
    return { status: "unresolved", reason: "timed-out" };
  }
  // A lookup that ran and failed is the "no origin configured" path, where skipping the
  // comparison is sound. A timeout says nothing about the remote, so it must not.
  const local = remote.ok ? parseRemote(remote.stdout.trim()) : undefined;

  // The PR number is re-emitted from a parsed integer, never the matched substring.
  const view = await run(
    "gh",
    [
      "pr",
      "view",
      String(prNumber),
      "--json",
      "additions,deletions,changedFiles,url,isCrossRepository",
    ],
    cwd,
  );
  if (!view) {
    return { status: "unresolved", reason: "timed-out" };
  }
  if (!view.ok) {
    return { status: "unresolved", reason: ghFailure(view.code, view.timedOut) };
  }

  const parsed = parsePayload(view.stdout);
  if (!parsed) {
    return { status: "unresolved", reason: "malformed-response" };
  }
  if (local && !sameRepo(local, parsed.repo)) {
    return { status: "unresolved", reason: "repo-mismatch" };
  }
  const churn = parsed.additions + parsed.deletions;
  if (churn === 0 || parsed.changedFiles === 0) {
    return { status: "unresolved", reason: "empty-diff" };
  }
  return {
    status: "resolved",
    churn,
    changedFiles: parsed.changedFiles,
    prNumber,
    repo: { owner: parsed.repo.owner, name: parsed.repo.name },
    isCrossRepository: parsed.isCrossRepository,
  };
}

interface Repo {
  host: string;
  owner: string;
  name: string;
}

/** A PR on another host is a different repository even when owner and name coincide. */
function sameRepo(left: Repo, right: Repo): boolean {
  return (
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase()
  );
}

function ghFailure(code: number | null, timedOut: boolean): UnresolvedReason {
  if (timedOut) {
    return "timed-out";
  }
  if (code === null) {
    return "gh-not-installed";
  }
  if (code === 4) {
    return "gh-not-authenticated";
  }
  if (code === 1) {
    // Not found and private-without-access are indistinguishable without reading
    // stderr, which must not be treated as data. Both report not found.
    return "pr-not-found";
  }
  return "github-unavailable";
}

const HOST = "([A-Za-z0-9.-]{1,253})";
const OWNER = "([A-Za-z0-9-]{1,39})";
const NAME = "([A-Za-z0-9._-]{1,100})";
const NAME_LAZY = "([A-Za-z0-9._-]{1,100}?)";

/** `scheme://[user@]host[:port]/owner/name[.git]`, covering https and ssh remotes. */
const REMOTE_URL = new RegExp(
  `^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/]+@)?${HOST}(?::\\d{1,5})?/${OWNER}/${NAME_LAZY}(?:\\.git)?/?$`,
);
/** The scp-like form `[user@]host:owner/name[.git]`, which carries no scheme. */
const REMOTE_SCP = new RegExp(`^(?:[^@/]+@)?${HOST}:${OWNER}/${NAME_LAZY}(?:\\.git)?/?$`);

function parseRemote(url: string): Repo | undefined {
  const match = REMOTE_URL.exec(url) ?? REMOTE_SCP.exec(url);
  return match ? { host: match[1]!, owner: match[2]!, name: match[3]! } : undefined;
}

interface Payload {
  additions: number;
  deletions: number;
  changedFiles: number;
  repo: Repo;
  isCrossRepository: boolean;
}

function parsePayload(stdout: string): Payload | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const additions = finite(record.additions);
  const deletions = finite(record.deletions);
  const changedFiles = finite(record.changedFiles);
  const repo = typeof record.url === "string" ? parsePrUrl(record.url) : undefined;
  if (additions === undefined || deletions === undefined || changedFiles === undefined || !repo) {
    return undefined;
  }
  return {
    additions,
    deletions,
    changedFiles,
    repo,
    isCrossRepository: record.isCrossRepository === true,
  };
}

/** `NaN` is a `number` to TypeScript and is rejected by zod, so it must not escape here. */
function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const PR_URL = new RegExp(`^https?://${HOST}(?::\\d{1,5})?/${OWNER}/${NAME}/pull/\\d+$`);

function parsePrUrl(url: string): Repo | undefined {
  const match = PR_URL.exec(url);
  return match ? { host: match[1]!, owner: match[2]!, name: match[3]! } : undefined;
}
