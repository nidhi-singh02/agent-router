import { describe, expect, it } from "vitest";
import { packageName } from "../src/index.js";

describe("router package", () => {
  it("exports the package name", () => {
    expect(packageName).toBe("@agent-router/router");
  });
});
