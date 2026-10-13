import { describe, expect, it } from "vitest";

import { isBlockedAfterTrial, isKycFrozenRequest, isKycLocked, isTrialOverWithoutKyc } from "./hostel-kyc-lock";

describe("isKycFrozenRequest", () => {
  it("refuses writes to frozen features", () => {
    expect(isKycFrozenRequest("POST", "/api/v1/hostel-admin/residents")).toBe(true);
    expect(isKycFrozenRequest("PATCH", "/api/v1/hostel-admin/finance/statements/abc")).toBe(true);
    expect(isKycFrozenRequest("POST", "/api/v1/hostel-admin/wardens")).toBe(true);
  });

  it("leaves reads, and the KYC's own finance steps, open", () => {
    expect(isKycFrozenRequest("GET", "/api/v1/hostel-admin/residents")).toBe(false);
    expect(isKycFrozenRequest("POST", "/api/v1/hostel-admin/finance/fee-schedules")).toBe(false);
    expect(isKycFrozenRequest("PUT", "/api/v1/hostel-admin/finance/payment-profile")).toBe(false);
    expect(isKycFrozenRequest("PUT", "/api/v1/hostel-admin/finance/money-rules")).toBe(false);
  });

  it("leaves the basics open", () => {
    expect(isKycFrozenRequest("POST", "/api/v1/hostel-admin/rooms")).toBe(false);
    expect(isKycFrozenRequest("POST", "/api/v1/hostel-admin/kyc")).toBe(false);
    expect(isKycFrozenRequest("POST", "/api/v1/hostel-admin/notices")).toBe(false);
    // A prefix is a path segment, not a string prefix.
    expect(isKycFrozenRequest("POST", "/api/v1/hostel-admin/residents-help")).toBe(false);
  });
});

describe("isKycLocked", () => {
  it("locks only a quick sign-up that is not yet approved", () => {
    expect(isKycLocked({ required: true, status: "SUBMITTED" })).toBe(true);
    expect(isKycLocked({ required: true, status: "APPROVED" })).toBe(false);
    // Every hostel registered before the quick sign-up has no `kyc` at all.
    expect(isKycLocked(undefined)).toBe(false);
    expect(isKycLocked({ required: false, status: null })).toBe(false);
  });
});

describe("after the trial, without an approved KYC", () => {
  const trialEndsAt = new Date("2026-10-27T18:14:59Z");
  const after = new Date("2026-10-28T06:00:00Z");

  it("applies only once the trial is over and only until approval", () => {
    expect(isTrialOverWithoutKyc({ required: true, status: "SUBMITTED", trialEndsAt }, after)).toBe(true);
    expect(isTrialOverWithoutKyc({ required: true, status: "DRAFT", trialEndsAt }, new Date("2026-10-20T00:00:00Z"))).toBe(false);
    expect(isTrialOverWithoutKyc({ required: true, status: "APPROVED", trialEndsAt }, after)).toBe(false);
    expect(isTrialOverWithoutKyc(undefined, after)).toBe(false);
  });

  it("leaves the KYC sections and the plan open, and blocks every other hostel write", () => {
    expect(isBlockedAfterTrial("POST", "/api/v1/hostel-admin/kyc/submit")).toBe(false);
    expect(isBlockedAfterTrial("PATCH", "/api/v1/hostel-admin/profile")).toBe(false);
    expect(isBlockedAfterTrial("POST", "/api/v1/hostel-admin/finance/fee-schedules")).toBe(false);
    expect(isBlockedAfterTrial("POST", "/api/v1/hostel-admin/notices")).toBe(true);
    expect(isBlockedAfterTrial("POST", "/api/v1/hostel-admin/complaints/abc")).toBe(true);
    expect(isBlockedAfterTrial("GET", "/api/v1/hostel-admin/notices")).toBe(false);
    // Not the hostel's portal: signing out, files, notifications stay usable.
    expect(isBlockedAfterTrial("POST", "/api/v1/auth/logout")).toBe(false);
    expect(isBlockedAfterTrial("POST", "/api/v1/files")).toBe(false);
  });
});
