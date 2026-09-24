import type { RouterSession } from "../domain/session.js";

function routeLabel(session: RouterSession): string {
  const route = session.route;
  if (!route) {
    return "none";
  }
  return `${route.agent} / ${route.launchName} / ${route.effort} (${route.accountId})`;
}

export function formatSession(session: RouterSession): string {
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
