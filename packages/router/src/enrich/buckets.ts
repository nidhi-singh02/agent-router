/**
 * The only enrichment type that reaches TypeSafe state.
 *
 * It carries no free-form string and no array, so it can hold neither a file path nor
 * an attacker-chosen ordering. Its full domain is 5 x 5 x 2 = 50 states.
 */
export type EnrichmentShapes = {
  sizeBucket: "trivial" | "small" | "medium" | "large" | "very-large";
  fileCountBucket: "1" | "2-5" | "6-20" | "21-100" | "101+";
  truncated: boolean;
};

export function toShapes(input: { churn: number; changedFiles: number }): EnrichmentShapes {
  return {
    sizeBucket: sizeBucket(input.churn),
    fileCountBucket: fileCountBucket(input.changedFiles),
    truncated: false,
  };
}

function sizeBucket(churn: number): EnrichmentShapes["sizeBucket"] {
  if (churn < 10) {
    return "trivial";
  }
  if (churn < 50) {
    return "small";
  }
  if (churn < 250) {
    return "medium";
  }
  if (churn < 1000) {
    return "large";
  }
  return "very-large";
}

function fileCountBucket(files: number): EnrichmentShapes["fileCountBucket"] {
  if (files <= 1) {
    return "1";
  }
  if (files <= 5) {
    return "2-5";
  }
  if (files <= 20) {
    return "6-20";
  }
  if (files <= 100) {
    return "21-100";
  }
  return "101+";
}

/** Recorded for later calibration of the cost estimate. Never applied to it today. */
export function advisoryMultiplier(bucket: EnrichmentShapes["sizeBucket"]): number {
  const table: Record<EnrichmentShapes["sizeBucket"], number> = {
    trivial: 0.5,
    small: 1,
    medium: 2,
    large: 4,
    "very-large": 8,
  };
  return table[bucket];
}
