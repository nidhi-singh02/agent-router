import { randomUUID } from "node:crypto";
import { RouterSessionSchema, type RouterSession, type WorkflowPhase } from "../domain/session.js";
import { SessionRepository } from "../store/session-repository.js";
import { shouldReconsiderRoute } from "./phase-transition.js";

export class SessionService {
  constructor(private readonly sessions: SessionRepository) {}

  create(task: string, phase: WorkflowPhase): RouterSession {
    const now = new Date().toISOString();
    const session = RouterSessionSchema.parse({
      id: randomUUID(),
      task,
      phase,
      reservations: [],
      handoffs: [],
      createdAt: now,
      updatedAt: now,
    });
    this.sessions.save(session);
    return session;
  }

  resume(id: string): RouterSession | undefined {
    return this.sessions.get(id);
  }

  needsReroute(
    session: RouterSession,
    nextPhase: WorkflowPhase,
    routeStillEligible: boolean,
  ): boolean {
    return shouldReconsiderRoute({
      currentPhase: session.phase,
      nextPhase,
      routeStillEligible,
    });
  }
}
