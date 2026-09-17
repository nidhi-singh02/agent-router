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

/** The handoff as a plain-text prompt for an interactive agent; empty sections are omitted. */
export function formatHandoffPrompt(handoff: Handoff): string {
  const lines = [handoff.task, "", `Phase: ${handoff.phase}`];
  const section = (title: string, items: string[]) => {
    if (items.length > 0) {
      lines.push(`${title}:`, ...items.map((item) => `- ${item}`));
    }
  };
  section("Constraints", handoff.constraints);
  section("Relevant files", handoff.relevantFiles);
  section("Completed checks", handoff.completedChecks);
  section("Remaining acceptance criteria", handoff.remainingAcceptanceCriteria);
  return redactCollectorText(lines.join("\n"));
}
