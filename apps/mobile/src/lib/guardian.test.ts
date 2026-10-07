import { describe, expect, it } from "vitest";

import type {
  GuardianDashboard,
  GuardianPayment,
  GuardianPermissions,
} from "@/lib/guardian-api";
import {
  canSee,
  guardianDueAmount,
  guardianLatestPaid,
  guardianNextDue,
  guardianOutstanding,
  guardianPaidAmount,
  NO_GUARDIAN_PERMISSIONS,
  permissionsOf,
  receiptsByMonth,
  sharedSections,
  sharesNothing,
} from "@/lib/guardian";

function permissions(granted: Partial<GuardianPermissions> = {}): GuardianPermissions {
  return { ...NO_GUARDIAN_PERMISSIONS, ...granted };
}

function payment(overrides: Partial<GuardianPayment> = {}): GuardianPayment {
  return {
    dueAmount: 5000,
    id: "pay-1",
    month: "2026-08",
    paidAmount: 0,
    status: "UNPAID",
    ...overrides,
  };
}

function dashboard(overrides: Partial<GuardianDashboard> = {}): GuardianDashboard {
  return {
    access: {
      expiresAt: "2026-12-01T00:00:00.000Z",
      guardianId: "g-1",
      hostelId: "h-1",
      id: "a-1",
      phone: "9800000000",
      residentId: "r-1",
      status: "USED",
    },
    complaints: [],
    food: [],
    guardian: { id: "g-1", name: "Bimala Rai", phone: "9800000000", relation: "Mother" },
    hostel: {
      contact: { email: "", phone: "9812345678" },
      id: "h-1",
      isVerified: true,
      location: {},
      name: "Sunrise",
      photoUrl: "",
      slug: "sunrise",
    },
    notices: [],
    payments: [],
    permissions: NO_GUARDIAN_PERMISSIONS,
    receipts: [],
    resident: {
      fullName: "Asha Rai",
      id: "r-1",
      image: null,
      roomType: "DOUBLE",
      status: "ACTIVE",
    },
    safety: null,
    summary: null,
    ...overrides,
  };
}

describe("permissionsOf", () => {
  /*
   * Deny while loading. Defaulting open and retracting sections once the
   * payload lands has already told the guardian those sections exist — and on
   * a slow connection it is on screen long enough to read.
   */
  it("denies everything before the dashboard has loaded", () => {
    expect(permissionsOf(null)).toEqual(NO_GUARDIAN_PERMISSIONS);
    expect(permissionsOf(undefined)).toEqual(NO_GUARDIAN_PERMISSIONS);
    expect(canSee(null, "canViewPayments")).toBe(false);
  });

  it("reads the flags off a loaded dashboard", () => {
    const loaded = dashboard({ permissions: permissions({ canViewFood: true }) });

    expect(canSee(loaded, "canViewFood")).toBe(true);
    expect(canSee(loaded, "canViewSafety")).toBe(false);
  });
});

describe("sharedSections", () => {
  it("lists only what was granted", () => {
    const loaded = dashboard({
      permissions: permissions({ canViewNotices: true, canViewPayments: true }),
    });

    expect(sharedSections(loaded)).toEqual(["canViewNotices", "canViewPayments"]);
  });

  it("names the no-permissions state instead of leaving four empty cards", () => {
    expect(sharesNothing(dashboard())).toBe(true);
    expect(sharesNothing(dashboard({ permissions: permissions({ canViewFood: true }) }))).toBe(
      false,
    );
  });
});

describe("guardianDueAmount", () => {
  /*
   * The distinction this whole module exists for. `payments: []` is what a
   * guardian without `canViewPayments` receives, so a total of 0 would state
   * that the ward owes nothing — which the app has no basis to say.
   */
  it("returns null when payments are not shared, never zero", () => {
    expect(guardianDueAmount(dashboard())).toBeNull();
  });

  it("prefers the server's summary — the number the hostel would quote", () => {
    const loaded = dashboard({
      payments: [payment({ dueAmount: 5000 })],
      permissions: permissions({ canViewPayments: true }),
      summary: { dueAmount: 4200, unpaidCount: 1 },
    });

    expect(guardianDueAmount(loaded)).toBe(4200);
  });

  it("falls back to summing the open rows when the summary is missing", () => {
    const loaded = dashboard({
      payments: [
        payment({ dueAmount: 5000, id: "a", paidAmount: 1000, status: "PARTIAL" }),
        payment({ dueAmount: 5000, id: "b", paidAmount: 5000, status: "PAID" }),
      ],
      permissions: permissions({ canViewPayments: true }),
      summary: null,
    });

    expect(guardianDueAmount(loaded)).toBe(4000);
  });

  it("is zero, not negative, on an overpaid month", () => {
    expect(guardianOutstanding(payment({ paidAmount: 6000, status: "PARTIAL" }))).toBe(0);
  });

  it("ignores months that are settled", () => {
    expect(guardianOutstanding(payment({ paidAmount: 5000, status: "PAID" }))).toBe(0);
  });
});

describe("receiptsByMonth", () => {
  it("joins receipts to dues on the billing month they share", () => {
    const map = receiptsByMonth([
      {
        amount: 5000,
        id: "rc-1",
        issuedOn: "2026-08-05",
        month: "2026-08",
        receiptNumber: "RCP-2026-08-00002",
      },
      {
        amount: 5000,
        id: "rc-2",
        issuedOn: "2026-07-05",
        month: "2026-07",
        receiptNumber: "RCP-2026-07-00001",
      },
    ]);

    expect(map.get("2026-08")?.receiptNumber).toBe("RCP-2026-08-00002");
    expect(map.get("2026-06")).toBeUndefined();
  });

  it("keeps the latest receipt for a month settled in instalments", () => {
    // Server order is newest first, so the first row for a month wins.
    const map = receiptsByMonth([
      {
        amount: 2000,
        id: "rc-late",
        issuedOn: "2026-08-20",
        month: "2026-08",
        receiptNumber: "RCP-2026-08-00009",
      },
      {
        amount: 3000,
        id: "rc-early",
        issuedOn: "2026-08-05",
        month: "2026-08",
        receiptNumber: "RCP-2026-08-00002",
      },
    ]);

    expect(map.get("2026-08")?.id).toBe("rc-late");
  });

  it("is empty when receipts were not shared, so a row shows a dash", () => {
    expect(receiptsByMonth([]).size).toBe(0);
  });
});

describe("guardianPaidAmount", () => {
  it("sums what has been paid across the shared invoices", () => {
    const total = guardianPaidAmount(
      dashboard({
        payments: [
          payment({ id: "a", paidAmount: 5000, status: "PAID" }),
          payment({ id: "b", paidAmount: 2000, status: "PARTIAL" }),
        ],
        permissions: { ...NO_GUARDIAN_PERMISSIONS, canViewPayments: true },
      }),
    );

    expect(total).toBe(7000);
  });

  it("counts a partial month, which a status filter would drop", () => {
    const total = guardianPaidAmount(
      dashboard({
        payments: [payment({ paidAmount: 2000, status: "PARTIAL" })],
        permissions: { ...NO_GUARDIAN_PERMISSIONS, canViewPayments: true },
      }),
    );

    expect(total).toBe(2000);
  });

  it("reports null rather than zero when payments are not shared", () => {
    // A confident "NPR 0 paid" at a guardian who was never granted finances
    // states something about the ward that this app has no basis for.
    expect(
      guardianPaidAmount(
        dashboard({
          payments: [payment({ paidAmount: 5000, status: "PAID" })],
          permissions: NO_GUARDIAN_PERMISSIONS,
        }),
      ),
    ).toBeNull();
  });

  it("survives a missing dashboard", () => {
    expect(guardianPaidAmount(null)).toBeNull();
  });
});

describe("guardianNextDue", () => {
  it("picks the oldest open month, not the newest", () => {
    // The server sends newest-first, so `payments[0]` would point a parent whose
    // child is two months behind at August while July ages into a default.
    const next = guardianNextDue([
      payment({ dueDate: "2026-08-05T00:00:00.000Z", id: "aug", month: "2026-08" }),
      payment({ dueDate: "2026-07-05T00:00:00.000Z", id: "jul", month: "2026-07" }),
    ]);

    expect(next?.id).toBe("jul");
  });

  it("ignores months with nothing outstanding", () => {
    const next = guardianNextDue([
      payment({ dueAmount: 5000, id: "settled", paidAmount: 5000, status: "PAID" }),
      payment({ dueDate: "2026-09-05T00:00:00.000Z", id: "open", month: "2026-09" }),
    ]);

    expect(next?.id).toBe("open");
  });

  it("sorts an undated invoice last rather than first", () => {
    // Absent is not urgent. Coercing it to epoch-zero would put it above every
    // real due date.
    const next = guardianNextDue([
      payment({ dueDate: undefined, id: "undated", month: "2026-06" }),
      payment({ dueDate: "2026-07-05T00:00:00.000Z", id: "jul", month: "2026-07" }),
    ]);

    expect(next?.id).toBe("jul");
  });

  it("returns null when nothing is open", () => {
    expect(
      guardianNextDue([payment({ paidAmount: 5000, status: "PAID" })]),
    ).toBeNull();
  });
});

describe("guardianLatestPaid", () => {
  it("orders by billing month, because the projection carries no payment date", () => {
    const latest = guardianLatestPaid([
      payment({ id: "jun", month: "2026-06", paidAmount: 5000, status: "PAID" }),
      payment({ id: "aug", month: "2026-08", paidAmount: 5000, status: "PAID" }),
      payment({ id: "jul", month: "2026-07", paidAmount: 5000, status: "PAID" }),
    ]);

    expect(latest?.id).toBe("aug");
  });

  it("counts a part-paid month", () => {
    // Real money has moved against a PARTIAL row, and a parent who paid half of
    // August should see August rather than the last fully-settled month.
    const latest = guardianLatestPaid([
      payment({ id: "jul", month: "2026-07", paidAmount: 5000, status: "PAID" }),
      payment({ id: "aug", month: "2026-08", paidAmount: 2000, status: "PARTIAL" }),
    ]);

    expect(latest?.id).toBe("aug");
  });

  it("returns null when nothing has been paid", () => {
    expect(guardianLatestPaid([payment()])).toBeNull();
  });

  it("survives a one-off invoice, which belongs to no month", () => {
    // The joining bill carries `period: null`, and it is the *first* invoice a
    // household ever settles — so a `.month.localeCompare` here threw for every
    // new resident before their first month of rent was raised.
    const latest = guardianLatestPaid([
      payment({ id: "joining", month: null, paidAmount: 12000, status: "PAID" }),
      payment({ id: "aug", month: "2026-08", paidAmount: 5000, status: "PAID" }),
    ]);

    expect(latest?.id).toBe("aug");
  });

  it("shows the joining bill when it is the only thing settled", () => {
    const latest = guardianLatestPaid([
      payment({ id: "joining", month: null, paidAmount: 12000, status: "PAID" }),
      payment({ id: "aug", month: "2026-08", paidAmount: 0, status: "UNPAID" }),
    ]);

    expect(latest?.id).toBe("joining");
  });
});
