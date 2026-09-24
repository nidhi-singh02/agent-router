import { z } from "zod";
import { AccountIdSchema, SessionIdSchema } from "./ids.js";
import { RatioSchema } from "./account.js";
import { ReasoningEffortSchema } from "./model-profile.js";

export const WorkflowPhaseSchema = z.enum([
  "planning",
  "specification",
  "implementation",
  "debugging",
  "review",
  "creative-ideation",
  "metadata",
  "research",
  "routine-transformation",
]);

export const ReservationSchema = z.object({
  id: z.string().min(1),
  accountId: AccountIdSchema,
  ratio: RatioSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export const HandoffSchema = z.object({
  id: z.string().min(1),
  phase: WorkflowPhaseSchema,
  task: z.string().min(1),
  constraints: z.array(z.string()),
  relevantFiles: z.array(z.string()),
  completedChecks: z.array(z.string()),
  remainingAcceptanceCriteria: z.array(z.string()),
  createdAt: z.iso.datetime(),
});

export const CacheAffinitySchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  effort: ReasoningEffortSchema,
  agent: z.string().min(1),
  promptPrefixHash: z.string().min(1),
});

export const SessionRouteSchema = z.object({
  accountId: AccountIdSchema,
  modelId: z.string().min(1),
  agent: z.string().min(1),
  launchName: z.string().min(1),
  effort: ReasoningEffortSchema,
  reason: z.string().min(1),
  status: z.enum(["launched", "launch-failed"]),
  launchToken: z.string().min(1).optional(),
  agentName: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});

/**
 * A Git worktree the router created with `router run --worktree`. Sessions without this
 * field ran in the caller's current directory, as before the option existed.
 */
export const SessionWorkspaceSchema = z.object({
  isolated: z.boolean(),
  path: z.string().min(1),
  branch: z.string().min(1),
  repository: z.object({
    /** Canonical shared `.git` directory: the identity every worktree of the repo shares. */
    gitCommonDir: z.string().min(1),
    /** Checkout the worktree was created from, for display. */
    sourceRoot: z.string().min(1),
  }),
  baseCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
  createdAt: z.iso.datetime(),
});

export const RouterSessionSchema = z.object({
  id: SessionIdSchema,
  task: z.string().min(1),
  phase: WorkflowPhaseSchema,
  route: SessionRouteSchema.optional(),
  /** The session for the previous workflow phase, set by `router run --session <id>`. */
  previousSessionId: SessionIdSchema.optional(),
  cacheAffinity: CacheAffinitySchema.optional(),
  reservations: z.array(ReservationSchema),
  handoffs: z.array(HandoffSchema),
  paneId: z.string().min(1).optional(),
  workspace: SessionWorkspaceSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type WorkflowPhase = z.infer<typeof WorkflowPhaseSchema>;
export type Reservation = z.infer<typeof ReservationSchema>;
export type Handoff = z.infer<typeof HandoffSchema>;
export type CacheAffinity = z.infer<typeof CacheAffinitySchema>;
export type SessionRoute = z.infer<typeof SessionRouteSchema>;
export type SessionWorkspace = z.infer<typeof SessionWorkspaceSchema>;
export type RouterSession = z.infer<typeof RouterSessionSchema>;
