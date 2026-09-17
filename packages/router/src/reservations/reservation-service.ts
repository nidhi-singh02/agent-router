export interface LocalReservation {
  id: string;
  accountId: string;
  ratio: number;
  expiresAt: number;
}

export class ReservationService {
  private reservations = new Map<string, LocalReservation>();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  create(input: { accountId: string; ratio: number; ttlMs: number }): LocalReservation {
    this.cleanupExpired();
    const reservation: LocalReservation = {
      id: `res_${++this.seq}`,
      accountId: input.accountId,
      ratio: input.ratio,
      expiresAt: this.now() + input.ttlMs,
    };
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  reconcile(accountId: string, ratio: number): void {
    for (const reservation of this.reservations.values()) {
      if (reservation.accountId === accountId) {
        reservation.ratio = ratio;
      }
    }
  }

  release(id: string): void {
    this.reservations.delete(id);
  }

  cleanupExpired(): void {
    const now = this.now();
    for (const [id, reservation] of this.reservations) {
      if (reservation.expiresAt <= now) {
        this.reservations.delete(id);
      }
    }
  }

  activeRatio(accountId: string): number {
    this.cleanupExpired();
    return [...this.reservations.values()]
      .filter((reservation) => reservation.accountId === accountId)
      .reduce((sum, reservation) => sum + reservation.ratio, 0);
  }
}
