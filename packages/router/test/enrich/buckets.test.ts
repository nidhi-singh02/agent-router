import { describe, expect, it } from "vitest";
import { advisoryMultiplier, toShapes } from "../../src/enrich/buckets.js";

describe("toShapes", () => {
  it("maps churn to size buckets at the boundaries", () => {
    expect(toShapes({ churn: 9, changedFiles: 1 }).sizeBucket).toBe("trivial");
    expect(toShapes({ churn: 10, changedFiles: 1 }).sizeBucket).toBe("small");
    expect(toShapes({ churn: 49, changedFiles: 1 }).sizeBucket).toBe("small");
    expect(toShapes({ churn: 50, changedFiles: 1 }).sizeBucket).toBe("medium");
    expect(toShapes({ churn: 249, changedFiles: 1 }).sizeBucket).toBe("medium");
    expect(toShapes({ churn: 250, changedFiles: 1 }).sizeBucket).toBe("large");
    expect(toShapes({ churn: 999, changedFiles: 1 }).sizeBucket).toBe("large");
    expect(toShapes({ churn: 1000, changedFiles: 1 }).sizeBucket).toBe("very-large");
  });

  it("maps file counts to buckets at the boundaries", () => {
    expect(toShapes({ churn: 1, changedFiles: 1 }).fileCountBucket).toBe("1");
    expect(toShapes({ churn: 1, changedFiles: 2 }).fileCountBucket).toBe("2-5");
    expect(toShapes({ churn: 1, changedFiles: 5 }).fileCountBucket).toBe("2-5");
    expect(toShapes({ churn: 1, changedFiles: 6 }).fileCountBucket).toBe("6-20");
    expect(toShapes({ churn: 1, changedFiles: 20 }).fileCountBucket).toBe("6-20");
    expect(toShapes({ churn: 1, changedFiles: 21 }).fileCountBucket).toBe("21-100");
    expect(toShapes({ churn: 1, changedFiles: 100 }).fileCountBucket).toBe("21-100");
    expect(toShapes({ churn: 1, changedFiles: 101 }).fileCountBucket).toBe("101+");
  });

  it("always reports truncated false in this revision", () => {
    expect(toShapes({ churn: 5000, changedFiles: 500 }).truncated).toBe(false);
  });

  it("carries no array field and exactly three keys", () => {
    const shapes = toShapes({ churn: 100, changedFiles: 10 });
    for (const value of Object.values(shapes)) {
      expect(Array.isArray(value)).toBe(false);
    }
    expect(Object.keys(shapes).sort()).toEqual(["fileCountBucket", "sizeBucket", "truncated"]);
  });

  it("maps size buckets to advisory multipliers", () => {
    expect(advisoryMultiplier("trivial")).toBe(0.5);
    expect(advisoryMultiplier("small")).toBe(1);
    expect(advisoryMultiplier("medium")).toBe(2);
    expect(advisoryMultiplier("large")).toBe(4);
    expect(advisoryMultiplier("very-large")).toBe(8);
  });
});
