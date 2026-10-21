import { describe, expect, it } from "vitest";

import { adDate, adDateTime, bsDate, leaveExportBaseName, words } from "@/modules/hostels/hostel-leave-export";
import {
  fileLinksLeft,
  leaveBlockers,
  leaveFilesUntil,
  owedOnPlan,
  partitionBySize,
  sectionOf,
  zipDownloadsLeft,
} from "@/modules/hostels/hostel-leave.service";
import { hostelLeaveApproveSchema, hostelLeaveSubmitSchema } from "@/modules/hostels/hostel-leave.validation";
import { operationsConfigSchema } from "@/modules/platform-config/operations-config";

const clear = { claimInReview: false, openStoreOrders: 0, owed: 0, pastDue: false };

describe("leaveBlockers", () => {
  it("lets a hostel that owes nothing leave", () => {
    expect(leaveBlockers(clear)).toEqual([]);
  });

  it("stops on an unpaid plan bill and names the amount", () => {
    const [blocker] = leaveBlockers({ ...clear, owed: 1500 });

    expect(blocker?.code).toBe("PLAN_BILL_OPEN");
    expect(blocker?.message).toContain("1,500");
  });

  it("says a claim in review is being checked, not that the bill is unpaid", () => {
    expect(leaveBlockers({ ...clear, claimInReview: true, owed: 1500 }).map((b) => b.code)).toEqual([
      "PLAN_CLAIM_IN_REVIEW",
    ]);
  });

  it("stops on an overdue plan and on open store orders", () => {
    expect(leaveBlockers({ ...clear, openStoreOrders: 2, pastDue: true }).map((b) => b.code)).toEqual([
      "PLAN_PAST_DUE",
      "STORE_ORDER_OPEN",
    ]);
  });
});

describe("leave hold bounds", () => {
  it("defaults to 7–15 days", () => {
    const config = operationsConfigSchema.parse({});

    expect([config.leaveHoldMinDays, config.leaveHoldMaxDays]).toEqual([7, 15]);
  });

  it("refuses a minimum longer than the maximum", () => {
    expect(operationsConfigSchema.safeParse({ leaveHoldMaxDays: 5, leaveHoldMinDays: 10 }).success).toBe(false);
  });
});

describe("leave forms", () => {
  it("needs the owner's confirmation", () => {
    expect(hostelLeaveSubmitSchema.safeParse({ holdDays: 7, reason: "Closing down" }).success).toBe(false);
    expect(hostelLeaveSubmitSchema.safeParse({ confirm: true, holdDays: 7, reason: "Closing down" }).success).toBe(true);
  });

  it("only accepts known export sections", () => {
    expect(hostelLeaveApproveSchema.safeParse({ sections: ["residents", "bills"] }).success).toBe(true);
    expect(hostelLeaveApproveSchema.safeParse({ sections: ["passwords"] }).success).toBe(false);
  });

  it("names the files after the hostel and the Nepal day", () => {
    // 20:00 UTC on the 20th is already the 21st in Kathmandu.
    expect(leaveExportBaseName("sunrise", new Date("2026-10-20T20:00:00Z"))).toBe("sunrise-data-2026-10-21");
  });
});

describe("owedOnPlan", () => {
  const now = new Date("2026-10-21T06:00:00Z");
  const paidAhead = { currentPeriodEnd: new Date("2027-11-21T18:14:59Z"), status: "ACTIVE" };

  it("ignores a lifetime checkout and an early renewal while the plan is paid ahead", () => {
    const bills = [
      { lifetime: true, outstanding: 24999 },
      { kind: "PLAN", outstanding: 1999 },
    ];

    expect(owedOnPlan(bills, paidAhead, now)).toBe(0);
  });

  it("always counts an unpaid setup fee", () => {
    expect(owedOnPlan([{ kind: "SETUP_FEE", outstanding: 500 }], paidAhead, now)).toBe(500);
  });

  it("counts plan bills once the plan has lapsed, but never a lifetime checkout", () => {
    const bills = [
      { kind: "PLAN", outstanding: 1999 },
      { lifetime: true, outstanding: 24999 },
    ];

    expect(owedOnPlan(bills, { status: "PAST_DUE" }, now)).toBe(1999);
    expect(owedOnPlan(bills, { currentPeriodEnd: new Date("2026-10-01"), status: "ACTIVE" }, now)).toBe(1999);
  });

  it("owes nothing on a registration that never went live", () => {
    expect(owedOnPlan([{ kind: "PLAN", outstanding: 1999 }], { status: "AWAITING_PAYMENT" }, now)).toBe(0);
  });
});

describe("export cells", () => {
  it("writes dates in Nepal's day, with a BS twin", () => {
    expect(adDate("2026-10-20T20:00:00Z")).toBe("2026-10-21");
    expect(bsDate(new Date("2026-10-21T06:00:00Z"))).toMatch(/^2083-07-\d{2}$/);
    expect(adDateTime("2026-10-21T06:00:00Z")).toBe("2026-10-21 11:45");
    expect(adDate(null)).toBeNull();
  });

  it("turns codes into words", () => {
    expect(words("MOVED_OUT")).toBe("Moved out");
    expect(words("")).toBeNull();
  });
});

describe("partitionBySize", () => {
  it("keeps each ZIP part under the limit, in order", () => {
    const files = [{ sizeBytes: 60 }, { sizeBytes: 50 }, { sizeBytes: 30 }, { sizeBytes: 90 }];

    expect(partitionBySize(files, 100).map((part) => part.map((file) => file.sizeBytes))).toEqual([[60], [50, 30], [90]]);
  });

  it("gives a file bigger than a part a part of its own", () => {
    expect(partitionBySize([{ sizeBytes: 10 }, { sizeBytes: 500 }, { sizeBytes: 10 }], 100)).toHaveLength(3);
  });
});

describe("leaveFilesUntil", () => {
  const approvedAt = new Date("2026-10-21T10:00:00Z");
  const days = (until: Date) => (until.getTime() - approvedAt.getTime()) / 86_400_000;

  it("keeps the files 30 days after leaving even when the hold is shorter", () => {
    expect(days(leaveFilesUntil(approvedAt, 7))).toBe(30);
  });

  it("follows the hold when the hold is longer", () => {
    expect(days(leaveFilesUntil(approvedAt, 45))).toBe(45);
  });
});

describe("download caps", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

  it("allows each ZIP part 3 times in any 24 hours", () => {
    const log = [
      { at: hoursAgo(1), part: 1 },
      { at: hoursAgo(5), part: 1 },
      { at: hoursAgo(30), part: 1 }, // older than a day — no longer counts
      { at: hoursAgo(2), part: 2 },
    ];

    expect(zipDownloadsLeft(log, 1, now)).toBe(1);
    expect(zipDownloadsLeft(log, 2, now)).toBe(2);
    expect(zipDownloadsLeft([...log, { at: hoursAgo(0), part: 1 }], 1, now)).toBe(0);
    expect(zipDownloadsLeft(undefined, 1, now)).toBe(3);
  });

  it("counts single-file links per Nepal day", () => {
    expect(fileLinksLeft({ fileLinkCount: 150, fileLinkDay: "2026-10-21" }, "2026-10-21")).toBe(50);
    expect(fileLinksLeft({ fileLinkCount: 200, fileLinkDay: "2026-10-20" }, "2026-10-21")).toBe(200);
  });
});

describe("sectionOf", () => {
  it("labels a section CSV by its section, in workbook order", () => {
    expect(sectionOf("sunrise-data-2026-10-21-residents.csv")).toEqual({ key: "residents", label: "Residents", order: 0 });
    expect(sectionOf("sunrise-data-2026-10-21-payments.csv")?.label).toBe("Payments");
    expect(sectionOf("sunrise-data-2026-10-21.xlsx")).toBeNull();
  });
});
