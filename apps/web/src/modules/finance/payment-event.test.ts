/**
 * The money writer — Block 2 item 2.2 of docs/FINANCE_IMPLEMENTATION_PLAN.md
 * (ADR-2, ADR-4, target §9.3).
 *
 * The invariants of plan §8.1 that this module is responsible for:
 * conservation (1), immutability (2), no money destroyed (3), and idempotency
 * (4). Each has tests below rather than being left to the drift job to notice
 * in production.
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";

const mocks = vi.hoisted(() => ({
  auditCreate: vi.fn(),
  auditFindOne: vi.fn(),
  balanceFindOneAndUpdate: vi.fn(),
  connectToDatabase: vi.fn(),
  creditOverpayment: vi.fn(),
  eventCreate: vi.fn(),
  eventFind: vi.fn(),
  eventFindOne: vi.fn(),
  eventFindOneAndUpdate: vi.fn(),
  eventUpdateOne: vi.fn(),
  invoiceFindOne: vi.fn(),
  invoiceUpdateOne: vi.fn(),
  issueReceipt: vi.fn(),
  notifyReversed: vi.fn(),
  receiptFindOne: vi.fn(),
  voidReceipt: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: mocks.connectToDatabase }));
vi.mock("@/modules/finance/credit-balance.service", () => ({
  creditOverpayment: mocks.creditOverpayment,
}));

vi.mock("@hostel/db/models/AuditLog", () => ({
  AuditLogModel: { create: mocks.auditCreate, findOne: mocks.auditFindOne },
}));

vi.mock("@hostel/db/models/PaymentEvent", () => ({
  PaymentEventModel: {
    create: mocks.eventCreate,
    find: mocks.eventFind,
    findOne: mocks.eventFindOne,
    findOneAndUpdate: mocks.eventFindOneAndUpdate,
    updateOne: mocks.eventUpdateOne,
  },
}));

vi.mock("@hostel/db/models/Invoice", () => ({
  InvoiceModel: { findOne: mocks.invoiceFindOne, updateOne: mocks.invoiceUpdateOne },
}));

vi.mock("@hostel/db/models/InvoiceBalance", () => ({
  InvoiceBalanceModel: { findOneAndUpdate: mocks.balanceFindOneAndUpdate },
}));

// Added in 2.6/2.7: settling issues a receipt, and reversing voids one and tells
// the resident. Both are stubbed here — they have their own suites, and this one
// is about the ledger writer.
vi.mock("@hostel/db/models/Receipt", () => ({
  ReceiptModel: { findOne: mocks.receiptFindOne },
}));

vi.mock("@/modules/finance/receipt.service", () => ({
  issueReceiptForEvent: mocks.issueReceipt,
  voidReceipt: mocks.voidReceipt,
}));

vi.mock("@/modules/finance/finance-notify", () => ({
  notifyAdminsOfStaffSettlement: vi.fn(),
  notifyPaymentReversed: mocks.notifyReversed,
}));

import {
  appendEvent,
  deriveInvoiceStatus,
  recomputeInvoiceBalance,
  reverseEvent,
  settleEvent,
} from "@/modules/finance/payment-event.service";

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1");
const invoiceId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0b1");
const residentId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0c1");
const eventId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0d1");

const principal = {
  hostelIds: [hostelId.toString()],
  role: Role.HOSTEL_ADMIN,
  sessionId: "session-1",
  userId: "64f0f0f0f0f0f0f0f0f0f0a4",
};

function leanResult<T>(value: T) {
  // `select` included because `reverseEvent` reads the invoice's period through
  // it; a bare `lean` object made every reversal test hang on `undefined.lean`.
  return { lean: vi.fn().mockResolvedValue(value), select: vi.fn().mockReturnThis() };
}

function chainResult<T>(value: T) {
  return {
    lean: vi.fn().mockResolvedValue(value),
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
  };
}

function duplicateKeyError(indexName: string) {
  return Object.assign(new Error(`E11000 duplicate key error: ${indexName}`), {
    code: 11000,
  });
}

const claim = {
  amount: 12000,
  hostelId,
  idempotencyKey: "claim:r1:i1:hash",
  invoiceId,
  residentId,
  source: "RESIDENT_CLAIM",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auditFindOne.mockReturnValue(chainResult(null));
  mocks.auditCreate.mockResolvedValue({});
  mocks.eventCreate.mockImplementation(async (doc: Record<string, unknown>) => ({
    ...doc,
    _id: eventId,
  }));
  mocks.eventFind.mockReturnValue(leanResult([]));
  mocks.eventUpdateOne.mockResolvedValue({});
  mocks.balanceFindOneAndUpdate.mockResolvedValue({});
  mocks.invoiceUpdateOne.mockResolvedValue({});
  mocks.issueReceipt.mockResolvedValue({ receiptNumber: "RCP-RUP-2026-08-00001" });
  mocks.receiptFindOne.mockReturnValue(leanResult(null));
  mocks.voidReceipt.mockResolvedValue({ receipt: {}, replacement: null });
  mocks.notifyReversed.mockResolvedValue(undefined);
  mocks.invoiceFindOne.mockReturnValue(
    leanResult({
      _id: invoiceId,
      dueDate: new Date("2099-01-01T00:00:00.000Z"),
      hostelId,
      residentId,
      status: "OPEN",
      totalAmount: 12000,
    }),
  );
});

describe("appendEvent", () => {
  it("records the event and reports it as newly created", async () => {
    const result = await appendEvent(claim);

    expect(result.created).toBe(true);
    expect(mocks.eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 12000, status: "PENDING" }),
    );
  });

  /**
   * Invariant 4. A retried webhook, a re-uploaded overlapping statement and a
   * double-tapped submit all carry the same deterministic key, so the unique
   * index turns the second one into a read — no second event, no double credit,
   * and no read-then-write race in the caller.
   */
  it("replays a duplicate idempotency key as a no-op", async () => {
    const existing = { ...claim, _id: eventId, status: "SETTLED" };
    mocks.eventCreate.mockRejectedValue(duplicateKeyError("idempotencyKey_1"));
    mocks.eventFindOne.mockReturnValue(leanResult(existing));

    const result = await appendEvent(claim);

    expect(result.created).toBe(false);
    expect(result.event).toMatchObject({ _id: eventId });
  });

  // A txn-id collision is not a replay — it is the same money being claimed
  // twice, which is a fraud control firing and must reach the caller.
  it("raises TXN_ID_ALREADY_USED on a reused transaction id", async () => {
    mocks.eventCreate.mockRejectedValue(
      duplicateKeyError("hostelId_1_provider_1_providerTxnId_1"),
    );

    await expect(appendEvent({ ...claim, providerTxnId: "T1" })).rejects.toMatchObject({
      errorCode: "TXN_ID_ALREADY_USED",
      status: 409,
    });
  });

  it("raises EVIDENCE_ALREADY_USED on a reused screenshot", async () => {
    mocks.eventCreate.mockRejectedValue(duplicateKeyError("hostelId_1_evidenceHash_1"));

    await expect(appendEvent({ ...claim, evidenceHash: "sha" })).rejects.toMatchObject({
      errorCode: "EVIDENCE_ALREADY_USED",
      status: 409,
    });
  });

  it("refuses a fractional amount before it can reach the ledger", async () => {
    await expect(appendEvent({ ...claim, amount: 12000.5 })).rejects.toThrow(
      /whole number of rupees/,
    );
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });

  it("keeps the raw payload verbatim", async () => {
    await appendEvent({ ...claim, rawPayload: { remarks: "aug rent" } });

    expect(mocks.eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({ rawPayload: { remarks: "aug rent" } }),
    );
  });

  // Money that arrived with no known owner is a normal state, not an error
  // (P5, target §7 Tier D).
  it("accepts an event with no invoice and no resident", async () => {
    await appendEvent({ ...claim, invoiceId: null, residentId: null });

    expect(mocks.eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: null, residentId: null }),
    );
  });
});

describe("settleEvent", () => {
  beforeEach(() => {
    mocks.eventFindOneAndUpdate.mockReturnValue(
      leanResult({
        _id: eventId,
        amount: 12000,
        direction: "CREDIT",
        hostelId,
        invoiceId,
        status: "SETTLED",
      }),
    );
    mocks.eventFind.mockReturnValue(
      leanResult([{ _id: eventId, amount: 12000, direction: "CREDIT" }]),
    );
  });

  /**
   * The claim is filtered on `status: "PENDING"`, which does double duty: it is
   * the double-approval guard, and it is what satisfies the immutability rule —
   * the filter cannot match an already-settled event, so this path can never
   * rewrite one.
   */
  it("claims the event by pinning the filter to PENDING", async () => {
    await settleEvent(eventId, { confirmation: "MANUAL_REVIEW", principal });

    expect(mocks.eventFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: eventId, status: "PENDING" }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: "SETTLED" }),
      }),
      expect.anything(),
    );
  });

  it("refuses to settle an event that is no longer pending", async () => {
    mocks.eventFindOneAndUpdate.mockReturnValue(leanResult(null));

    await expect(
      settleEvent(eventId, { confirmation: "MANUAL_REVIEW" }),
    ).rejects.toMatchObject({ errorCode: "SETTLED_EVENT_IMMUTABLE" });
  });

  it("recomputes the invoice balance after settling", async () => {
    const { balance } = await settleEvent(eventId, {
      confirmation: "MANUAL_REVIEW",
      principal,
    });

    expect(balance?.settledAmount).toBe(12000);
    expect(balance?.status).toBe("PAID");
  });

  it("audits the settlement with the balance either side", async () => {
    await settleEvent(eventId, { confirmation: "MANUAL_REVIEW", principal });

    const entry = mocks.auditCreate.mock.calls[0][0];

    expect(entry.action).toBe("PAYMENT_EVENT_SETTLED");
    expect(entry.metadata).toMatchObject({ amountAfter: 12000, amountBefore: 0 });
  });

  /**
   * Target §9.4. The clamp this replaces — `Math.min(paid + verified, dueAmount)`
   * — made 15,000 against a 12,000 invoice indistinguishable from a 12,000
   * payment, with nothing anywhere recording that 3,000 had arrived.
   */
  it("settles an overpayment in full and turns the excess into credit", async () => {
    mocks.eventFindOneAndUpdate.mockReturnValue(
      leanResult({
        _id: eventId,
        amount: 15000,
        direction: "CREDIT",
        hostelId,
        invoiceId,
        residentId,
        status: "SETTLED",
      }),
    );
    mocks.eventFind.mockReturnValue(
      leanResult([{ _id: eventId, amount: 15000, direction: "CREDIT" }]),
    );

    const { balance } = await settleEvent(eventId, {
      confirmation: "MANUAL_REVIEW",
      principal,
    });

    expect(balance?.status).toBe("PAID");
    expect(balance?.outstanding).toBe(0);
    expect(mocks.creditOverpayment).toHaveBeenCalledWith(
      expect.objectContaining({ excess: 3000 }),
    );
  });

  it("does not credit anything when the payment exactly covers the invoice", async () => {
    await settleEvent(eventId, { confirmation: "MANUAL_REVIEW", principal });

    expect(mocks.creditOverpayment).not.toHaveBeenCalled();
  });

  it("settles orphan money that has no invoice to recompute", async () => {
    mocks.eventFindOneAndUpdate.mockReturnValue(
      leanResult({
        _id: eventId,
        amount: 8000,
        hostelId,
        invoiceId: null,
        status: "SETTLED",
      }),
    );

    const { balance } = await settleEvent(eventId, { confirmation: "MANUAL_REVIEW" });

    expect(balance).toBeNull();
  });
});

/**
 * The settled set as the database would return it after `reverseEvent`'s writes.
 *
 * The update that carries `reversedByEventId` is the one aimed at the original —
 * identified by its payload because the create mock hands every event the same
 * id. If that update also demotes `status`, the original is no longer `SETTLED`
 * and drops out of the balance sum, leaving only the DEBIT.
 */
function settledEventsAfterWrites() {
  const originalUpdate = mocks.eventUpdateOne.mock.calls.find(
    (call) => "reversedByEventId" in (call[1]?.$set ?? {}),
  );
  const originalStatus = originalUpdate?.[1].$set.status ?? "SETTLED";
  const debit = { _id: new Types.ObjectId(), amount: 12000, direction: "DEBIT" };

  return originalStatus === "SETTLED"
    ? [{ _id: eventId, amount: 12000, direction: "CREDIT" }, debit]
    : [debit];
}

describe("reverseEvent", () => {
  beforeEach(() => {
    mocks.eventFindOne.mockReturnValue(
      leanResult({
        _id: eventId,
        amount: 12000,
        direction: "CREDIT",
        hostelId,
        invoiceId,
        residentId,
        status: "SETTLED",
      }),
    );
    // Derived from what the service actually wrote, not hand-written.
    //
    // A fixture that simply lists both events describes a world the service may
    // have just contradicted, and that is exactly how the reversal
    // double-subtraction survived a green suite: the service demoted the
    // original to REVERSED, the real `find({status: "SETTLED"})` stopped
    // returning it, and the fixture kept insisting it was there. Reading the
    // status back out of the recorded writes makes the mock follow the code.
    mocks.eventFind.mockImplementation(() => leanResult(settledEventsAfterWrites()));
  });

  it("writes a mirroring DEBIT rather than amending the original", async () => {
    await reverseEvent(eventId, { principal, reason: "approved in error" });

    expect(mocks.eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 12000, direction: "DEBIT", status: "SETTLED" }),
    );
  });

  // Invariant 1: sum(CREDIT) − sum(DEBIT) is the balance, so a reversal of a
  // fully paid invoice returns it to zero and the invoice reopens.
  it("returns the balance to zero and the invoice to OPEN", async () => {
    const { balance } = await reverseEvent(eventId, {
      principal,
      reason: "approved in error",
    });

    expect(balance?.settledAmount).toBe(0);
    expect(balance?.status).toBe("OPEN");
  });

  // Item 2.7. Both of these are why target §9.3 calls a silent reversal a
  // support disaster: the resident is left holding a receipt for money that no
  // longer counts, and finds out from a dunning notice.
  it("voids the receipt for the reversed money", async () => {
    const receiptId = new Types.ObjectId();

    mocks.receiptFindOne.mockReturnValue(leanResult({ _id: receiptId, voidedAt: null }));

    await reverseEvent(eventId, { principal, reason: "approved in error" });

    expect(mocks.voidReceipt).toHaveBeenCalledWith(
      receiptId,
      expect.objectContaining({ reason: "approved in error" }),
    );
    // No replacement: the money went back, so there is nothing to receipt.
    expect(mocks.voidReceipt.mock.calls[0]![1]).not.toHaveProperty("reissue");
  });

  it("does not void a receipt that was already voided", async () => {
    mocks.receiptFindOne.mockReturnValue(
      leanResult({ _id: new Types.ObjectId(), voidedAt: new Date() }),
    );

    await reverseEvent(eventId, { principal, reason: "approved in error" });

    expect(mocks.voidReceipt).not.toHaveBeenCalled();
  });

  it("tells the resident, with the reason and their new balance", async () => {
    await reverseEvent(eventId, { principal, reason: "approved in error" });

    expect(mocks.notifyReversed).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 12000,
        outstandingAmount: 12000,
        reason: "approved in error",
        residentId,
      }),
    );
  });

  it("is idempotent on the original event id", async () => {
    await reverseEvent(eventId, { principal, reason: "approved in error" });

    expect(mocks.eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `reversal:${eventId.toString()}` }),
    );
  });

  it("links the two events in both directions", async () => {
    await reverseEvent(eventId, { principal, reason: "approved in error" });

    const updates = mocks.eventUpdateOne.mock.calls.map((call) => call[1].$set);

    expect(updates).toContainEqual(expect.objectContaining({ reversesEventId: eventId }));
    expect(updates).toContainEqual(
      expect.objectContaining({ reversedByEventId: eventId }),
    );
  });

  /**
   * Target §9.3: `reversedByEventId` is the only write the original may take.
   *
   * Regression. Demoting it to `REVERSED` reads as tidy bookkeeping and breaks
   * invariant 1, because the balance sums `{status: "SETTLED"}` — the CREDIT
   * leaves the sum while the DEBIT also subtracts, so a reversed 12,000 lands
   * at −12,000 and the invoice reports 24,000 outstanding. Neither the drift
   * job nor the old fixture could see it, so the rule is pinned here directly.
   */
  it("leaves the original SETTLED so the DEBIT is what cancels the money", async () => {
    await reverseEvent(eventId, { principal, reason: "approved in error" });

    const originalUpdate = mocks.eventUpdateOne.mock.calls.find(
      (call) => "reversedByEventId" in (call[1]?.$set ?? {}),
    );

    expect(originalUpdate?.[1].$set).not.toHaveProperty("status");
    expect(Object.keys(originalUpdate?.[1].$set ?? {})).toEqual(["reversedByEventId"]);
  });

  // target §9.3: a reason is required, because a reversal the resident
  // discovers by accident is a support disaster and "why" is the first question.
  it.each(["", "  ", "no"])("refuses the inadequate reason %s", async (reason) => {
    await expect(reverseEvent(eventId, { principal, reason })).rejects.toMatchObject({
      errorCode: "REVERSAL_REASON_REQUIRED",
    });
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });

  it("reports a missing event as EVENT_NOT_FOUND", async () => {
    mocks.eventFindOne.mockReturnValue(leanResult(null));

    await expect(
      reverseEvent(eventId, { principal, reason: "approved in error" }),
    ).rejects.toMatchObject({ errorCode: "EVENT_NOT_FOUND" });
  });

  it("refuses to reverse an event that never settled", async () => {
    mocks.eventFindOne.mockReturnValue(
      leanResult({ _id: eventId, amount: 12000, hostelId, status: "PENDING" }),
    );

    await expect(
      reverseEvent(eventId, { principal, reason: "approved in error" }),
    ).rejects.toMatchObject({ errorCode: "SETTLED_EVENT_IMMUTABLE" });
  });

  it("audits the reversal with its reason", async () => {
    await reverseEvent(eventId, { principal, reason: "approved in error" });

    const entry = mocks.auditCreate.mock.calls[0][0];

    expect(entry.action).toBe("PAYMENT_EVENT_REVERSED");
    expect(entry.metadata.reason).toBe("approved in error");
  });
});

describe("recomputeInvoiceBalance", () => {
  it("nets debits against credits", async () => {
    mocks.eventFind.mockReturnValue(
      leanResult([
        { _id: eventId, amount: 12000, direction: "CREDIT" },
        { _id: new Types.ObjectId(), amount: 5000, direction: "DEBIT" },
      ]),
    );

    const balance = await recomputeInvoiceBalance(invoiceId);

    expect(balance.settledAmount).toBe(7000);
    expect(balance.outstanding).toBe(5000);
  });

  it("reads only settled events", async () => {
    await recomputeInvoiceBalance(invoiceId);

    expect(mocks.eventFind).toHaveBeenCalledWith({ invoiceId, status: "SETTLED" });
  });

  // Rebuilt from scratch, never incremented: an increment can drift, a
  // recomputation cannot. The version counter makes a lost update visible.
  it("rewrites the projection wholesale and bumps its version", async () => {
    mocks.eventFind.mockReturnValue(
      leanResult([{ _id: eventId, amount: 12000, direction: "CREDIT" }]),
    );

    await recomputeInvoiceBalance(invoiceId);

    const [, update] = mocks.balanceFindOneAndUpdate.mock.calls[0];

    expect(update.$set.settledAmount).toBe(12000);
    expect(update.$inc).toEqual({ version: 1 });
  });

  // Invariant 3: an overpayment is not clamped away here — the excess survives
  // as a positive balance for 5.3's credit handling to pick up.
  it("does not clamp an overpayment", async () => {
    mocks.eventFind.mockReturnValue(
      leanResult([{ _id: eventId, amount: 15000, direction: "CREDIT" }]),
    );

    const balance = await recomputeInvoiceBalance(invoiceId);

    expect(balance.settledAmount).toBe(15000);
    expect(balance.outstanding).toBe(0);
  });

  it("writes the derived status back to the invoice when it changes", async () => {
    mocks.eventFind.mockReturnValue(
      leanResult([{ _id: eventId, amount: 12000, direction: "CREDIT" }]),
    );

    await recomputeInvoiceBalance(invoiceId);

    expect(mocks.invoiceUpdateOne).toHaveBeenCalledWith(
      { _id: invoiceId },
      { $set: { status: "PAID" } },
    );
  });

  it("leaves the invoice alone when the status is unchanged", async () => {
    await recomputeInvoiceBalance(invoiceId);

    expect(mocks.invoiceUpdateOne).not.toHaveBeenCalled();
  });

  it("refuses to compute a balance for an invoice that does not exist", async () => {
    mocks.invoiceFindOne.mockReturnValue(leanResult(null));

    await expect(recomputeInvoiceBalance(invoiceId)).rejects.toMatchObject({
      errorCode: "INVOICE_NOT_FOUND",
    });
  });
});

describe("deriveInvoiceStatus", () => {
  const future = new Date("2099-01-01T00:00:00.000Z");
  const past = new Date("2020-01-01T00:00:00.000Z");

  it.each([
    ["fully settled", 12000, 12000, future, "PAID"],
    ["overpaid", 15000, 12000, future, "PAID"],
    ["nothing settled, not yet due", 0, 12000, future, "OPEN"],
    ["part settled, not yet due", 5000, 12000, future, "PARTIAL"],
    ["nothing settled, past due", 0, 12000, past, "OVERDUE"],
  ] as const)("is %s → %s", (_label, settledAmount, totalAmount, dueDate, expected) => {
    expect(deriveInvoiceStatus({ dueDate, settledAmount, totalAmount })).toBe(expected);
  });

  /**
   * Overdue outranks partial on purpose: a half-paid invoice past its due date
   * is actionable, and calling it PARTIAL would hide it from the one list an
   * owner actually chases.
   */
  it("calls a part-paid, past-due invoice OVERDUE rather than PARTIAL", () => {
    expect(
      deriveInvoiceStatus({ dueDate: past, settledAmount: 5000, totalAmount: 12000 }),
    ).toBe("OVERDUE");
  });

  it("still calls a fully paid, past-due invoice PAID", () => {
    expect(
      deriveInvoiceStatus({ dueDate: past, settledAmount: 12000, totalAmount: 12000 }),
    ).toBe("PAID");
  });

  // VOID and WRITTEN_OFF are decisions, not balances. A recomputation must not
  // resurrect an invoice somebody deliberately cancelled.
  it.each(["VOID", "WRITTEN_OFF"])("never overrides %s", (currentStatus) => {
    expect(
      deriveInvoiceStatus({
        currentStatus,
        dueDate: past,
        settledAmount: 12000,
        totalAmount: 12000,
      }),
    ).toBe(currentStatus);
  });

  it("treats an invoice with no due date as not overdue", () => {
    expect(
      deriveInvoiceStatus({ dueDate: null, settledAmount: 0, totalAmount: 12000 }),
    ).toBe("OPEN");
  });
});
