import { describe, expect, it } from "vitest";
import { ReservationService } from "../../src/reservations/reservation-service.js";
import { ReservationRepository } from "../../src/store/reservation-repository.js";
import { openDatabase } from "../../src/store/database.js";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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

  it("atomically prevents separate connections from crossing the shared reserve", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "router-reservations-"));
    const firstDb = openDatabase({ home });
    const secondDb = openDatabase({ home });
    const now = Date.parse("2026-09-17T09:00:00.000Z");
    const first = new ReservationService(() => now, new ReservationRepository(firstDb));
    const second = new ReservationService(() => now, new ReservationRepository(secondDb));
    expect(
      first.tryCreate({ accountId: "acct_shared", ratio: 0.06, ttlMs: 60_000, maxTotalRatio: 0.1 }),
    ).toBeDefined();
    expect(
      second.tryCreate({
        accountId: "acct_shared",
        ratio: 0.06,
        ttlMs: 60_000,
        maxTotalRatio: 0.1,
      }),
    ).toBeUndefined();
    expect(second.activeRatio("acct_shared")).toBeCloseTo(0.06);
    firstDb.close();
    secondDb.close();
  });

  it("releases a persisted reservation for later processes", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "router-reservations-"));
    const db = openDatabase({ home });
    const service = new ReservationService(() => 1_000, new ReservationRepository(db));
    const reservation = service.create({ accountId: "acct", ratio: 0.05, ttlMs: 60_000 });
    expect(
      new ReservationService(() => 1_000, new ReservationRepository(db)).activeRatio("acct"),
    ).toBe(0.05);
    service.release(reservation.id);
    expect(service.activeRatio("acct")).toBe(0);
    db.close();
  });

  it("checks capacity read-only with wouldFit", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "router-reservations-"));
    const db = openDatabase({ home });
    for (const service of [
      new ReservationService(() => 1_000),
      new ReservationService(() => 1_000, new ReservationRepository(db)),
    ]) {
      service.create({ accountId: "acct", ratio: 0.05, ttlMs: 60_000 });
      expect(service.wouldFit({ accountId: "acct", ratio: 0.05, maxTotalRatio: 0.1 })).toBe(true);
      expect(service.wouldFit({ accountId: "acct", ratio: 0.06, maxTotalRatio: 0.1 })).toBe(false);
      expect(service.activeRatio("acct")).toBeCloseTo(0.05);
    }
    db.close();
  });
});
