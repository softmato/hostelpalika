import { describe, expect, it } from "vitest";

import { suspensionStage, trialEndSuspension } from "./hostel-suspension";

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

describe("trialEndSuspension", () => {
  const trialEndsAt = new Date("2026-10-26T18:14:59.999Z"); // end of Kartik 9 in Kathmandu

  it("counts down the trial's last three days and blocks at its end", () => {
    const block = trialEndSuspension(trialEndsAt, new Date("2026-10-13T06:00:00Z"));

    expect(block.graceEndsAt).toEqual(trialEndsAt);
    expect(block.startedAt).toEqual(new Date(trialEndsAt.getTime() - 3 * 86_400_000));
    expect(suspensionStage(block, new Date("2026-10-20T00:00:00Z"))).toBeNull();
  });

  it("gives three days from today when the trial is already over at approval", () => {
    const now = new Date("2026-10-30T06:00:00Z");
    const block = trialEndSuspension(trialEndsAt, now);

    expect(block.startedAt).toEqual(now);
    expect(block.graceEndsAt.getTime()).toBeGreaterThan(now.getTime() + 2 * 86_400_000);
    expect(suspensionStage(block, now)).toBe("PRE_SUSPENSION");
  });
});
