import { describe, expect, it } from "vitest";
import { ReservationService } from "../../src/reservations/reservation-service.js";

describe("reservations", () => {
  it("creates, reconciles, and releases local reservations", () => {
    const now = Date.parse("2026-09-17T09:00:00.000Z");
    const service = new ReservationService(() => now);
    const reservation = service.create({ accountId: "acct_shared", ratio: 0.05, ttlMs: 60_000 });
    expect(service.activeRatio("acct_shared")).toBeCloseTo(0.05);
    service.reconcile("acct_shared", 0.04);
    expect(service.activeRatio("acct_shared")).toBeCloseTo(0.04);
    service.release(reservation.id);
    expect(service.activeRatio("acct_shared")).toBe(0);
  });

  it("cleans up expired reservations", () => {
    let now = Date.parse("2026-09-17T09:00:00.000Z");
    const service = new ReservationService(() => now);
    service.create({ accountId: "acct_shared", ratio: 0.05, ttlMs: 1000 });
    now += 2000;
    service.cleanupExpired();
    expect(service.activeRatio("acct_shared")).toBe(0);
  });
});
