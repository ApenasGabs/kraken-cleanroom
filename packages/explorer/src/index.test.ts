import { describe, expect, it } from "vitest";
import { EXPLORER_PHASE_ID } from "./index.js";

describe("@cleanroom/explorer", () => {
  it("exports the explore pipeline phase id", () => {
    expect(EXPLORER_PHASE_ID).toBe("explore");
  });
});

describe.skipIf(!process.env.CLEANROOM_BROWSER_WS_ENDPOINT)(
  "@cleanroom/explorer browser E2E (requires CLEANROOM_BROWSER_WS_ENDPOINT)",
  () => {
    it("only runs when a remote CDP endpoint is configured", () => {
      expect(process.env.CLEANROOM_BROWSER_WS_ENDPOINT).toBeTruthy();
    });
  },
);
