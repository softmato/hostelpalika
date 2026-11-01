/**
 * Review checks and `Approve all` — Block 3 item 3.5 of
 * docs/FINANCE_IMPLEMENTATION_PLAN.md (target §11.4).
 *
 * The checks are computed on the server so that the badge a reviewer reads and
 * the gate a bulk sweep applies are the *same rule*. Two implementations of
 * "looks fine" is how `Approve all` settles a row the screen had marked amber,
 * so these tests pin the rule once and then prove the sweep obeys it — including
 * when the client asks it not to.
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiPrincipal } from "@/lib/api-auth";
import { Role } from "@/lib/roles";

const mocks = vi.hoisted(() => ({
  assetFind: vi.fn(),
  audit: vi.fn(),
  balanceFind: vi.fn(),
  eventFind: vi.fn(),
  eventFindOne: vi.fn(),
  eventFindOneAndUpdate: vi.fn(),
  invoiceFind: vi.fn(),
  invoiceFindOne: vi.fn(),
  markReferralConverted: vi.fn(),
  notifyReviewed: vi.fn(),
  publish: vi.fn(),
  residentFind: vi.fn(),
  settleEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/lib/realtime/server", () => ({ publishResourceChange: mocks.publish }));
vi.mock("@/modules/finance/audit-finance", () => ({ auditFinanceAction: mocks.audit }));

vi.mock("@/modules/finance/finance-notify", () => ({
  notifyAdminsOfClaim: vi.fn(),
  notifyClaimReviewed: mocks.notifyReviewed,
  notifyResidentOfClaim: vi.fn(),
}));

vi.mock("@/modules/finance/payment-event.service", () => ({
  appendEvent: vi.fn(),
  settleEvent: mocks.settleEvent,
}));

vi.mock("@/modules/referrals/referral.service", () => ({
  markReferralConverted: mocks.markReferralConverted,
}));

vi.mock("@hostel/db/models/FileAsset", () => ({
  FileAssetModel: { find: mocks.assetFind },
}));

vi.mock("@hostel/db/models/Invoice", () => ({
  InvoiceModel: { find: mocks.invoiceFind, findOne: mocks.invoiceFindOne },
}));

vi.mock("@hostel/db/models/InvoiceBalance", () => ({
  InvoiceBalanceModel: { find: mocks.balanceFind },
}));

vi.mock("@hostel/db/models/PaymentEvent", () => ({
  PaymentEventModel: {
    find: mocks.eventFind,
    findOne: mocks.eventFindOne,
    findOneAndUpdate: mocks.eventFindOneAndUpdate,
  },
}));

vi.mock("@hostel/db/models/Resident", () => ({
  ResidentModel: { find: mocks.residentFind },
}));

const { bulkApproveClaims, claimChecks, listReviewQueue } = await import(
  "./review.service"
);

const hostelId = new Types.ObjectId();
const residentId = new Types.ObjectId();
const invoiceId = new Types.ObjectId();
const assetId = new Types.ObjectId();

const principal = {
  hostelIds: [hostelId.toString()],
  role: Role.HOSTEL_ADMIN,
  userId: new Types.ObjectId().toString(),
} as ApiPrincipal;

function chain<T>(value: T) {
  return {
    lean: () => Promise.resolve(value),
    limit: function limit() {
      return this;
    },
    select: function select() {
      return this;
    },
    sort: function sort() {
      return this;
    },
  };
}

const invoice = {
  _id: invoiceId,
  period: "2026-09",
  referenceCode: "EDU-0001-F",
  status: "OPEN",
  totalAmount: 10000,
};

/** A claim that passes every check. Each test spoils exactly one thing. */
function greenEvent(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    amount: 10000,
    confirmation: "UNCONFIRMED",
    evidenceAssetId: assetId,
    invoiceId,
    occurredAt: new Date(),
    provider: "ESEWA",
    // Quoting the invoice's code is part of what "passes every check" means now
    // that the REFERENCE check actually reads what the resident submitted.
    rawPayload: { transactionCode: "EDU-0001-F" },
    residentId,
    // Passing every check now includes the payee: the money has to have reached
    // an account the hostel registered. It is the one check a payer cannot
    // satisfy by typing, which is exactly why a green row must carry it.
    reviewFlags: ["EVIDENCE_PAYEE_VERIFIED"],
    status: "PENDING",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assetFind.mockReturnValue(chain([]));
  mocks.invoiceFind.mockReturnValue(chain([invoice]));
  mocks.balanceFind.mockReturnValue(chain([]));
  mocks.residentFind.mockReturnValue(
    chain([{ _id: residentId, firstName: "Suman", lastName: "Tamang" }]),
  );
  // `approveClaim` re-loads the claim through `findClaim` before settling.
  // Filter-aware since the double-credit guard: `approveClaim` also asks whether
  // a statement row has already settled this claim's money, and a blanket answer
  // makes every claim in this file look like one that had.
  mocks.eventFindOne.mockImplementation((filter: Record<string, unknown>) =>
    chain(
      "rawPayload.claimEventId" in filter ? null : { ...greenEvent(), hostelId },
    ),
  );
  mocks.invoiceFindOne.mockReturnValue(chain(invoice));
  mocks.settleEvent.mockResolvedValue({
    balance: { settledAmount: 10000 },
    event: { _id: new Types.ObjectId(), amount: 10000, residentId },
    receipt: { receiptNumber: "RCP-EDU-2026-09-00001" },
  });
});

describe("claimChecks", () => {
  it("is all green for an exact payment on an open, referenced invoice", () => {
    const checks = claimChecks(greenEvent(), invoice, { settled: 0 });

    expect(checks.every((check) => check.ok)).toBe(true);
  });

  it("flags a claim with no screenshot", () => {
    const checks = claimChecks(greenEvent({ evidenceAssetId: null }), invoice, {
      settled: 0,
    });

    expect(checks.find((check) => check.key === "EVIDENCE")?.ok).toBe(false);
  });

  it("flags evidence nothing could inspect, even though it is attached", () => {
    // Gap fix 3. This check used to assert only that an asset id existed, so a
    // claim whose evidence was a photograph of anything at all went green — and
    // with the other four green, `Approve all` settled it without a human ever
    // opening the image. Nothing here can read what an image depicts, so the
    // honest answer is amber, which keeps the row out of the sweep.
    const checks = claimChecks(
      greenEvent({
        reviewFlags: ["EVIDENCE_NOT_MACHINE_CHECKED", "EVIDENCE_PAYEE_VERIFIED"],
      }),
      invoice,
      { settled: 0 },
    );
    const evidence = checks.find((check) => check.key === "EVIDENCE");

    expect(evidence?.ok).toBe(false);
    expect(evidence?.detail).toContain("open it");
  });

  it("flags a part payment — legitimate, but a decision a sweep must not make", () => {
    const checks = claimChecks(greenEvent({ amount: 4000 }), invoice, { settled: 0 });
    const amount = checks.find((check) => check.key === "AMOUNT");

    expect(amount?.ok).toBe(false);
    // The detail names both numbers, because "amount mismatch" alone tells the
    // reviewer nothing they can act on.
    expect(amount?.detail).toContain("4000");
    expect(amount?.detail).toContain("10000");
  });

  it("measures the amount against what is outstanding, not the invoice total", () => {
    const checks = claimChecks(greenEvent({ amount: 6000 }), invoice, {
      settled: 4000,
    });

    expect(checks.find((check) => check.key === "AMOUNT")?.ok).toBe(true);
  });

  it("flags an invoice that is no longer open", () => {
    const checks = claimChecks(greenEvent({ amount: 0 }), { ...invoice, status: "PAID" }, {
      settled: 10000,
    });

    expect(checks.find((check) => check.key === "INVOICE_OPEN")?.ok).toBe(false);
  });

  it("flags an invoice with no reference code", () => {
    const checks = claimChecks(
      greenEvent(),
      { ...invoice, referenceCode: undefined },
      { settled: 0 },
    );

    expect(checks.find((check) => check.key === "REFERENCE")?.ok).toBe(false);
  });

  it("passes only when the resident quoted this invoice's code", () => {
    const checks = claimChecks(greenEvent(), invoice, { settled: 0 });
    const reference = checks.find((check) => check.key === "REFERENCE");

    expect(reference?.ok).toBe(true);
    expect(reference?.detail).toContain("EDU-0001-F");
  });

  it("reads the code out of the free-text note as well as the txn id", () => {
    // Residents put it wherever there is a box. The statement matcher already
    // scans free text for codes; the claim check now uses the same extractor.
    const checks = claimChecks(
      greenEvent({ rawPayload: { referenceNote: "paid rent, ref edu-0001-f" } }),
      invoice,
      { settled: 0 },
    );

    expect(checks.find((check) => check.key === "REFERENCE")?.ok).toBe(true);
  });

  it("flags a claim that quoted nothing", () => {
    // The regression this whole check exists for: it used to be
    // `Boolean(invoice.referenceCode)`, so this row was green and swept by
    // `Approve all` without anybody having quoted anything.
    const checks = claimChecks(
      greenEvent({ rawPayload: {} }),
      invoice,
      { settled: 0 },
    );
    const reference = checks.find((check) => check.key === "REFERENCE");

    expect(reference?.ok).toBe(false);
    expect(reference?.detail).toContain("Did not quote");
  });

  it("flags a claim quoting another invoice's code", () => {
    // The valuable amber: August's rent paid quoting July's reference is the
    // commonest way money lands against the wrong month.
    const checks = claimChecks(
      greenEvent({ rawPayload: { transactionCode: "EDU-0002-P" } }),
      invoice,
      { settled: 0 },
    );
    const reference = checks.find((check) => check.key === "REFERENCE");

    expect(reference?.ok).toBe(false);
    expect(reference?.detail).toContain("EDU-0002-P");
    expect(reference?.detail).toContain("EDU-0001-F");
  });

  it("ignores a mistyped code rather than accepting it", () => {
    // Extraction verifies the check character, so a transposed code is not a
    // code at all and must not read as "quoted the wrong invoice".
    const checks = claimChecks(
      greenEvent({ rawPayload: { transactionCode: "EDU-0001-Q" } }),
      invoice,
      { settled: 0 },
    );

    expect(checks.find((check) => check.key === "REFERENCE")?.detail).toContain(
      "Did not quote",
    );
  });

  it("flags a claim whose receiving account could not be confirmed", () => {
    // The claim that motivated the check: a resident sends the exact rent to a
    // friend's wallet with the right reference code in the remarks. Amount,
    // reference and invoice all pass, because all three are things the payer
    // typed. Only the payee distinguishes it, and an unconfirmed payee must
    // never be green.
    const checks = claimChecks(
      greenEvent({ reviewFlags: ["EVIDENCE_PAYEE_UNVERIFIED"] }),
      invoice,
      { settled: 0 },
    );
    const payee = checks.find((check) => check.key === "PAYEE");

    expect(payee?.ok).toBe(false);
    expect(payee?.detail).toContain("open it");
    expect(checks.every((check) => check.ok)).toBe(false);
  });

  it("does not call the payee checked when there is no payee flag at all", () => {
    // OCR off, or a claim predating the check. Neither is a verification, and
    // claiming one would make the badge assert something nobody established.
    const checks = claimChecks(greenEvent({ reviewFlags: [] }), invoice, {
      settled: 0,
    });

    expect(checks.find((check) => check.key === "PAYEE")?.ok).toBe(false);
  });

  it("keeps a receipt of unknown direction out of the green", () => {
    // A credit-side receipt is refused at submission, so what reaches the queue
    // is the file whose direction could not be read. On such a file the numbers
    // agreeing means nothing — it may be a record of the resident being paid —
    // so reporting the amount match in green would be true and misleading.
    const checks = claimChecks(
      greenEvent({
        reviewFlags: [
          "EVIDENCE_TEXT_MATCHES_CLAIM",
          "EVIDENCE_DIRECTION_UNVERIFIED",
          "EVIDENCE_PAYEE_VERIFIED",
        ],
      }),
      invoice,
      { settled: 0 },
    );
    const evidence = checks.find((check) => check.key === "EVIDENCE");

    expect(evidence?.ok).toBe(false);
    expect(evidence?.detail).toContain("money going out");
  });

  it("tells the reviewer to wait when the receipt says the transfer is pending", () => {
    // Not a refusal — banks settle these a day later and the money does arrive.
    // It is precisely the row where the right decision is the statement, not
    // today's judgement.
    const checks = claimChecks(
      greenEvent({
        reviewFlags: ["EVIDENCE_OUTCOME_PENDING", "EVIDENCE_PAYEE_VERIFIED"],
      }),
      invoice,
      { settled: 0 },
    );

    expect(checks.find((check) => check.key === "EVIDENCE")?.detail).toContain(
      "still pending",
    );
  });

  it("flags evidence that looks like an earlier screenshot", () => {
    const checks = claimChecks(
      greenEvent({ reviewFlags: ["SIMILAR_EVIDENCE", "EVIDENCE_PAYEE_VERIFIED"] }),
      invoice,
      { settled: 0 },
    );

    // Item 3.4's flag surfaces here and nowhere else — it never rejected
    // anything, and it does not reject anything now either.
    expect(checks.find((check) => check.key === "SIMILARITY")?.ok).toBe(false);
  });

  it("keeps the FILE check green when the file offers one ordinary explanation", () => {
    // A crop on its own is the commonest honest thing a resident does — hiding
    // their bank balance. Amber here would put a warning on a large share of
    // real claims, and a warning that common is a warning nobody reads.
    const checks = claimChecks(
      greenEvent({
        reviewFlags: ["EVIDENCE_PAYEE_VERIFIED", "EVIDENCE_DIMENSIONS_UNUSUAL"],
      }),
      invoice,
      { settled: 0 },
    );
    const file = checks.find((check) => check.key === "FILE");

    expect(file?.ok).toBe(true);
    expect(file?.detail).toContain("cropped");
  });

  it("turns the FILE check amber once two things about the file disagree", () => {
    const checks = claimChecks(
      greenEvent({
        reviewFlags: [
          "EVIDENCE_PAYEE_VERIFIED",
          "EVIDENCE_EDITOR_SIGNATURE",
          "EVIDENCE_DIMENSIONS_UNUSUAL",
        ],
      }),
      invoice,
      { settled: 0 },
    );
    const file = checks.find((check) => check.key === "FILE");

    expect(file?.ok).toBe(false);
    expect(file?.detail).toContain("image editor");
    // Amber, never a refusal: the resident may have drawn an arrow on the amount
    // and cropped their balance out, which is two honest acts.
    expect(file?.detail).toContain("ask for the original");
  });

  it("says nothing about the file on an asset stored before provenance existed", () => {
    const checks = claimChecks(greenEvent(), invoice, { settled: 0 });
    const file = checks.find((check) => check.key === "FILE");

    // Absent measurement is not a clean bill of health, but it is not an
    // accusation either — and it must not keep the row out of `Approve all`.
    expect(file?.ok).toBe(true);
  });

  it("flags every check on a claim with no invoice at all", () => {
    const checks = claimChecks(greenEvent({ invoiceId: null }), null, { settled: 0 });

    expect(checks.filter((check) => !check.ok).map((check) => check.key)).toEqual([
      "AMOUNT",
      "INVOICE_OPEN",
      "REFERENCE",
    ]);
  });
});

describe("listReviewQueue", () => {
  it("keeps a claim whose resident has been deleted", async () => {
    mocks.eventFind.mockReturnValue(chain([greenEvent()]));
    mocks.residentFind.mockReturnValue(chain([]));

    const rows = await listReviewQueue(hostelId);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.residentName).toBe("Removed resident");
  });

  it("marks a clean row all-green", async () => {
    mocks.eventFind.mockReturnValue(chain([greenEvent()]));

    const [row] = await listReviewQueue(hostelId);

    expect(row?.allGreen).toBe(true);
    expect(row?.checks).toHaveLength(7);
  });

  it("does not mark a part payment all-green", async () => {
    mocks.eventFind.mockReturnValue(chain([greenEvent({ amount: 4000 })]));

    expect((await listReviewQueue(hostelId))[0]?.allGreen).toBe(false);
  });
});

describe("bulkApproveClaims", () => {
  it("approves every green row", async () => {
    const events = [greenEvent(), greenEvent()];

    mocks.eventFind.mockReturnValue(chain(events));
    mocks.invoiceFindOne.mockReturnValue(chain(invoice));

    const result = await bulkApproveClaims(
      hostelId,
      events.map((event) => event._id.toString()),
      principal,
    );

    expect(result.approved).toHaveLength(2);
    expect(result.skipped).toEqual([]);
  });

  it("refuses an amber row even when the client asks for it", async () => {
    const amber = greenEvent({ amount: 4000 });

    mocks.eventFind.mockReturnValue(chain([amber]));
    mocks.invoiceFindOne.mockReturnValue(chain(invoice));

    const result = await bulkApproveClaims(
      hostelId,
      [amber._id.toString()],
      principal,
    );

    // The whole point: a row can go amber between render and click, and a sweep
    // that trusted the ids would settle something nobody was shown as safe.
    expect(result.approved).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("4000");
    expect(mocks.settleEvent).not.toHaveBeenCalled();
  });

  it("reports an id that is no longer awaiting review rather than silently dropping it", async () => {
    mocks.eventFind.mockReturnValue(chain([]));

    const result = await bulkApproveClaims(
      hostelId,
      [new Types.ObjectId().toString()],
      principal,
    );

    expect(result.approved).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("No longer awaiting review.");
  });

  it("keeps the approvals that succeeded when one fails", async () => {
    const events = [greenEvent(), greenEvent()];

    mocks.eventFind.mockReturnValue(chain(events));
    mocks.invoiceFindOne.mockReturnValue(chain(invoice));
    mocks.settleEvent
      .mockRejectedValueOnce(new Error("Settlement failed."))
      .mockResolvedValue({
        balance: { settledAmount: 10000 },
        event: { _id: new Types.ObjectId(), amount: 10000, residentId },
        receipt: { receiptNumber: "RCP-EDU-2026-09-00002" },
      });

    const result = await bulkApproveClaims(
      hostelId,
      events.map((event) => event._id.toString()),
      principal,
    );

    // ADR-4: detect, do not prevent. The settled one is real money and must not
    // be unwound because a later row failed.
    expect(result.approved).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe("Settlement failed.");
  });
});
