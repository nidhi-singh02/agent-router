import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ReasoningEffort } from "../domain/model-profile.js";

export type EffortChangeSource = "agent" | "manual" | "phase-boundary";
export type EffortChangeStatus = "applied" | "no-change" | "failed";

export interface EffortChange {
  id: string;
  sessionId: string;
  source: EffortChangeSource;
  from: ReasoningEffort;
  to: ReasoningEffort;
  status: EffortChangeStatus;
  reason: string;
  confidence?: number;
  /** Structured, bucketed signals only; the sub-step text is never stored. */
  signals?: Record<string, unknown>;
  turnBreak: boolean;
  createdAt: string;
}

interface Row {
  id: string;
  session_id: string;
  source: EffortChangeSource;
  from_effort: ReasoningEffort;
  to_effort: ReasoningEffort;
  status: EffortChangeStatus;
  reason: string;
  confidence: number | null;
  signals_json: string | null;
  turn_break: number;
  created_at: string;
}

function fromRow(row: Row): EffortChange {
  return {
    id: row.id,
    sessionId: row.session_id,
    source: row.source,
    from: row.from_effort,
    to: row.to_effort,
    status: row.status,
    reason: row.reason,
    ...(row.confidence === null ? {} : { confidence: row.confidence }),
    ...(row.signals_json === null
      ? {}
      : { signals: JSON.parse(row.signals_json) as Record<string, unknown> }),
    turnBreak: row.turn_break === 1,
    createdAt: row.created_at,
  };
}

export class EffortChangeRepository {
  constructor(private readonly db: Database.Database) {}

  record(change: Omit<EffortChange, "id">): EffortChange {
    const saved = { ...change, id: `eff_${randomUUID()}` };
    this.db
      .prepare(
        `insert into effort_changes
          (id, session_id, source, from_effort, to_effort, status, reason, confidence,
           signals_json, turn_break, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        saved.id,
        saved.sessionId,
        saved.source,
        saved.from,
        saved.to,
        saved.status,
        saved.reason,
        saved.confidence ?? null,
        saved.signals ? JSON.stringify(saved.signals) : null,
        saved.turnBreak ? 1 : 0,
        saved.createdAt,
      );
    return saved;
  }

  listForSession(sessionId: string): EffortChange[] {
    const rows = this.db
      .prepare(
        `select * from effort_changes where session_id = ? order by created_at asc, rowid asc`,
      )
      .all(sessionId) as Row[];
    return rows.map(fromRow);
  }

  /** How many agent-initiated switches were applied, and when the latest was: the cooldown and cap inputs. */
  agentSwitchStats(sessionId: string): { count: number; lastAt?: string } {
    const row = this.db
      .prepare(
        // The cap counts applied switches; the cooldown also runs from failed attempts, so
        // an agent retrying after exit 5 cannot type into its pane in a loop.
        `select
           sum(case when status = 'applied' then 1 else 0 end) as count,
           max(created_at) as lastAt
         from effort_changes
         where session_id = ? and source = 'agent' and status in ('applied', 'failed')`,
      )
      .get(sessionId) as { count: number | null; lastAt: string | null };
    return { count: row.count ?? 0, ...(row.lastAt ? { lastAt: row.lastAt } : {}) };
  }

  /**
   * Takes the switch lock for a pane. A lock left behind by a crashed process expires, so
   * it can never wedge a pane.
   */
  tryLock(lockKey: string, holder: string, nowMs: number, ttlMs: number): boolean {
    const take = this.db.transaction(() => {
      this.db.prepare(`delete from effort_locks where expires_at <= ?`).run(nowMs);
      const result = this.db
        .prepare(
          `insert or ignore into effort_locks (lock_key, holder, expires_at) values (?, ?, ?)`,
        )
        .run(lockKey, holder, nowMs + ttlMs);
      return result.changes === 1;
    });
    return take();
  }

  unlock(lockKey: string, holder: string): void {
    this.db
      .prepare(`delete from effort_locks where lock_key = ? and holder = ?`)
      .run(lockKey, holder);
  }
}
