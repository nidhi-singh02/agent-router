import { HandoffSchema, type Handoff, type WorkflowPhase } from "../domain/session.js";
import { redactCollectorText } from "../collectors/normalizer.js";

export function buildHandoff(input: {
  task: string;
  approvedSpec?: string;
  constraints: string[];
  currentPhase: WorkflowPhase;
  relevantFiles: string[];
  completedChecks: string[];
  remainingAcceptanceCriteria: string[];
}): Handoff {
  const task = input.approvedSpec
    ? `${input.task}\n\nApproved spec: ${input.approvedSpec}`
    : input.task;
  return HandoffSchema.parse({
    id: "handoff_1",
    phase: input.currentPhase,
    task: redactCollectorText(task),
    constraints: input.constraints,
    relevantFiles: input.relevantFiles,
    completedChecks: input.completedChecks,
    remainingAcceptanceCriteria: input.remainingAcceptanceCriteria,
    createdAt: new Date().toISOString(),
  });
}

export function serializeHandoff(handoff: Handoff): string {
  return redactCollectorText(JSON.stringify(handoff));
}

export interface HandoffRouterContext {
  /** Session recorded for this launch; the agent uses it to route the next phase. */
  sessionId: string;
  previous?: { sessionId: string; phase: string; task: string };
  /** The isolated worktree the agent was started in, for `router run --worktree`. */
  workspace?: { path: string; branch: string };
}

/** The handoff as a plain-text prompt for an interactive agent; empty sections are omitted. */
export function formatHandoffPrompt(handoff: Handoff, router?: HandoffRouterContext): string {
  const lines = [handoff.task, "", `Phase: ${handoff.phase}`];
  if (router?.previous) {
    lines.push(
      `Previous phase: ${router.previous.phase} (session ${router.previous.sessionId}): ${router.previous.task}`,
    );
  }
  const section = (title: string, items: string[]) => {
    if (items.length > 0) {
      lines.push(`${title}:`, ...items.map((item) => `- ${item}`));
    }
  };
  section("Constraints", handoff.constraints);
  section("Relevant files", handoff.relevantFiles);
  section("Completed checks", handoff.completedChecks);
  section("Remaining acceptance criteria", handoff.remainingAcceptanceCriteria);
  const body = redactCollectorText(lines.join("\n"));
  const tail: string[] = [];
  if (router?.workspace) {
    // Router-generated paths are not redacted: the secret pattern also matches names like
    // `task-notes`, and a mangled path would send the agent to the wrong directory.
    tail.push(
      "",
      `Workspace: isolated Git worktree ${router.workspace.path} on branch ${router.workspace.branch}. ` +
        "Work only in this directory; the router does not merge, push, or delete it.",
    );
  }
  if (router) {
    tail.push(
      "",
      redactCollectorText(`Router session: ${router.sessionId}`),
      redactCollectorText(
        "When this phase is complete: write your plan or handoff notes to a file, then ask the user " +
          "whether to route the next phase. If they agree, use the model-router skill: " +
          `run \`router session ${router.sessionId}\`, then ` +
          `\`router run --session ${router.sessionId} "<next-phase task that references that file>"\`. ` +
          "Do not start another agent for the same phase.",
      ),
    );
  }
  return tail.length > 0 ? `${body}\n${tail.join("\n")}` : body;
}
