import { describe, expect, it } from "vitest";
import { CORE_VERSION, DEFAULT_PHASE_ORDER } from "./index.js";

describe("@cleanroom/core", () => {
  it("exports version and default pipeline phase order", () => {
    expect(CORE_VERSION).toBe("0.1.0");
    expect(DEFAULT_PHASE_ORDER).toEqual([
      "intake",
      "explore",
      "capture",
      "analyze",
      "synthesize",
      "validate",
      "report",
    ]);
  });
});
