/**
 * The three buckets — Block 4 item 4.3 of docs/FINANCE_IMPLEMENTATION_PLAN.md
 * (target §11.5).
 *
 * The screen's claim is "forty-one residents, three decisions". That only holds
 * if the sorting into buckets is right, so what is asserted here is which row
 * lands where — and, for the two actions that move money, that they cannot be
 * aimed at somebody else's data.
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiPrincipal } from "@/lib/api-auth";
import { Role } from "@/lib/roles";

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1");
const importId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0c1");
const invoiceId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0d1");
const residentId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0e1");

const mocks = vi.hoisted(() => ({
  eventFind: vi.fn(),
  eventFindOne: vi.fn(),
  eventUpdateOne: vi.fn(),
  importFindOne: vi.fn(),
  invoiceFind: vi.fn(),
  invoiceFindOne: vi.fn(),
  loadMatchContext: vi.fn(),
  residentFind: vi.fn(),
  settleEvent: vi.fn(),
  userFind: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/lib/transaction", () => ({ inTransaction: (fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/realtime/server", () => ({ publishResourceChange: vi.fn() }));
vi.mock("@/modules/finance/audit-finance", () => ({ auditFinanceAction: vi.fn() }));
vi.mock("@/modules/notifications/notification.service", () => ({
  createInAppNotification: vi.fn(),
}));
vi.mock("@/modules/finance/payment-event.service", () => ({
  settleEvent: mocks.settleEvent,
}));
vi.mock("@/modules/finance/matching/ladder.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/finance/matching/ladder.service")>()),
  loadMatchContext: mocks.loadMatchContext,
}));

vi.mock("@hostel/db/models/Invoice", () => ({
  InvoiceModel: { find: mocks.invoiceFind, findOne: mocks.invoiceFindOne },
}));
vi.mock("@hostel/db/models/PaymentEvent", () => ({
  PaymentEventModel: {
    find: mocks.eventFind,
    findOne: mocks.eventFindOne,
    updateOne: mocks.eventUpdateOne,
  },
}));
vi.mock("@hostel/db/models/Resident", () => ({
  ResidentModel: { find: mocks.residentFind },
}));
vi.mock("@hostel/db/models/StatementImport", () => ({
  StatementImportModel: { findOne: mocks.importFindOne },
}));
vi.mock("@hostel/db/models/User", () => ({
  UserModel: { find: mocks.userFind },
}));

import {
  approveMatchedRows,
  assignOrphanCredit,
  getReconciliation,
} from "@/modules/finance/statements/reconcile.service";

const principal = {
  hostelIds: [hostelId.toString()],
  role: Role.HOSTEL_ADMIN,
  userId: "64f0f0f0f0f0f0f0f0f0f0b1",
} as ApiPrincipal;

function chain<T>(value: T) {
  return {
    lean: vi.fn().mockResolvedValue(value),
    limit: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
  };
}

const settledTierB = {
  _id: new Types.ObjectId(),
  amount: 8000,
  confirmation: "STATEMENT_MATCH",
  invoiceId,
  occurredAt: new Date(2026, 7, 2),
  providerTxnId: "ESW001",
  rawPayload: { ladderTier: "B", ladderWhy: "reference RUP-4821-P" },
  referenceCode: "RUP-4821-P",
  residentId,
  status: "SETTLED",
};

const orphanTierD = {
  _id: new Types.ObjectId(),
  amount: 8000,
  confirmation: "UNCONFIRMED",
  invoiceId: null,
  occurredAt: new Date(2026, 7, 12),
  providerTxnId: "ESW003",
  rawPayload: {
    counterpartyName: "S. TAMANG",
    ladderTier: "D",
    ladderWhy: "no reference, no claim, no close match",
    remarks: null,
    suggestions: [],
  },
  residentId: null,
  status: "PENDING",
};

const claimConfirmed = {
  _id: new Types.ObjectId(),
  amount: 12000,
  confirmation: "UNCONFIRMED",
  invoiceId,
  occurredAt: new Date(2026, 7, 6),
  providerTxnId: "ESW002",
  rawPayload: {
    claimEventId: "evt-claim",
    ladderTier: "C",
    ladderWhy: "Bishal Rai claimed this exact transaction",
  },
  residentId,
  status: "PENDING",
};

/** Claims a warden has already approved, by the time the view is read. */
let settledClaims: { _id: string }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  settledClaims = [];

  mocks.importFindOne.mockReturnValue(
    chain({
      _id: importId,
      fileName: "esewa_august.csv",
      hostelId,
      parserVersion: "esewa-csv@1",
      periodEnd: new Date(2026, 7, 14),
      periodStart: new Date(2026, 7, 1),
      provider: "ESEWA",
      rowCount: 3,
      status: "READY",
      uploadedAt: new Date(2026, 7, 15),
    }),
  );
  // Filter-aware: the view reads this import's events, and separately asks which
  // of the linked claims a human has already settled. A blanket answer would make
  // the second question return statement rows.
  mocks.eventFind.mockImplementation((filter: Record<string, unknown>) =>
    chain(
      filter?.status === "SETTLED"
        ? settledClaims
        : [settledTierB, claimConfirmed, orphanTierD],
    ),
  );
  mocks.residentFind.mockReturnValue(
    chain([{ _id: residentId, firstName: "Bikash", lastName: "Thapa" }]),
  );
  mocks.invoiceFind.mockReturnValue(chain([{ _id: invoiceId, period: "2026-08" }]));
  mocks.userFind.mockReturnValue(chain([]));
  mocks.loadMatchContext.mockResolvedValue({
    claims: [],
    claimsByTxnId: new Map(),
    invoicesByCode: new Map(),
    openInvoices: [],
  });
});

describe("bucketing", () => {
  it("puts a reference-matched row in `matched`, already settled", async () => {
    const view = await getReconciliation(importId.toString(), principal.hostelIds);

    const row = view.buckets.matched.find((one) => one.referenceCode === "RUP-4821-P");

    expect(row?.status).toBe("SETTLED");
    expect(row?.residentName).toBe("Bikash Thapa");
    expect(row?.period).toBe("2026-08");
  });

  it("puts a claim-confirmed row in `matched`, still awaiting the tap", async () => {
    const view = await getReconciliation(importId.toString(), principal.hostelIds);

    const row = view.buckets.matched.find((one) => one.claimEventId === "evt-claim");

    expect(row?.status).toBe("PENDING");
  });

  it("totals the matched bucket, which is the number the owner believes", async () => {
    const view = await getReconciliation(importId.toString(), principal.hostelIds);

    expect(view.matchedTotal).toBe(20000);
  });

  it("puts unclaimed money in `orphans` with its remark intact", async () => {
    const view = await getReconciliation(importId.toString(), principal.hostelIds);

    expect(view.buckets.orphans).toHaveLength(1);
    expect(view.buckets.orphans[0]?.counterpartyName).toBe("S. TAMANG");
  });

  it("recomputes Tier E from the current claims, not a frozen list", async () => {
    mocks.loadMatchContext.mockResolvedValue({
      claims: [
        {
          amount: 12000,
          eventId: "evt-orphan-claim",
          invoiceId: null,
          occurredAt: new Date(2026, 7, 3),
          period: "2026-08",
          residentId: "res-x",
          residentName: "Bishal Rai",
          settled: false,
          submittedAt: new Date(2026, 7, 3),
          transactionCode: "9910233",
        },
      ],
      claimsByTxnId: new Map(),
      invoicesByCode: new Map(),
      openInvoices: [],
    });

    const view = await getReconciliation(importId.toString(), principal.hostelIds);

    expect(view.buckets.claimedNoTransaction).toHaveLength(1);
    expect(view.buckets.claimedNoTransaction[0]?.residentName).toBe("Bishal Rai");
  });

  /**
   * Item E.6. An approved claim with no credit behind it is the bucket that
   * catches a forged screenshot, and it is a different decision from an
   * unapproved one — the hostel has already told this resident the money landed.
   */
  it("separates an approved claim with no credit from an undecided one", async () => {
    mocks.loadMatchContext.mockResolvedValue({
      claims: [
        {
          amount: 12000,
          eventId: "evt-approved-claim",
          invoiceId: null,
          occurredAt: new Date(2026, 7, 3),
          period: "2026-08",
          residentId: "res-x",
          residentName: "Bishal Rai",
          settled: true,
          submittedAt: new Date(2026, 7, 3),
          transactionCode: "9910233",
        },
      ],
      claimsByTxnId: new Map(),
      invoicesByCode: new Map(),
      openInvoices: [],
    });

    const view = await getReconciliation(importId.toString(), principal.hostelIds);

    expect(view.buckets.claimedNoTransaction).toHaveLength(0);
    expect(view.buckets.approvedNotInStatement).toHaveLength(1);
    expect(view.buckets.approvedNotInStatement[0]?.residentName).toBe("Bishal Rai");
  });

  it("answers 404 for an import belonging to another hostel", async () => {
    mocks.importFindOne.mockReturnValue(chain(null));

    await expect(
      getReconciliation(importId.toString(), principal.hostelIds),
    ).rejects.toMatchObject({ errorCode: "STATEMENT_NOT_FOUND" });
  });

  it("refuses to show buckets for an import that failed to parse", async () => {
    mocks.importFindOne.mockReturnValue(
      chain({ _id: importId, hostelId, parserVersion: "x", provider: "ESEWA", status: "FAILED", uploadedAt: new Date() }),
    );

    await expect(
      getReconciliation(importId.toString(), principal.hostelIds),
    ).rejects.toMatchObject({ errorCode: "STATEMENT_NOT_READY" });
  });
});

describe("assigning orphan money", () => {
  beforeEach(() => {
    mocks.eventFindOne.mockReturnValue(chain({ ...orphanTierD, hostelId }));
    mocks.invoiceFindOne.mockReturnValue(chain({ _id: invoiceId, residentId }));
    mocks.eventUpdateOne.mockResolvedValue({});
    mocks.settleEvent.mockResolvedValue({ balance: { settledAmount: 8000 } });
  });

  it("points the event at the invoice before settling it", async () => {
    await assignOrphanCredit(orphanTierD._id.toString(), {
      invoiceId: invoiceId.toString(),
      principal,
    });

    // Order matters: `settleEvent` recomputes the balance of whatever invoice
    // the event points at, so a settle-then-point sequence would recompute the
    // wrong one — or none.
    expect(mocks.eventUpdateOne).toHaveBeenCalledBefore(mocks.settleEvent);
  });

  it("records a human decision, never a statement match", async () => {
    await assignOrphanCredit(orphanTierD._id.toString(), {
      invoiceId: invoiceId.toString(),
      principal,
    });

    expect(mocks.settleEvent.mock.calls[0]?.[1].confirmation).toBe("MANUAL_REVIEW");
  });

  it("refuses an event that is not pending", async () => {
    mocks.eventFindOne.mockReturnValue(
      chain({ ...orphanTierD, hostelId, status: "SETTLED" }),
    );

    await expect(
      assignOrphanCredit(orphanTierD._id.toString(), {
        invoiceId: invoiceId.toString(),
        principal,
      }),
    ).rejects.toMatchObject({ errorCode: "EVENT_ALREADY_ASSIGNED" });
  });

  it("refuses an invoice from a different hostel", async () => {
    mocks.invoiceFindOne.mockReturnValue(chain(null));

    await expect(
      assignOrphanCredit(orphanTierD._id.toString(), {
        invoiceId: invoiceId.toString(),
        principal,
      }),
    ).rejects.toMatchObject({ errorCode: "INVOICE_NOT_FOUND" });
    expect(mocks.settleEvent).not.toHaveBeenCalled();
  });
});

/**
 * One transfer, two screens, one credit.
 *
 * A resident's claim and the statement row naming the same transaction are the
 * same money, and the product has an action for each — `Approve` in the review
 * queue and `Approve matched` here. Nothing linked them, so doing both credited
 * one month's rent twice against one invoice, on different days, by people
 * neither of whom did anything odd. Both rows are real, so the result reads as
 * two correct entries.
 */
describe("a claim that was approved after the statement was uploaded", () => {
  beforeEach(() => {
    settledClaims = [{ _id: "evt-claim" }];
  });

  it("shows the row as confirming rather than as one tap away", async () => {
    const view = await getReconciliation(importId.toString(), principal.hostelIds);
    const row = view.buckets.matched.find((one) => one.claimEventId === "evt-claim");

    expect(row?.confirmsClaim).toBe(true);
  });

  it("does not settle it a second time in the sweep", async () => {
    const result = await approveMatchedRows(importId.toString(), principal);

    expect(mocks.settleEvent).not.toHaveBeenCalled();
    expect(result.approved).toBe(0);
  });

  // The claim was rejected, not settled: the reviewer turned down the resident's
  // *evidence*, and the transfer in the statement is still the credit.
  it("still settles the row when the claim was rejected instead", async () => {
    settledClaims = [];

    const result = await approveMatchedRows(importId.toString(), principal);

    expect(result.approved).toBe(1);
  });
});
