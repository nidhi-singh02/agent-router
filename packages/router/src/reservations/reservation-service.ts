import { randomUUID } from "node:crypto";
import type { ReservationRepository } from "../store/reservation-repository.js";

export interface LocalReservation {
  id: string;
  accountId: string;
  ratio: number;
  createdAt: number;
  expiresAt: number;
}

export class ReservationService {
  private reservations = new Map<string, LocalReservation>();
  private seq = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly repository?: ReservationRepository,
  ) {}

  create(input: { accountId: string; ratio: number; ttlMs: number }): LocalReservation {
    this.cleanupExpired();
    const reservation: LocalReservation = {
      id: this.repository ? `res_${randomUUID()}` : `res_${++this.seq}`,
      accountId: input.accountId,
      ratio: input.ratio,
      createdAt: this.now(),
      expiresAt: this.now() + input.ttlMs,
    };
    if (this.repository) this.repository.tryInsert(reservation);
    else this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  tryCreate(input: {
    accountId: string;
    ratio: number;
    ttlMs: number;
    maxTotalRatio: number;
  }): LocalReservation | undefined {
    const reservation: LocalReservation = {
      id: this.repository ? `res_${randomUUID()}` : `res_${++this.seq}`,
      accountId: input.accountId,
      ratio: input.ratio,
      createdAt: this.now(),
      expiresAt: this.now() + input.ttlMs,
    };
    if (this.repository)
      return this.repository.tryInsert(reservation, input.maxTotalRatio) ? reservation : undefined;
    if (this.activeRatio(input.accountId) + input.ratio > input.maxTotalRatio + Number.EPSILON)
      return undefined;
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  reconcile(accountId: string, ratio: number): void {
    if (this.repository) {
      this.repository.reconcile(accountId, ratio);
      return;
    }
    for (const reservation of this.reservations.values()) {
      if (reservation.accountId === accountId) {
        reservation.ratio = ratio;
      }
    }
  }

  release(id: string): void {
    if (this.repository) {
      this.repository.release(id);
      return;
    }
    this.reservations.delete(id);
  }

  cleanupExpired(): void {
    const now = this.now();
    if (this.repository) {
      this.repository.cleanupExpired(now);
      return;
    }
    for (const [id, reservation] of this.reservations) {
      if (reservation.expiresAt <= now) {
        this.reservations.delete(id);
      }
    }
  }

  activeRatio(accountId: string): number {
    if (this.repository) return this.repository.activeRatio(accountId, this.now());
    this.cleanupExpired();
    return [...this.reservations.values()]
      .filter((reservation) => reservation.accountId === accountId)
      .reduce((sum, reservation) => sum + reservation.ratio, 0);
  }
}
