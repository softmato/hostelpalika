import { describe, expect, it } from "vitest";

import { suspensionStage } from "./hostel-suspension";

describe("suspensionStage", () => {
  const startedAt = new Date("2026-10-23T18:15:00Z");
  const graceEndsAt = new Date("2026-10-26T18:15:00Z");
  const trialEnd = { graceEndsAt, reason: "TRIAL_ENDED", startedAt };

  it("is nothing while a trial's end is still ahead", () => {
    expect(suspensionStage(trialEnd, new Date("2026-10-20T00:00:00Z"))).toBeNull();
  });

  it("counts down for the last days, then blocks", () => {
    expect(suspensionStage(trialEnd, new Date("2026-10-24T00:00:00Z"))).toBe("PRE_SUSPENSION");
    expect(suspensionStage(trialEnd, new Date("2026-10-27T00:00:00Z"))).toBe("SUSPENDED");
  });

  it("is nothing without a suspension", () => {
    expect(suspensionStage(null)).toBeNull();
  });
});
