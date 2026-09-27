import type { RouterSession } from "../domain/session.js";
import type { EffortChange } from "../store/effort-change-repository.js";

function routeLabel(session: RouterSession): string {
  const route = session.route;
  if (!route) {
    return "none";
  }
  return `${route.agent} / ${route.launchName} / ${route.effort} (${route.accountId})`;
}

export function formatSession(session: RouterSession, effortChanges: EffortChange[] = []): string {
  const lines = [
    `Session: ${session.id}`,
    `Task: ${session.task}`,
    `Phase: ${session.phase}`,
    ...(session.previousSessionId ? [`Previous session: ${session.previousSessionId}`] : []),
    `Route: ${routeLabel(session)}`,
    `Status: ${session.route?.status ?? "none"}`,
  ];
  if (session.route?.error) {
    lines.push(`Error: ${session.route.error}`);
  }
  if (session.route?.reason) {
    lines.push(`Why: ${session.route.reason}`);
  }
  lines.push(`Agent: ${session.route?.agentName ?? "none"}`);
  lines.push(`Pane: ${session.paneId ?? "none"}`);
  // Sessions recorded without `--worktree` have no workspace and print as they always have.
  const workspace = session.workspace;
  if (workspace) {
    lines.push(
      `Workspace isolation: ${workspace.isolated ? "enabled" : "disabled"}`,
      `Worktree: ${workspace.path}`,
      `Branch: ${workspace.branch}`,
      `Repository: ${workspace.repository.sourceRoot} (git dir ${workspace.repository.gitCommonDir})`,
      `Base commit: ${workspace.baseCommit}`,
    );
  }
  if (session.continuation === "in-place") {
    lines.push("Continuation: in place (same pane as the previous session)");
  }
  if (session.liveEffort && session.liveEffort !== session.route?.effort) {
    lines.push(`Current effort: ${session.liveEffort}`);
  }
  if (session.liveSwitchUnsupported) {
    lines.push("Live effort switching: unsupported for this pane (new phases open a new pane)");
  }
  if (effortChanges.length > 0) {
    lines.push("Effort history:");
    for (const change of effortChanges) {
      const confidence =
        change.confidence === undefined ? "" : `, confidence ${change.confidence.toFixed(2)}`;
      lines.push(
        `  ${change.createdAt} ${change.source}: ${change.from} -> ${change.to} ${change.status} (${change.reason}${confidence})`,
      );
    }
  }
  lines.push(`Started: ${session.createdAt}`);
  return lines.join("\n");
}

export function formatSessionList(sessions: RouterSession[]): string {
  return sessions
    .map((session) => {
      const route = session.route
        ? `${session.route.agent}/${session.route.launchName}/${session.route.effort}`
        : "none";
      const task = session.task.length > 60 ? `${session.task.slice(0, 57)}...` : session.task;
      return [
        session.id,
        session.createdAt,
        session.phase,
        route,
        session.route?.status ?? "none",
        task.replace(/\s+/g, " "),
      ].join("\t");
    })
    .join("\n");
}
