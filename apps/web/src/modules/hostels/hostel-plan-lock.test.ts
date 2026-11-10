import { describe, expect, it } from "vitest";

import { isBlockedWhileOverLimit, isPlanReadOnly } from "./hostel-kyc-lock";

describe("isBlockedWhileOverLimit", () => {
  it.each([
    ["POST", "/api/v1/hostel-admin/residents", true],
    ["GET", "/api/v1/hostel-admin/residents", false],
    ["POST", "/api/v1/hostel-admin/residents/abc/move-out", false],
    ["DELETE", "/api/v1/hostel-admin/wardens/abc", false],
    ["PATCH", "/api/v1/hostel-admin/wardens/abc", true],
    ["POST", "/api/v1/hostel-admin/billing/checkout", false],
  ])("%s %s → %s", (method, path, blocked) => {
    expect(isBlockedWhileOverLimit(method, path)).toBe(blocked);
  });

  it("reads the over-limit clock", () => {
    const now = new Date("2026-11-09T00:00:00Z");
    expect(isPlanReadOnly({ readOnlyFrom: new Date("2026-11-08T00:00:00Z") }, now)).toBe(true);
    expect(isPlanReadOnly({ readOnlyFrom: new Date("2026-11-10T00:00:00Z") }, now)).toBe(false);
    expect(isPlanReadOnly(null, now)).toBe(false);
  });
});
