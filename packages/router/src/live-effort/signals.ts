import { z } from "zod";

/** What an agent may report about its current sub-step. Numbers and enums only. */
export const SignalsSchema = z
  .object({
    stepKind: z.enum(["explore", "edit", "debug", "verify", "refactor"]).optional(),
    consecutiveFailures: z.number().int().min(0).max(100).optional(),
    testsFailing: z.boolean().optional(),
    filesTouched: z.number().int().min(0).max(10_000).optional(),
    diffLines: z.number().int().min(0).max(1_000_000).optional(),
    blocked: z.boolean().optional(),
  })
  .strict();

export type Signals = z.infer<typeof SignalsSchema>;

/**
 * The form sent to TypeSafe and stored in `effort_changes`: counts become buckets, as
 * enrichment does, so a raw number never fingerprints the work.
 */
export type SignalShapes = {
  stepKind?: Signals["stepKind"];
  consecutiveFailures?: "0" | "1" | "2" | "3+";
  testsFailing?: boolean;
  filesTouched?: "0" | "1-5" | "6-20" | "21+";
  diffLines?: "<50" | "50-300" | "300-1000" | "1000+";
  blocked?: boolean;
};

export function toSignalShapes(signals: Signals): SignalShapes {
  const shapes: SignalShapes = {};
  if (signals.stepKind !== undefined) shapes.stepKind = signals.stepKind;
  if (signals.consecutiveFailures !== undefined) {
    const n = signals.consecutiveFailures;
    shapes.consecutiveFailures = n >= 3 ? "3+" : (String(n) as "0" | "1" | "2");
  }
  if (signals.testsFailing !== undefined) shapes.testsFailing = signals.testsFailing;
  if (signals.filesTouched !== undefined) {
    const n = signals.filesTouched;
    shapes.filesTouched = n === 0 ? "0" : n <= 5 ? "1-5" : n <= 20 ? "6-20" : "21+";
  }
  if (signals.diffLines !== undefined) {
    const n = signals.diffLines;
    shapes.diffLines = n < 50 ? "<50" : n < 300 ? "50-300" : n < 1000 ? "300-1000" : "1000+";
  }
  if (signals.blocked !== undefined) shapes.blocked = signals.blocked;
  return shapes;
}
