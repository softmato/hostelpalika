import { describe, expect, it } from "vitest";

import { hasBothKycDocuments } from "@/modules/hostels/hostel-kyc.service";
import { DEFAULT_PLANS } from "@/lib/platform-config/plans.defaults";

import { branchPlan } from "./plan-limits";

const now = new Date("2026-11-09T00:00:00Z");
const past = new Date("2026-11-06T00:00:00Z");
const future = new Date("2026-11-12T00:00:00Z");
const top = DEFAULT_PLANS.plans[DEFAULT_PLANS.plans.length - 1];
const cheapest = DEFAULT_PLANS.plans[0];

describe("branchPlan", () => {
  it("gives a running trial the top plan (everything in Max)", () => {
    expect(branchPlan(DEFAULT_PLANS, { trialEndsAt: future }, now)?.id).toBe(top.id);
    expect(branchPlan(DEFAULT_PLANS, { planId: cheapest.id, trialEndsAt: future }, now)?.id).toBe(top.id);
  });

  it("uses the paid plan, and nothing once the trial is over", () => {
    expect(branchPlan(DEFAULT_PLANS, { currentPeriodEnd: future, planId: cheapest.id, trialEndsAt: future }, now)?.id).toBe(cheapest.id);
    expect(branchPlan(DEFAULT_PLANS, { trialEndsAt: past }, now)).toBeNull();
  });
});

describe("hasBothKycDocuments", () => {
  it("needs the owner's ID and the PAN / VAT, neither rejected", () => {
    expect(hasBothKycDocuments([{ documentType: "Owner ID proof" }])).toBe(false);
    expect(hasBothKycDocuments([{ documentType: "Owner ID proof" }, { documentType: "PAN / VAT document" }])).toBe(true);
    expect(
      hasBothKycDocuments([{ documentType: "Owner ID proof" }, { documentType: "PAN / VAT document", status: "REJECTED" }]),
    ).toBe(false);
  });
});
