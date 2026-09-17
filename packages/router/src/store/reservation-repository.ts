import type Database from "better-sqlite3";
import type { LocalReservation } from "../reservations/reservation-service.js";

export class ReservationRepository {
  constructor(private readonly db: Database.Database) {}

  tryInsert(reservation: LocalReservation, maxTotalRatio = Number.POSITIVE_INFINITY): boolean {
    const transact = this.db.transaction(() => {
      this.db
        .prepare("delete from capacity_reservations where expires_at <= ?")
        .run(reservation.createdAt);
      const row = this.db
        .prepare(
          "select coalesce(sum(ratio), 0) as total from capacity_reservations where account_id = ? and expires_at > ?",
        )
        .get(reservation.accountId, reservation.createdAt) as { total: number };
      if (row.total + reservation.ratio > maxTotalRatio + Number.EPSILON) return false;
      this.db
        .prepare(
          "insert into capacity_reservations (id, account_id, ratio, created_at, expires_at) values (?, ?, ?, ?, ?)",
        )
        .run(
          reservation.id,
          reservation.accountId,
          reservation.ratio,
          reservation.createdAt,
          reservation.expiresAt,
        );
      return true;
    });
    return transact.immediate();
  }

  release(id: string): void {
    this.db.prepare("delete from capacity_reservations where id = ?").run(id);
  }
  reconcile(accountId: string, ratio: number): void {
    this.db
      .prepare("update capacity_reservations set ratio = ? where account_id = ?")
      .run(ratio, accountId);
  }
  cleanupExpired(now: number): void {
    this.db.prepare("delete from capacity_reservations where expires_at <= ?").run(now);
  }
  activeRatio(accountId: string, now: number): number {
    this.cleanupExpired(now);
    const row = this.db
      .prepare(
        "select coalesce(sum(ratio), 0) as total from capacity_reservations where account_id = ? and expires_at > ?",
      )
      .get(accountId, now) as { total: number };
    return row.total;
  }
}
