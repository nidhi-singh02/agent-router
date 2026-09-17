import { z } from "zod";
import { AccountIdSchema } from "./ids.js";
import { CollectorKindSchema, RatioSchema } from "./account.js";

export const UsageWindowKindSchema = z.enum([
  "five-hour",
  "daily",
  "weekly",
  "monthly",
  "provider-defined",
]);

export const UsageCertaintySchema = z.enum(["exact", "estimated", "unknown"]);

export const UsageWindowSchema = z.object({
  kind: UsageWindowKindSchema,
  // Names a provider quota pool (for example Cursor "spend" or "auto"); unpooled windows apply to every model.
  pool: z.string().min(1).optional(),
  remainingRatio: RatioSchema.optional(),
  usedRatio: RatioSchema.optional(),
  resetsAt: z.iso.datetime().optional(),
});

// "none" marks the fallback snapshot when no collector returned usage.
export const UsageSourceSchema = z.union([CollectorKindSchema, z.literal("none")]);

export const UsageSnapshotSchema = z.object({
  accountId: AccountIdSchema,
  windows: z.array(UsageWindowSchema).min(1),
  collectedAt: z.iso.datetime(),
  source: UsageSourceSchema,
  certainty: UsageCertaintySchema,
  expiresAt: z.iso.datetime(),
  activeReservationRatio: RatioSchema,
});

export type UsageSource = z.infer<typeof UsageSourceSchema>;
export type UsageWindowKind = z.infer<typeof UsageWindowKindSchema>;
export type UsageCertainty = z.infer<typeof UsageCertaintySchema>;
export type UsageWindow = z.infer<typeof UsageWindowSchema>;
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;
