import { HandoffSchema, type Handoff, type WorkflowPhase } from "../domain/session.js";
import { redactCollectorText } from "../collectors/normalizer.js";

export function buildHandoff(input: {
  task: string;
  approvedSpec: string;
  constraints: string[];
  currentPhase: WorkflowPhase;
  relevantFiles: string[];
  completedChecks: string[];
  remainingAcceptanceCriteria: string[];
}): Handoff {
  return HandoffSchema.parse({
    id: "handoff_1",
    phase: input.currentPhase,
    task: redactCollectorText(`${input.task}\n\nApproved spec: ${input.approvedSpec}`),
    constraints: input.constraints,
    relevantFiles: input.relevantFiles,
    completedChecks: input.completedChecks,
    remainingAcceptanceCriteria: input.remainingAcceptanceCriteria,
    createdAt: new Date().toISOString(),
  });
}
