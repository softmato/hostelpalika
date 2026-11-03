/**
 * Claim review — Block 2 item 2.8 of docs/FINANCE_IMPLEMENTATION_PLAN.md.
 *
 * §8.2: "`fee-management.test.ts` is the best-tested part of the current system
 * — port them all before deleting the file." These are those cases, moved onto
 * `claim.service` and `review.service`. Several of them changed character in the
 * move, and that is the point:
 *
 * - "does not credit the month twice when the claim on the proof is lost" and
 *   "credits on top of the fresh balance when another approval lands first"
 *   tested a five-attempt compare-and-set loop against a mutable `paidAmount`.
 *   There is no mutable balance any more, so what is left to test is that
 *   settlement is pinned to PENDING and that the balance is a sum.
 * - "continues the receipt sequence within a month" moved to `receipt.test.ts`,
 *   where the atomic counter lives.
 * - The billing cases moved to `billing.test.ts` with the fee schedule.
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiPrincipal } from "@/lib/api-auth";
import { Role } from "@/lib/roles";

const mocks = vi.hoisted(() => ({
  appendEvent: vi.fn(),
  assetFind: vi.fn(),
  assetFindOne: vi.fn(),
  balanceFindOne: vi.fn(),
  audit: vi.fn(),
  eventExists: vi.fn(),
  eventFind: vi.fn(),
  eventFindOne: vi.fn(),
  eventFindOneAndUpdate: vi.fn(),
  findCurrentResident: vi.fn(),
  hostelFindById: vi.fn(),
  invoiceFind: vi.fn(),
  invoiceFindById: vi.fn(),
  invoiceFindOne: vi.fn(),
  markReferralConverted: vi.fn(),
  notifyAdmins: vi.fn(),
  notifyReviewed: vi.fn(),
  profileFindOne: vi.fn(),
  publish: vi.fn(),
  residentFind: vi.fn(),
  settleEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/lib/realtime/server", () => ({ publishResourceChange: mocks.publish }));
vi.mock("@/modules/finance/audit-finance", () => ({ auditFinanceAction: mocks.audit }));

vi.mock("@/modules/finance/finance-notify", () => ({
  notifyAdminsOfClaim: mocks.notifyAdmins,
  notifyClaimReviewed: mocks.notifyReviewed,
  notifyResidentOfClaim: vi.fn(),
}));

vi.mock("@/modules/finance/payment-event.service", () => ({
  appendEvent: mocks.appendEvent,
  settleEvent: mocks.settleEvent,
}));

vi.mock("@/modules/referrals/referral.service", () => ({
  markReferralConverted: mocks.markReferralConverted,
}));

vi.mock("@/modules/residents/resident-access", () => ({
  findCurrentResident: mocks.findCurrentResident,
}));

vi.mock("@hostel/db/models/FileAsset", () => ({
  FileAssetModel: { find: mocks.assetFind, findOne: mocks.assetFindOne },
}));

// Item 3.4 measures a claim against what is still outstanding, so the balance
// is now read on the submit path.
vi.mock("@hostel/db/models/InvoiceBalance", () => ({
  InvoiceBalanceModel: { findOne: mocks.balanceFindOne },
}));

/** Read by the claim path's payee check — see `evidence-payee.ts`. */
vi.mock("@hostel/db/models/HostelPaymentProfile", () => ({
  HostelPaymentProfileModel: { findOne: mocks.profileFindOne },
}));

vi.mock("@hostel/db/models/Hostel", () => ({
  HostelModel: { findById: mocks.hostelFindById },
}));

vi.mock("@hostel/db/models/Invoice", () => ({
  InvoiceModel: {
    find: mocks.invoiceFind,
    findById: mocks.invoiceFindById,
    findOne: mocks.invoiceFindOne,
  },
}));

vi.mock("@hostel/db/models/PaymentEvent", () => ({
  PaymentEventModel: {
    exists: mocks.eventExists,
    find: mocks.eventFind,
    findOne: mocks.eventFindOne,
    findOneAndUpdate: mocks.eventFindOneAndUpdate,
  },
}));

vi.mock("@hostel/db/models/Resident", () => ({
  ResidentModel: { find: mocks.residentFind },
}));

import { submitClaim } from "@/modules/finance/claim.service";
import { approveClaim, rejectClaim } from "@/modules/finance/review.service";

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1");
const residentId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0c1");
const invoiceId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0d1");
const eventId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0e1");
const assetId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0f1");

const userId = "64f0f0f0f0f0f0f0f0f0f0b1";
const principal = {
  hostelIds: [hostelId.toString()],
  role: Role.HOSTEL_ADMIN,
  userId,
} as ApiPrincipal;

function chain<T>(value: T) {
  return {
    lean: vi.fn().mockResolvedValue(value),
    limit: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
  };
}

const claimInput = {
  amount: 5000,
  paymentMethod: "ESEWA" as const,
  proofImageAssetId: assetId.toString(),
  // Required for a wallet claim since gap fix 3: a claim with no reference can
  // never be reconciled against the provider's own statement.
  transactionCode: "8823119471",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.profileFindOne.mockReturnValue(
    chain({ displayName: "Sunrise Boys Hostel", esewaId: "9801234507" }),
  );
  mocks.hostelFindById.mockReturnValue(chain({ name: "Sunrise Boys Hostel" }));
  mocks.findCurrentResident.mockResolvedValue({ _id: residentId, hostelId });
  mocks.invoiceFindOne.mockReturnValue(
    chain({
      _id: invoiceId,
      hostelId,
      period: "2026-08",
      referenceCode: "RUP-0001-K",
      status: "OPEN",
      totalAmount: 12000,
    }),
  );
  mocks.assetFindOne.mockReturnValue(
    chain({
      _id: assetId,
      contentHash: "sha256-abc",
      hostelId,
      ownerId: { toString: () => userId },
      uploadCompletedAt: new Date(),
    }),
  );
  mocks.assetFind.mockReturnValue(chain([]));
  // The similarity pool and item E.8's rejected-id count both come through
  // `find`; neither has anything to say in this file's fixtures.
  mocks.eventFind.mockReturnValue(chain([]));
  mocks.balanceFindOne.mockReturnValue(chain(null));
  mocks.eventExists.mockResolvedValue(null);
  mocks.appendEvent.mockResolvedValue({
    created: true,
    event: { _id: eventId, status: "PENDING" },
  });
  // Filter-aware: the review path looks a claim up by id, while the submit path
  // uses the same method to ask whether this evidence or transaction id has been
  // seen before (§11.3). A blanket claim would make every submission in this
  // file read as a duplicate.
  mocks.eventFindOne.mockImplementation((filter: Record<string, unknown>) =>
    chain(
      // The third filter shape is the double-credit guard: "has a statement row
      // already settled this claim's money?". Nothing has, in the default fixture.
      "evidenceHash" in filter ||
        "rawPayload.transactionCode" in filter ||
        "rawPayload.claimEventId" in filter
        ? null
        : {
            _id: eventId,
            amount: 5000,
            confirmation: "UNCONFIRMED",
            hostelId,
            invoiceId,
            occurredAt: new Date(),
            residentId,
            status: "PENDING",
          },
    ),
  );
  mocks.settleEvent.mockResolvedValue({
    balance: { outstanding: 7000, settledAmount: 5000 },
    event: { _id: eventId, amount: 5000, residentId },
    receipt: { receiptNumber: "RCP-RUP-2026-08-00001" },
  });
  mocks.eventFindOneAndUpdate.mockReturnValue(chain({ _id: eventId }));
  mocks.audit.mockResolvedValue(undefined);
  mocks.notifyAdmins.mockResolvedValue(undefined);
  mocks.notifyReviewed.mockResolvedValue(undefined);
  mocks.markReferralConverted.mockResolvedValue(undefined);
  mocks.publish.mockResolvedValue(undefined);
});

describe("submitting a claim", () => {
  it("records an unconfirmed, pending event that credits nothing yet", async () => {
    // A claim is a statement, not a settlement. Modelling it as a PENDING event
    // means no balance has to remember to exclude it.
    const result = await submitClaim(invoiceId.toString(), claimInput, principal);

    expect(result.created).toBe(true);
    expect(mocks.appendEvent.mock.calls[0]![0]).toMatchObject({
      amount: 5000,
      confirmation: "UNCONFIRMED",
      source: "RESIDENT_CLAIM",
      status: "PENDING",
    });
  });

  it("keys on the stored content hash, so a double-tapped submit is one claim", async () => {
    await submitClaim(invoiceId.toString(), claimInput, principal);

    expect(mocks.appendEvent.mock.calls[0]![0].idempotencyKey).toBe(
      `claim:${residentId.toString()}:${invoiceId.toString()}:sha256-abc`,
    );
  });

  it("does not re-notify the admins on a replayed submit", async () => {
    mocks.appendEvent.mockResolvedValue({
      created: false,
      event: { _id: eventId, status: "PENDING" },
    });

    const result = await submitClaim(invoiceId.toString(), claimInput, principal);

    expect(result.created).toBe(false);
    expect(mocks.notifyAdmins).not.toHaveBeenCalled();
  });

  it("keeps the resident-typed transaction code out of the indexed field", async () => {
    // It is unverified and not unique: indexing it lets one resident's typo
    // block another resident's claim on a uniqueness collision.
    await submitClaim(
      invoiceId.toString(),
      { ...claimInput, transactionCode: "TXN-8823119" },
      principal,
    );

    const appended = mocks.appendEvent.mock.calls[0]![0];

    expect(appended.providerTxnId).toBeUndefined();
    // Stored exactly as typed, hyphen and all — canonicalisation is for
    // comparing, never for rewriting what the resident said.
    expect(appended.rawPayload.transactionCode).toBe("TXN-8823119");
  });

  it("refuses evidence owned by somebody else", async () => {
    // Item 0.2. A missing asset and someone else's asset answer identically, so
    // a resident probing ids learns nothing.
    mocks.assetFindOne.mockReturnValue(
      chain({
        _id: assetId,
        hostelId,
        ownerId: { toString: () => "someone-else" },
        uploadCompletedAt: new Date(),
      }),
    );

    await expect(
      submitClaim(invoiceId.toString(), claimInput, principal),
    ).rejects.toMatchObject({ errorCode: "ASSET_NOT_OWNED" });
  });

  it("refuses evidence from another hostel", async () => {
    mocks.assetFindOne.mockReturnValue(
      chain({
        _id: assetId,
        hostelId: new Types.ObjectId(),
        ownerId: { toString: () => userId },
        uploadCompletedAt: new Date(),
      }),
    );

    await expect(
      submitClaim(invoiceId.toString(), claimInput, principal),
    ).rejects.toMatchObject({ errorCode: "ASSET_NOT_OWNED" });
  });

  it("refuses an upload that never completed", async () => {
    // Item 0.3: until the bytes are confirmed the row is a reservation, and its
    // type and size are the client's own claim.
    mocks.assetFindOne.mockReturnValue(
      chain({ _id: assetId, hostelId, ownerId: { toString: () => userId } }),
    );

    await expect(
      submitClaim(invoiceId.toString(), claimInput, principal),
    ).rejects.toMatchObject({ errorCode: "ASSET_UPLOAD_INCOMPLETE" });
  });

  it("refuses a screenshot already used in this hostel", async () => {
    mocks.eventExists.mockResolvedValue({ _id: new Types.ObjectId() });

    await expect(
      submitClaim(invoiceId.toString(), claimInput, principal),
    ).rejects.toMatchObject({ errorCode: "EVIDENCE_ALREADY_USED" });
  });

  it("refuses a claim against an invoice that is already paid", async () => {
    mocks.invoiceFindOne.mockReturnValue(
      chain({ _id: invoiceId, hostelId, status: "PAID", totalAmount: 12000 }),
    );

    await expect(
      submitClaim(invoiceId.toString(), claimInput, principal),
    ).rejects.toMatchObject({ errorCode: "INVOICE_ALREADY_PAID" });
  });

  it("cannot reach another resident's invoice", async () => {
    await submitClaim(invoiceId.toString(), claimInput, principal);

    // Scoped in the query itself, so an out-of-scope id reads as missing.
    expect(mocks.invoiceFindOne.mock.calls[0]![0]).toMatchObject({
      hostelId,
      residentId,
    });
  });
});

/**
 * One transfer, two screens, one credit.
 *
 * The reconcile screen settles the statement row; this queue settles the claim.
 * They are the same money whenever a claim named that transaction, and nothing
 * connected the two actions — so a hostel that used both features credited one
 * month's rent twice, against one invoice, with every row on screen looking
 * correct.
 */
describe("a claim the statement import already credited", () => {
  beforeEach(() => {
    mocks.eventFindOne.mockImplementation((filter: Record<string, unknown>) =>
      chain(
        "rawPayload.claimEventId" in filter
          ? { _id: new Types.ObjectId() }
          : "evidenceHash" in filter || "rawPayload.transactionCode" in filter
            ? null
            : {
                _id: eventId,
                amount: 5000,
                confirmation: "UNCONFIRMED",
                hostelId,
                invoiceId,
                occurredAt: new Date(),
                residentId,
                status: "PENDING",
              },
      ),
    );
  });

  it("refuses to settle it a second time", async () => {
    await expect(approveClaim(eventId.toString(), principal)).rejects.toMatchObject({
      errorCode: "CLAIM_ALREADY_REVIEWED",
    });

    expect(mocks.settleEvent).not.toHaveBeenCalled();
  });

  // The owner pressed approve on money that really did arrive, so the sentence
  // says where it was recorded rather than implying the claim was wrong.
  it("says the money is credited, not that the claim was bad", async () => {
    await expect(approveClaim(eventId.toString(), principal)).rejects.toThrow(
      /already recorded from your account statement/i,
    );
  });

  it("looks for the link on the statement event, scoped to the hostel", async () => {
    await approveClaim(eventId.toString(), principal).catch(() => {});

    const call = mocks.eventFindOne.mock.calls.find(
      ([filter]) => "rawPayload.claimEventId" in filter,
    );

    expect(call?.[0]).toMatchObject({
      hostelId,
      source: "STATEMENT_IMPORT",
      status: "SETTLED",
    });
  });
});

describe("approving a claim", () => {
  it("settles it and returns the receipt", async () => {
    const result = await approveClaim(eventId.toString(), principal);

    expect(result.receiptNumber).toBe("RCP-RUP-2026-08-00001");
    expect(result.settledAmount).toBe(5000);
  });

  it("leaves the invoice short when the claim covers part of it", async () => {
    // Ported: "leaves a month PARTIAL when the verified amount is short". It is
    // now arithmetic rather than a clamp — 5,000 settled against 12,000 due.
    const result = await approveClaim(eventId.toString(), principal);

    expect(result.settledAmount).toBeLessThan(12000);
    expect(mocks.notifyReviewed.mock.calls[0]![0].outcome).toMatchObject({
      remainingAmount: 7000,
    });
  });

  it("settles the invoice once the running total covers it", async () => {
    // Ported: "settles the month once the running total covers the due amount".
    mocks.settleEvent.mockResolvedValue({
      balance: { outstanding: 0, settledAmount: 12000 },
      event: { _id: eventId, amount: 7000, residentId },
      receipt: { receiptNumber: "RCP-RUP-2026-08-00002" },
    });

    await approveClaim(eventId.toString(), principal);

    expect(mocks.notifyReviewed.mock.calls[0]![0].outcome).toMatchObject({
      remainingAmount: 0,
    });
  });

  it("refuses to approve a claim that was already reviewed", async () => {
    // Ported: "refuses to approve a proof that was already approved".
    mocks.eventFindOne.mockReturnValue(
      chain({ _id: eventId, amount: 5000, hostelId, invoiceId, status: "SETTLED" }),
    );

    await expect(approveClaim(eventId.toString(), principal)).rejects.toMatchObject({
      errorCode: "CLAIM_ALREADY_REVIEWED",
    });
    expect(mocks.settleEvent).not.toHaveBeenCalled();
  });

  it("cannot credit the same claim twice", async () => {
    // Ported: "does not credit the month twice when the claim on the proof is
    // lost". The five-attempt CAS loop is gone — settlement is pinned to the
    // event still being PENDING, and the balance is a sum of settled events, so
    // there is no mutable number left for a lost update to corrupt.
    await approveClaim(eventId.toString(), principal);

    expect(mocks.settleEvent).toHaveBeenCalledTimes(1);
    expect(mocks.settleEvent.mock.calls[0]![0]).toEqual(eventId);
  });

  it("converts the referral only once real money is verified", async () => {
    await approveClaim(eventId.toString(), principal);

    expect(mocks.markReferralConverted).toHaveBeenCalledWith(
      expect.objectContaining({ hostelId, residentId }),
    );
  });

  it("tells the resident and refreshes every payments panel", async () => {
    await approveClaim(eventId.toString(), principal);

    expect(mocks.notifyReviewed).toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalled();
  });

  it("cannot reach a claim outside the caller's hostels", async () => {
    await approveClaim(eventId.toString(), principal);

    expect(mocks.eventFindOne.mock.calls[0]![0]).toMatchObject({
      hostelId: { $in: [hostelId.toString()] },
      source: { $in: ["RESIDENT_CLAIM", "CASH_ENTRY"] },
    });
  });
});

describe("rejecting a claim", () => {
  it("marks it rejected and tells the resident why", async () => {
    const result = await rejectClaim(eventId.toString(), "Unreadable proof", principal);

    expect(result.status).toBe("REJECTED");
    expect(mocks.notifyReviewed.mock.calls[0]![0].outcome).toMatchObject({
      kind: "rejected",
      rejectionReason: "Unreadable proof",
    });
  });

  it("refuses to reject a claim that was already reviewed", async () => {
    // Ported: "refuses to reject a proof that was already reviewed". The filter
    // is pinned to PENDING, so whoever gets there first decides and the loser is
    // told rather than silently overwriting the decision.
    mocks.eventFindOneAndUpdate.mockReturnValue(chain(null));

    await expect(
      rejectClaim(eventId.toString(), "Unreadable proof", principal),
    ).rejects.toMatchObject({ errorCode: "CLAIM_ALREADY_REVIEWED" });
  });

  it("claims the event with a PENDING-pinned filter", async () => {
    await rejectClaim(eventId.toString(), "Unreadable proof", principal);

    expect(mocks.eventFindOneAndUpdate.mock.calls[0]![0]).toMatchObject({
      status: "PENDING",
    });
  });

  it("audits the rejection with its reason", async () => {
    await rejectClaim(eventId.toString(), "Unreadable proof", principal);

    expect(mocks.audit).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({
        action: "PAYMENT_CLAIM_REJECTED",
        reason: "Unreadable proof",
      }),
    );
  });
});
