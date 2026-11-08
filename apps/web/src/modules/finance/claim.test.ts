/**
 * Claim submission — Block 3 item 3.4 of docs/FINANCE_IMPLEMENTATION_PLAN.md
 * (target §11.2, §11.3, §8).
 *
 * The item's own test line: "duplicate screenshot, reused txn ID, foreign asset,
 * amount out of bounds, and the happy path each produce exactly the right error
 * code and **never reach the owner queue** (target P7)."
 *
 * That last clause is what every rejection case asserts, and it is invariant 9.
 * A duplicate that lands in front of a human has already cost the thing the
 * check exists to save — so each of these confirms that `appendEvent` was never
 * called and no admin was notified, not merely that an error came back.
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiPrincipal } from "@/lib/api-auth";
import { Role } from "@/lib/roles";

const mocks = vi.hoisted(() => ({
  appendEvent: vi.fn(),
  assetFind: vi.fn(),
  assetFindOne: vi.fn(),
  audit: vi.fn(),
  balanceFindOne: vi.fn(),
  eventExists: vi.fn(),
  eventFind: vi.fn(),
  eventFindOne: vi.fn(),
  findCurrentResident: vi.fn(),
  hostelFindById: vi.fn(),
  profileFindOne: vi.fn(),
  readEvidenceText: vi.fn(),
  readStoredObject: vi.fn(),
  invoiceFindById: vi.fn(),
  invoiceFindOne: vi.fn(),
  notifyAdmins: vi.fn(),
  notifyResident: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/lib/realtime/server", () => ({ publishResourceChange: mocks.publish }));
vi.mock("@/modules/finance/audit-finance", () => ({ auditFinanceAction: mocks.audit }));

vi.mock("@/modules/finance/finance-notify", () => ({
  notifyAdminsOfClaim: mocks.notifyAdmins,
  notifyResidentOfClaim: mocks.notifyResident,
}));

vi.mock("@/modules/finance/payment-event.service", () => ({
  appendEvent: mocks.appendEvent,
}));

vi.mock("@/modules/residents/resident-access", () => ({
  findCurrentResident: mocks.findCurrentResident,
}));

vi.mock("@/lib/uploads/verify", () => ({
  readStoredObject: mocks.readStoredObject,
}));

/**
 * Only the recogniser is mocked. `evidenceTextFlags` and `matchClaimFacts` stay
 * real, so these tests exercise the actual matching rules against text the way a
 * screenshot would present it — the OCR engine itself is not what needs proving
 * here, and loading its WASM in unit tests would cost seconds per file.
 */
vi.mock("@/modules/finance/evidence-ocr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./evidence-ocr")>()),
  /**
   * The engine dispatcher, faked in terms of the text these tests already
   * describe.
   *
   * `readEvidence` returns the richer result — word boxes and a failure reason —
   * but not one assertion in this file is about either of those: they are all
   * about what the claim pipeline does with the *text*. So the mock stays a
   * string-in, and this adapter puts it in the shape the caller now expects.
   * Faking the richer type directly at twenty call sites would obscure what each
   * test is actually saying.
   */
  readEvidence: async (bytes: unknown, mimeType?: string) => {
    const text: string | null = await mocks.readEvidenceText(bytes, mimeType);

    return text === null
      ? { failure: "unknown", result: null }
      : { failure: null, result: { engine: "vision", ms: 0, text, words: [] } };
  },
}));

vi.mock("@hostel/db/models/FileAsset", () => ({
  FileAssetModel: { find: mocks.assetFind, findOne: mocks.assetFindOne },
}));

/**
 * The hostel's own accounts, for the payee check. Mocked as *configured* in the
 * default fixture rather than empty: an empty profile makes every payee verdict
 * amber, which would quietly stop these tests exercising the check at all.
 */
vi.mock("@hostel/db/models/HostelPaymentProfile", () => ({
  HostelPaymentProfileModel: { findOne: mocks.profileFindOne },
}));

vi.mock("@hostel/db/models/Hostel", () => ({
  HostelModel: { findById: mocks.hostelFindById },
}));

vi.mock("@hostel/db/models/Invoice", () => ({
  InvoiceModel: { findById: mocks.invoiceFindById, findOne: mocks.invoiceFindOne },
}));

vi.mock("@hostel/db/models/InvoiceBalance", () => ({
  InvoiceBalanceModel: { findOne: mocks.balanceFindOne },
}));

vi.mock("@hostel/db/models/PaymentEvent", () => ({
  PaymentEventModel: {
    exists: mocks.eventExists,
    find: mocks.eventFind,
    findOne: mocks.eventFindOne,
  },
}));

const { submitClaim } = await import("./claim.service");
const { claimSubmitSchema } = await import("@/lib/finance/claim.validation");

const hostelId = new Types.ObjectId();
const residentId = new Types.ObjectId();
const invoiceId = new Types.ObjectId();
const assetId = new Types.ObjectId();
const userId = new Types.ObjectId().toString();

const principal = {
  role: Role.RESIDENT,
  userId,
} as unknown as ApiPrincipal;

function lean<T>(value: T) {
  return { lean: () => Promise.resolve(value) };
}

/** `findOne(...).select(...).lean()`. */
function selectLean<T>(value: T) {
  const chain = {
    lean: () => Promise.resolve(value),
    select: () => chain,
  };

  return chain;
}

/** Any of `find(...).sort(...).limit(...).select(...).lean()`, in any order. */
function assetQuery<T>(value: T) {
  const chain = {
    lean: () => Promise.resolve(value),
    limit: () => chain,
    select: () => chain,
    sort: () => chain,
  };

  return chain;
}

const input = {
  amount: 10000,
  paymentMethod: "ESEWA" as const,
  proofImageAssetId: assetId.toString(),
  // Required since gap fix 3: a wallet claim with no id cannot ever be
  // reconciled against the provider's statement, so it is refused at submit.
  // A real eSewa transaction code, seven uppercase alphanumerics. The fixture
  // used to carry a ten-digit number, which eSewa has never issued — and once
  // `txn-id-rules` learned the real shape from sixteen genuine ids, every test
  // in this file started carrying an `EVIDENCE_TXN_ID_MALFORMED` flag. The
  // fixture was wrong, not the rule.
  transactionCode: "1QAXP2M",
};

/** Nothing entered the owner's queue: invariant 9, asserted the same way each time. */
function expectNothingQueued() {
  expect(mocks.appendEvent).not.toHaveBeenCalled();
  expect(mocks.notifyAdmins).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.findCurrentResident.mockResolvedValue({
    _id: residentId,
    firstName: "Suman",
    hostelId,
    lastName: "Tamang",
  });
  mocks.invoiceFindOne.mockReturnValue(
    lean({
      _id: invoiceId,
      hostelId,
      period: "2026-09",
      referenceCode: "EDU-0001-F",
      status: "OPEN",
      totalAmount: 10000,
    }),
  );
  mocks.profileFindOne.mockReturnValue(
    selectLean({
      bankAccountName: "SUNRISE HOSTEL PVT LTD",
      bankAccountNumber: "08010017894471",
      displayName: "Sunrise Boys Hostel",
      esewaId: "9801234507",
    }),
  );
  mocks.hostelFindById.mockReturnValue(selectLean({ name: "Sunrise Boys Hostel" }));
  mocks.readStoredObject.mockResolvedValue(Buffer.from("stored-bytes"));
  // What the recogniser would read off a genuine eSewa receipt for this claim.
  //
  // A *whole* receipt, not just the two numbers: the payee line and the debit
  // line are what a real one carries, and they are what the payee and direction
  // checks read. A fixture without them would leave the happy path permanently
  // amber and quietly stop these tests exercising the clean case at all.
  mocks.readEvidenceText.mockResolvedValue(
    [
      "eSewa",
      "Payment Successful",
      "Rs. 10,000.00",
      "Transaction Code 1QAXP2M",
      "Sent to: Sunrise Boys Hostel",
      "Debited from: 98XXXXXX21",
    ].join("\n"),
  );
  mocks.assetFindOne.mockReturnValue(
    lean({
      _id: assetId,
      bucket: "evidence",
      contentHash: "a".repeat(64),
      hostelId,
      key: "uploads/proof.png",
      // A decodable, non-blank image: what gap fix 2 records at upload, and what
      // keeps this claim off the `EVIDENCE_NOT_MACHINE_CHECKED` flag.
      imageInsight: { contrast: 48, height: 2160, nearBlank: false, width: 1080 },
      ownerId: new Types.ObjectId(userId),
      perceptualHash: "0f0f0f0f0f0f0f0f",
      uploadCompletedAt: new Date(),
    }),
  );
  mocks.assetFind.mockReturnValue(assetQuery([]));
  // The similarity pool is prior *evidence*, so it takes two queries: the recent
  // claims, then those claims' assets.
  mocks.eventFind.mockImplementation((filter: Record<string, unknown>) =>
    // Item E.8 asks a second question of the same model — how often this id has
    // already been turned down — so the mock dispatches on the filter rather
    // than answering every `find` with the similarity pool.
    filter?.status === "REJECTED"
      ? assetQuery([])
      : assetQuery([{ evidenceAssetId: new Types.ObjectId() }]),
  );
  mocks.balanceFindOne.mockReturnValue(lean(null));
  mocks.eventExists.mockResolvedValue(null);
  mocks.eventFindOne.mockReturnValue(lean(null));
  mocks.invoiceFindById.mockReturnValue(lean({ period: "2026-07" }));
  mocks.appendEvent.mockResolvedValue({
    created: true,
    event: { _id: new Types.ObjectId(), status: "PENDING" },
  });
});

describe("submitClaim — the happy path", () => {
  it("records a PENDING event and notifies the owner", async () => {
    const result = await submitClaim(invoiceId.toString(), input, principal);

    expect(result.status).toBe("PENDING");
    expect(mocks.notifyAdmins).toHaveBeenCalledTimes(1);
  });

  it("does not change the invoice status", async () => {
    await submitClaim(invoiceId.toString(), input, principal);

    // Target §6.2 step 7: a claim is a badge, not a payment state. This is the
    // fix for `PENDING_PROOF` conflating "someone said they paid" with money.
    const [appended] = mocks.appendEvent.mock.calls[0];

    expect(appended.status).toBe("PENDING");
    expect(appended.confirmation).toBe("UNCONFIRMED");
  });

  it("audits zero movement, because a claim moves no money", async () => {
    await submitClaim(invoiceId.toString(), input, principal);

    expect(mocks.audit).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({ amountAfter: 0, amountBefore: 0 }),
    );
  });
});

describe("submitClaim — duplicate screenshot", () => {
  it("rejects the same bytes re-uploaded as a new asset", async () => {
    // The asset id is fresh, so the one-asset-one-claim check passes; what
    // catches this is the hostel-scoped content hash.
    mocks.eventFindOne.mockImplementation((filter: Record<string, unknown>) =>
      lean("evidenceHash" in filter ? { _id: new Types.ObjectId() } : null),
    );

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toMatchObject({ errorCode: "EVIDENCE_ALREADY_USED" });

    expectNothingQueued();
  });

  /**
   * Without this the rejection card (§11.3) is a dead end — the resident is told
   * the screenshot is used and given nothing to go and find.
   */
  it("says which month the screenshot was already used for", async () => {
    mocks.eventFindOne.mockImplementation((filter: Record<string, unknown>) =>
      lean(
        "evidenceHash" in filter
          ? {
              invoiceId: new Types.ObjectId(),
              occurredAt: new Date("2026-07-02"),
              residentId,
            }
          : null,
      ),
    );

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toMatchObject({
      details: { priorPeriod: "2026-07", priorSubmittedAt: expect.any(String) },
    });
  });

  /**
   * Item E.8. The hash lookup is hostel-scoped, so the claim it collides with may
   * be somebody else's — two residents on a family bank account produce that
   * innocently — and the card used to hand the submitter that stranger's billing
   * month and filing date. The refusal has to stay identical either way, or the
   * message becomes an oracle for whose evidence exists.
   */
  it("does not tell the resident about a stranger's claim", async () => {
    mocks.eventFindOne.mockImplementation((filter: Record<string, unknown>) =>
      lean(
        "evidenceHash" in filter
          ? {
              invoiceId: new Types.ObjectId(),
              occurredAt: new Date("2026-07-02"),
              residentId: new Types.ObjectId(),
            }
          : null,
      ),
    );

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toMatchObject({
      details: { priorPeriod: null, priorSubmittedAt: null },
      errorCode: "EVIDENCE_ALREADY_USED",
    });
  });

  it("scopes the hash comparison to the hostel", async () => {
    await submitClaim(invoiceId.toString(), input, principal);

    // Comparing across hostels would reveal that another hostel holds the same
    // image — a privacy leak dressed as a fraud control.
    const hashCall = mocks.eventFindOne.mock.calls.find(
      ([filter]) => "evidenceHash" in filter,
    );

    expect(hashCall?.[0]).toMatchObject({ hostelId });
  });

  it("rejects the same asset submitted twice", async () => {
    mocks.eventExists.mockImplementation(async (filter: Record<string, unknown>) =>
      "evidenceAssetId" in filter ? { _id: new Types.ObjectId() } : null,
    );

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toMatchObject({ errorCode: "EVIDENCE_ALREADY_USED" });

    expectNothingQueued();
  });
});

/**
 * Target §11.3. One transfer has one id, so a second claim carrying it is last
 * month's payment resubmitted or a typo — and neither should reach the owner.
 */
describe("submitClaim — duplicate transaction id", () => {
  const withCode = input;

  it("rejects a transaction id another claim already carries", async () => {
    mocks.eventFindOne.mockImplementation((filter: Record<string, unknown>) =>
      lean(
        "rawPayload.transactionCode" in filter
          ? {
              invoiceId: new Types.ObjectId(),
              occurredAt: new Date("2026-07-02"),
              residentId,
            }
          : null,
      ),
    );

    await expect(
      submitClaim(invoiceId.toString(), withCode, principal),
    ).rejects.toMatchObject({
      details: { priorPeriod: "2026-07", transactionCode: "1QAXP2M" },
      errorCode: "TXN_ID_ALREADY_CLAIMED",
    });

    expectNothingQueued();
  });

  it("scopes the lookup to this hostel and provider, and ignores rejected claims", async () => {
    await submitClaim(invoiceId.toString(), withCode, principal);

    const call = mocks.eventFindOne.mock.calls.find(
      ([filter]) => "rawPayload.transactionCode" in filter,
    );

    // Across providers an eight-digit id genuinely repeats, and a rejected
    // claim must not lock the resident out of resubmitting the real one.
    expect(call?.[0]).toMatchObject({
      hostelId,
      provider: "ESEWA",
      status: { $ne: "REJECTED" },
    });
  });

  it("does not run the check for a cash claim with no id", async () => {
    await submitClaim(
      invoiceId.toString(),
      { ...input, paymentMethod: "CASH" as const, transactionCode: undefined },
      principal,
    );

    // Cash has no transaction id (§11.2), so an empty code must not collide
    // with every other cash claim in the hostel.
    expect(
      mocks.eventFindOne.mock.calls.some(
        ([filter]) => "rawPayload.transactionCode" in filter,
      ),
    ).toBe(false);
  });
});

/**
 * Item E.8 — rejection frees the id, but not forever.
 *
 * Freeing it is the point: "wrong month" and "unreadable screenshot" have to be
 * correctable, and the corrected claim carries the same real id because the
 * transfer has only one. What was missing was any end to that.
 */
describe("submitClaim — a rejected transaction id", () => {
  function rejectedClaims(claims: { residentId?: Types.ObjectId }[]) {
    mocks.eventFind.mockImplementation((filter: Record<string, unknown>) =>
      filter?.status === "REJECTED"
        ? assetQuery(claims)
        : assetQuery([{ evidenceAssetId: new Types.ObjectId() }]),
    );
  }

  it("lets the same resident correct and resubmit", async () => {
    rejectedClaims([{ residentId }, { residentId }]);

    const result = await submitClaim(invoiceId.toString(), input, principal);

    expect(result.status).toBe("PENDING");
  });

  it("stops them after the third refusal rather than looping forever", async () => {
    rejectedClaims([{ residentId }, { residentId }, { residentId }]);

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toMatchObject({ errorCode: "TXN_ID_ALREADY_CLAIMED" });

    expectNothingQueued();
  });

  // The other edge of the same loophole: a rejected id was free for anybody in
  // the hostel to pick up, not just the resident whose transfer it was.
  it("refuses an id last submitted by somebody else", async () => {
    rejectedClaims([{ residentId: new Types.ObjectId() }]);

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toMatchObject({ errorCode: "TXN_ID_ALREADY_CLAIMED" });

    expectNothingQueued();
  });
});

/**
 * Item E.8 — the ceiling did not exist once the invoice was settled.
 *
 * The bound read `outstanding > 0`, so paying a month off switched it off
 * entirely: any amount at all passed into the review queue, and an approved one
 * becomes credit on the resident's account.
 */
describe("submitClaim — the amount ceiling on a settled invoice", () => {
  beforeEach(() => {
    mocks.balanceFindOne.mockReturnValue(lean({ settledAmount: 12000 }));
  });

  it("refuses an amount far above what the invoice was ever for", async () => {
    await expect(
      submitClaim(invoiceId.toString(), { ...input, amount: 1_200_000 }, principal),
    ).rejects.toMatchObject({ errorCode: "AMOUNT_OUT_OF_BOUNDS" });

    expectNothingQueued();
  });

  it("still allows a plausible second payment against the same month", async () => {
    const result = await submitClaim(
      invoiceId.toString(),
      { ...input, amount: 12000 },
      principal,
    );

    expect(result.status).toBe("PENDING");
  });
});

/** Item E.8 — an upload is evidence for the claim it was made for. */
describe("submitClaim — a stale upload", () => {
  it("refuses an asset uploaded months ago", async () => {
    mocks.assetFindOne.mockReturnValue(
      lean({
        _id: assetId,
        bucket: "evidence",
        contentHash: "a".repeat(64),
        hostelId,
        key: "uploads/proof.png",
        imageInsight: { contrast: 48, height: 2160, nearBlank: false, width: 1080 },
        ownerId: new Types.ObjectId(userId),
        uploadCompletedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      }),
    );

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toMatchObject({ errorCode: "ASSET_UPLOAD_INCOMPLETE" });

    expectNothingQueued();
  });
});

describe("submitClaim — a screenshot that only looks similar", () => {
  it("flags for review and never rejects", async () => {
    mocks.assetFind.mockReturnValue(
      // One bit different: well inside the threshold.
      assetQuery([{ perceptualHash: "0f0f0f0f0f0f0f0e" }]),
    );

    const result = await submitClaim(invoiceId.toString(), input, principal);

    expect(result.status).toBe("PENDING");
    expect(mocks.appendEvent.mock.calls[0][0].reviewFlags).toContain(
      "SIMILAR_EVIDENCE",
    );
  });

  it("does not flag an image that merely shares a bank app's layout", async () => {
    mocks.assetFind.mockReturnValue(assetQuery([{ perceptualHash: "f0f0f0f0f0f0f0f0" }]));

    await submitClaim(invoiceId.toString(), input, principal);

    expect(mocks.appendEvent.mock.calls[0][0].reviewFlags).not.toContain(
      "SIMILAR_EVIDENCE",
    );
  });

  it("compares against prior evidence only, not every asset in the hostel", async () => {
    // The pool used to be any perceptually-hashed `FileAsset`, so a community
    // photo or a payment QR could flag a claim for resembling something nobody
    // had submitted as proof of anything. A flag a reviewer cannot act on trains
    // them to click past the one that matters.
    await submitClaim(invoiceId.toString(), input, principal);

    expect(mocks.eventFind).toHaveBeenCalledWith(
      expect.objectContaining({ hostelId, source: "RESIDENT_CLAIM" }),
    );
  });

  it("skips the comparison when the hostel has no prior evidence", async () => {
    mocks.eventFind.mockReturnValue(assetQuery([]));

    await submitClaim(invoiceId.toString(), input, principal);

    expect(mocks.assetFind).not.toHaveBeenCalled();
  });
});

/**
 * Gap fix 3. The case that motivated all of this: any image plus a typed
 * placeholder used to reach the owner's queue looking exactly like a real claim.
 */
/**
 * The three refusals that read the *kind* of transaction rather than its numbers.
 *
 * Every other check in this file verifies something the resident supplied. These
 * verify the receipt against facts the resident does not control — which way the
 * money moved, whether it moved, and who received it — and they are the only
 * checks that can refuse a claim whose amount, transaction ID and reference code
 * are all genuinely correct.
 *
 * Each asserts invariant 9 as well: a refusal never reaches the owner's queue.
 */
describe("submitClaim — the right numbers on the wrong transaction", () => {
  it("refuses a payment made to somebody who is not this hostel", async () => {
    // The fraud this closes. The resident sends the exact rent to a friend's
    // wallet and types the invoice's own reference code in the remarks. The
    // payment is real, the receipt is real, the amount is right and the code is
    // right — every check that reads what the resident supplied passes. The
    // hostel receives nothing, and the friend withdraws it.
    mocks.readEvidenceText.mockResolvedValue(
      [
        "eSewa",
        "Payment Successful",
        "Rs. 10,000.00",
        "Transaction Code 1QAXP2M",
        "Sent to: Ramesh Shrestha",
        "Remarks: EDU-0001-F",
      ].join("\n"),
    );

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toMatchObject({ errorCode: "EVIDENCE_WRONG_TRANSACTION" });

    expectNothingQueued();
  });

  it("names the account it read, so the resident knows what we saw", async () => {
    mocks.readEvidenceText.mockResolvedValue(
      ["eSewa", "Rs. 10,000.00", "Sent to: Ramesh Shrestha"].join("\n"),
    );

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toThrow(/Ramesh Shrestha/);
  });

  it("refuses a credit-side receipt — money arriving, not leaving", async () => {
    // The file that motivated the direction check. Submitted as proof of paying,
    // it is a record of the resident being *paid*, and it passed every numeric
    // check because on such a receipt every number is correct.
    mocks.readEvidenceText.mockResolvedValue(
      [
        "eSewa",
        "Transaction Successful",
        "Rs. 10,000.00",
        "Transaction Code 1QAXP2M",
        "Received from: Ramesh Shrestha",
        "Amount credited to your account",
      ].join("\n"),
    );

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toThrow(/coming \*into\* your account/);

    expectNothingQueued();
  });

  it("refuses a receipt for a transaction that failed", async () => {
    mocks.readEvidenceText.mockResolvedValue(
      [
        "eSewa",
        "Transaction Failed",
        "Rs. 10,000.00",
        "Transaction Code 1QAXP2M",
        "Sent to: Sunrise Boys Hostel",
      ].join("\n"),
    );

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toThrow(/no money left your account/);

    expectNothingQueued();
  });

  it("accepts a pending transfer and flags it instead", async () => {
    // Banks settle these a day later and the money does arrive. Refusing one
    // would turn a real payment away; the flag is what makes the reviewer wait
    // for the statement rather than decide today.
    mocks.readEvidenceText.mockResolvedValue(
      [
        "Global IME Bank",
        "Transfer Pending",
        "NPR 10,000.00",
        "Transaction Code 1QAXP2M",
        "Credited to: Sunrise Boys Hostel",
      ].join("\n"),
    );

    const result = await submitClaim(invoiceId.toString(), input, principal);

    expect(result.status).toBe("PENDING");
    expect(mocks.appendEvent.mock.calls[0][0].reviewFlags).toContain(
      "EVIDENCE_OUTCOME_PENDING",
    );
  });

  it("does not refuse when the hostel has registered no accounts to compare against", async () => {
    // A fraud control that refuses every resident of an unconfigured hostel gets
    // switched off inside a day. With nothing to compare against the payee
    // question is unanswerable, which is amber, not a refusal.
    mocks.profileFindOne.mockReturnValue(selectLean(null));
    mocks.hostelFindById.mockReturnValue(selectLean(null));
    mocks.readEvidenceText.mockResolvedValue(
      ["eSewa", "Rs. 10,000.00", "Sent to: Ramesh Shrestha"].join("\n"),
    );

    const result = await submitClaim(invoiceId.toString(), input, principal);

    expect(result.status).toBe("PENDING");
    expect(mocks.appendEvent.mock.calls[0][0].reviewFlags).toContain(
      "EVIDENCE_PAYEE_UNVERIFIED",
    );
  });

  it("accepts a real QR merchant receipt paid to the hostel, with no directional word on it", async () => {
    // Everest Bank's `Payment Receipt`, which is what a great many residents will
    // actually upload. It says `Reference Code`, `Channel`, `Initiator`, `Qr
    // Merchant Name` — and not one of `sent`, `paid to`, `debited` or
    // `transferred`. The direction comes from the receipt's shape, and the payee
    // settles it outright: money that reached the hostel's account left the
    // resident's, whatever words the receipt uses.
    mocks.readEvidenceText.mockResolvedValue(
      [
        "EBL EVEREST BANK",
        "Payment Receipt",
        "Reference Code 1QAXP2M",
        "Channel Online",
        "Amount (NPR) 10,000.00",
        "Initiator 9709155982",
        "Qr Merchant Name SUNRISE BOYS HOSTEL",
        "Status SUCCESS",
      ].join("\n"),
    );

    const result = await submitClaim(invoiceId.toString(), input, principal);

    expect(result.status).toBe("PENDING");
    expect(mocks.appendEvent.mock.calls[0][0].reviewFlags).toContain(
      "EVIDENCE_PAYEE_VERIFIED",
    );
    // The clean case, and the one the 95%-of-reviews target rests on: no amber
    // at all on a genuine payment to the hostel.
    expect(mocks.appendEvent.mock.calls[0][0].reviewFlags).not.toContain(
      "EVIDENCE_DIRECTION_UNVERIFIED",
    );
  });

  it("refuses the same receipt when the QR merchant is a cafeteria", async () => {
    // The real file from 2026-08-11: a genuine, successful, debit-side payment —
    // for a coffee. Nothing about the transaction is wrong; it simply is not rent.
    mocks.readEvidenceText.mockResolvedValue(
      [
        "EBL EVEREST BANK",
        "Payment Receipt",
        "Reference Code 111903076",
        "Amount (NPR) 70.00",
        "Initiator 9709155982",
        "Qr Merchant Name TEA TIME ANYTIME CAFETERIA",
        "Remarks chitya",
        "Status SUCCESS",
      ].join("\n"),
    );

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toThrow(/TEA TIME ANYTIME CAFETERIA/);

    expectNothingQueued();
  });

  it("flags an eSewa statement as a statement rather than reading its first row", async () => {
    // A real document a resident will genuinely send. It must not be refused —
    // their payment is on that page — but nothing on it says which row is this
    // month's rent, so no field may be read off it: a payee taken from a
    // statement names whoever they paid first that month.
    mocks.readEvidenceText.mockResolvedValue(
      [
        "eSewa",
        "Transaction Statement",
        "Date | Reference Code | Description | Cr. | Dr. | Balance",
        "01 Aug | 8823110001 | Fund Transferred by Ramesh Shrestha | 2,000.0 | 0.0 | 5,400",
        "04 Aug | 1QAXP2M | Fund Transferred to Sunrise Boys Hostel | 0.0 | 10,000.0 | 1,900",
      ].join("\n"),
    );

    const result = await submitClaim(invoiceId.toString(), input, principal);

    expect(result.status).toBe("PENDING");
    expect(mocks.appendEvent.mock.calls[0][0].reviewFlags).toContain(
      "EVIDENCE_IS_STATEMENT",
    );
  });

  it("flags a receipt from a different app than the resident chose", async () => {
    // The resident tapped eSewa and uploaded a Khalti receipt. Usually a mis-tap
    // on a six-button row, so it is amber rather than a refusal — but it is also
    // how a receipt for an entirely different payment shows up.
    mocks.readEvidenceText.mockResolvedValue(
      [
        "Khalti",
        "Payment Successful",
        "Amount Rs. 10,000",
        "Purchase Order ID  KHL7734X21",
        "Paid to  Sunrise Boys Hostel",
      ].join("\n"),
    );

    const result = await submitClaim(invoiceId.toString(), input, principal);

    expect(result.status).toBe("PENDING");
    expect(mocks.appendEvent.mock.calls[0][0].reviewFlags).toContain(
      "EVIDENCE_METHOD_MISMATCH",
    );
  });

  it("does not refuse a statement page, which carries both directions", async () => {
    mocks.readEvidenceText.mockResolvedValue(
      [
        "NABIL BANK — Account Statement",
        "Date | Description | Debit | Credit | Balance",
        "04/08 | Transfer to SUNRISE BOYS HOSTEL | 10,000 | | 43,500",
        "01/08 | Received from RAMESH | | 2,000 | 53,500",
        "Transaction Code 1QAXP2M",
      ].join("\n"),
    );

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).resolves.toMatchObject({ status: "PENDING" });
  });
});

describe("submitClaim — evidence that cannot be a payment screenshot", () => {
  it("rejects an image measured as blank or thumbnail-sized at upload", async () => {
    mocks.assetFindOne.mockReturnValue(
      lean({
        _id: assetId,
        contentHash: "a".repeat(64),
        hostelId,
        imageInsight: { contrast: 0, height: 4, nearBlank: true, width: 4 },
        ownerId: new Types.ObjectId(userId),
        uploadCompletedAt: new Date(),
      }),
    );

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toMatchObject({ errorCode: "EVIDENCE_NOT_READABLE" });

    expectNothingQueued();
  });

  it("confirms a claim the screenshot itself corroborates", async () => {
    // The one green signal in the system that is about the *evidence* rather than
    // about what the resident typed.
    await submitClaim(invoiceId.toString(), input, principal);

    expect(mocks.appendEvent.mock.calls[0][0].reviewFlags).toContain(
      "EVIDENCE_TEXT_MATCHES_CLAIM",
    );
  });

  it("flags an image that is not a payment record at all", async () => {
    // The cat photo. Text was read, and it carries none of a receipt's
    // vocabulary — no provider, no currency, no transaction wording.
    mocks.readEvidenceText.mockResolvedValue("Happy Birthday Ramesh");

    await submitClaim(invoiceId.toString(), input, principal);

    expect(mocks.appendEvent.mock.calls[0][0].reviewFlags).toEqual([
      "EVIDENCE_NOT_A_PAYMENT_RECORD",
      // Neither question can be answered off `Happy Birthday Ramesh`, and
      // unanswered is amber rather than green — the row stays out of a sweep.
      "EVIDENCE_DIRECTION_UNVERIFIED",
      "EVIDENCE_PAYEE_UNVERIFIED",
      // The typed id is the shape eSewa issues. A true statement about the
      // *claim*, on a file that is not a receipt — which is exactly why a
      // positive shape flag is never on its own a reason to trust anything.
      "EVIDENCE_TXN_ID_SHAPE_OK",
    ]);
  });

  it("refuses a readable page with no trace of a payment on it", async () => {
    // A photograph of a notebook. Distinct from the flag above: there is a page
    // of text here and not one word of it is about money, so no reviewer decision
    // improves on sending the resident back to the file picker.
    mocks.readEvidenceText.mockResolvedValue(
      "Physics chapter 4 notes\nremember the second law and the pulley diagram from class",
    );

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toMatchObject({ errorCode: "EVIDENCE_NOT_A_PAYMENT" });

    expectNothingQueued();
  });

  it("still accepts a real receipt that read badly, rather than refusing it", async () => {
    // One signal family out of four — warned about, queued, never refused. This
    // is the case the refusal above must never grow into: a resident's genuine
    // proof turned away because our recogniser had a bad day.
    mocks.readEvidenceText.mockResolvedValue(
      "i will send Rs. 2000 tomorrow, the rest after the exam finishes ok",
    );

    await submitClaim(invoiceId.toString(), input, principal);

    expect(mocks.appendEvent.mock.calls[0][0].reviewFlags).toContain(
      "EVIDENCE_NOT_A_PAYMENT_RECORD",
    );
  });

  it("flags a real receipt that is for some other payment", async () => {
    // Distinct from the above, and the distinction is the point: this *is* a
    // receipt, so the resident picked a plausible file — just the wrong one.
    mocks.readEvidenceText.mockResolvedValue(
      "eSewa\nPayment Successful\nRs. 500.00\nTransaction Code 1122334455",
    );

    await submitClaim(invoiceId.toString(), input, principal);

    expect(mocks.appendEvent.mock.calls[0][0].reviewFlags).toEqual([
      "EVIDENCE_NO_TEXT_FOUND",
      "EVIDENCE_DIRECTION_UNVERIFIED",
      "EVIDENCE_PAYEE_UNVERIFIED",
      "EVIDENCE_TXN_ID_SHAPE_OK",
    ]);
  });

  it("flags a screenshot for a different amount", async () => {
    // Right receipt, wrong month — or a real receipt for a smaller transfer.
    mocks.readEvidenceText.mockResolvedValue(
      "eSewa\nRs. 1,000.00\nTransaction Code 1QAXP2M",
    );

    await submitClaim(invoiceId.toString(), input, principal);

    expect(mocks.appendEvent.mock.calls[0][0].reviewFlags).toEqual([
      "EVIDENCE_AMOUNT_NOT_ON_IMAGE",
      "EVIDENCE_DIRECTION_UNVERIFIED",
      "EVIDENCE_PAYEE_UNVERIFIED",
      "EVIDENCE_TXN_ID_SHAPE_OK",
    ]);
  });

  it("flags a screenshot that does not carry the typed id", async () => {
    mocks.readEvidenceText.mockResolvedValue("eSewa\nRs. 10,000.00\nThank you");

    await submitClaim(invoiceId.toString(), input, principal);

    expect(mocks.appendEvent.mock.calls[0][0].reviewFlags).toEqual([
      "EVIDENCE_ID_NOT_ON_IMAGE",
      "EVIDENCE_DIRECTION_UNVERIFIED",
      "EVIDENCE_PAYEE_UNVERIFIED",
      "EVIDENCE_TXN_ID_SHAPE_OK",
    ]);
  });

  it("never rejects on an OCR miss — it only flags", async () => {
    // The rule the whole feature rests on. OCR on a re-compressed phone
    // screenshot misses sometimes, and refusing a real payment over a lost digit
    // would be a far worse failure than an amber row.
    mocks.readEvidenceText.mockResolvedValue("unreadable noise");

    const result = await submitClaim(invoiceId.toString(), input, principal);

    expect(result.status).toBe("PENDING");
    expect(mocks.notifyAdmins).toHaveBeenCalledTimes(1);
  });

  it("says the evidence was unread when the recogniser cannot run", async () => {
    // A missing model file, a cold worker that timed out. Unread evidence is not
    // vouched-for evidence, so the row stays out of `Approve all`.
    mocks.readEvidenceText.mockResolvedValue(null);

    await submitClaim(invoiceId.toString(), input, principal);

    expect(mocks.appendEvent.mock.calls[0][0].reviewFlags).toEqual([
      "EVIDENCE_NOT_MACHINE_CHECKED",
      // Survives the failed read, which is the point of it: the shape check
      // looks at a string the resident typed, not at the image.
      "EVIDENCE_TXN_ID_SHAPE_OK",
    ]);
  });

  it("raises nothing at all when OCR is switched off", async () => {
    // Deliberately off must not look like failed: flagging every claim in the
    // hostel would make the switch unusable, which is how a safety feature ends
    // up disabled permanently.
    vi.stubEnv("EVIDENCE_OCR", "off");

    await submitClaim(invoiceId.toString(), input, principal);

    // Not empty any more, and deliberately: the recogniser is off, so no
    // evidence flag is raised, but the transaction id the resident typed is
    // still the shape eSewa issues and saying so costs no read.
    expect(mocks.appendEvent.mock.calls[0][0].reviewFlags).toEqual([
      "EVIDENCE_TXN_ID_SHAPE_OK",
    ]);
    expect(mocks.readStoredObject).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });

  it("flags evidence nothing could inspect rather than vouching for it", async () => {
    // An image stored before the measurement existed, so nothing is known about it
    // and there is nothing safe to hand a recogniser. The row is kept out of
    // `Approve all` rather than being called green.
    mocks.assetFindOne.mockReturnValue(
      lean({
        _id: assetId,
        contentHash: "a".repeat(64),
        hostelId,
        mimeType: "image/png",
        ownerId: new Types.ObjectId(userId),
        uploadCompletedAt: new Date(),
      }),
    );

    await submitClaim(invoiceId.toString(), input, principal);

    expect(mocks.appendEvent.mock.calls[0][0].reviewFlags).toEqual([
      "EVIDENCE_NOT_MACHINE_CHECKED",
      // Survives the failed read, which is the point of it: the shape check
      // looks at a string the resident typed, not at the image.
      "EVIDENCE_TXN_ID_SHAPE_OK",
    ]);
  });

  it("reads a PDF receipt rather than giving up on it", async () => {
    // A PDF carries no `imageInsight` — nothing decodes it as an image — and it
    // used to earn the not-checked flag for exactly that reason. Backwards: its
    // text is text, so it reads where a screenshot is guessed at.
    mocks.assetFindOne.mockReturnValue(
      lean({
        _id: assetId,
        bucket: "evidence",
        contentHash: "a".repeat(64),
        hostelId,
        key: "uploads/receipt.pdf",
        mimeType: "application/pdf",
        ownerId: new Types.ObjectId(userId),
        uploadCompletedAt: new Date(),
      }),
    );

    await submitClaim(invoiceId.toString(), input, principal);

    expect(mocks.readEvidenceText).toHaveBeenCalledWith(
      expect.anything(),
      "application/pdf",
    );
    expect(mocks.appendEvent.mock.calls[0][0].reviewFlags).toEqual([
      "EVIDENCE_TEXT_MATCHES_CLAIM",
      "EVIDENCE_PAYEE_VERIFIED",
      "EVIDENCE_TXN_ID_SHAPE_OK",
    ]);
  });
});

describe("submitClaim — a transaction id that cannot be one", () => {
  it("rejects a placeholder before anything else looks at it", async () => {
    await expect(
      submitClaim(
        invoiceId.toString(),
        { ...input, transactionCode: "dummy" },
        principal,
      ),
    ).rejects.toMatchObject({ errorCode: "TXN_ID_NOT_PLAUSIBLE" });

    expectNothingQueued();
  });

  it("requires an id from a method that issues one", async () => {
    await expect(
      submitClaim(
        invoiceId.toString(),
        { ...input, transactionCode: undefined },
        principal,
      ),
    ).rejects.toMatchObject({ errorCode: "TXN_ID_REQUIRED" });

    expectNothingQueued();
  });

  it("does not apply the shape rules to a cash handover", async () => {
    // For cash the same field is labelled "Who did you give the cash to?" and
    // holds a warden's name, which fails every rule by design.
    const result = await submitClaim(
      invoiceId.toString(),
      {
        ...input,
        paymentMethod: "CASH" as const,
        transactionCode: "Ram Bahadur",
      },
      principal,
    );

    expect(result.status).toBe("PENDING");
  });
});

describe("submitClaim — a foreign asset", () => {
  it("rejects an asset owned by somebody else", async () => {
    mocks.assetFindOne.mockReturnValue(
      lean({
        _id: assetId,
        hostelId,
        ownerId: new Types.ObjectId(),
        uploadCompletedAt: new Date(),
      }),
    );

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toMatchObject({ errorCode: "ASSET_NOT_OWNED" });

    expectNothingQueued();
  });

  it("rejects an asset belonging to another hostel", async () => {
    mocks.assetFindOne.mockReturnValue(
      lean({
        _id: assetId,
        hostelId: new Types.ObjectId(),
        ownerId: new Types.ObjectId(userId),
        uploadCompletedAt: new Date(),
      }),
    );

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toMatchObject({ errorCode: "ASSET_NOT_OWNED" });

    expectNothingQueued();
  });

  it("rejects our own receipt submitted as proof of payment", async () => {
    // The circular case: a receipt is our record that the hostel *was* paid, so
    // it cannot also be the resident's evidence that they sent the money. Before
    // this check it was accepted and every claim check went green.
    mocks.assetFindOne.mockReturnValue(
      lean({
        _id: assetId,
        contentHash: "a".repeat(64),
        hostelId,
        ownerId: new Types.ObjectId(userId),
        systemDocumentKind: "RECEIPT",
        uploadCompletedAt: new Date(),
      }),
    );

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toMatchObject({ errorCode: "EVIDENCE_IS_SYSTEM_DOCUMENT" });

    // Never reaches the owner's queue (target P7): rejecting at submission is
    // the point, and the resident is told what to upload instead.
    expectNothingQueued();
  });

  it("rejects our own statement too, with copy that names it", async () => {
    mocks.assetFindOne.mockReturnValue(
      lean({
        _id: assetId,
        contentHash: "a".repeat(64),
        hostelId,
        ownerId: new Types.ObjectId(userId),
        systemDocumentKind: "STATEMENT",
        uploadCompletedAt: new Date(),
      }),
    );

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toMatchObject({
      errorCode: "EVIDENCE_IS_SYSTEM_DOCUMENT",
      message: expect.stringContaining("statement"),
    });

    expectNothingQueued();
  });

  it("rejects an asset whose upload was never verified", async () => {
    mocks.assetFindOne.mockReturnValue(
      lean({ _id: assetId, hostelId, ownerId: new Types.ObjectId(userId) }),
    );

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toMatchObject({ errorCode: "ASSET_UPLOAD_INCOMPLETE" });

    expectNothingQueued();
  });
});

describe("submitClaim — amount out of bounds", () => {
  it("rejects an amount beyond outstanding × 1.5", async () => {
    await expect(
      submitClaim(invoiceId.toString(), { ...input, amount: 100000 }, principal),
    ).rejects.toMatchObject({ errorCode: "AMOUNT_OUT_OF_BOUNDS" });

    expectNothingQueued();
  });

  it("rejects zero and negative amounts", async () => {
    for (const amount of [0, -500]) {
      await expect(
        submitClaim(invoiceId.toString(), { ...input, amount }, principal),
      ).rejects.toMatchObject({ errorCode: "AMOUNT_OUT_OF_BOUNDS" });
    }

    expectNothingQueued();
  });

  it("allows a little over — a resident clearing a small arrear with the month", async () => {
    await expect(
      submitClaim(invoiceId.toString(), { ...input, amount: 12000 }, principal),
    ).resolves.toMatchObject({ status: "PENDING" });
  });

  it("measures against what is outstanding, not the invoice total", async () => {
    mocks.balanceFindOne.mockReturnValue(lean({ settledAmount: 9000 }));

    // 1,000 left, so 10,000 is now far out of bounds even though it equals the
    // invoice total — which is exactly the second-claim double-payment case.
    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toMatchObject({ errorCode: "AMOUNT_OUT_OF_BOUNDS" });
  });
});

describe("submitClaim — invoices that cannot take a claim", () => {
  it("refuses a paid invoice", async () => {
    mocks.invoiceFindOne.mockReturnValue(
      lean({ _id: invoiceId, hostelId, status: "PAID", totalAmount: 10000 }),
    );

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toMatchObject({ errorCode: "INVOICE_ALREADY_PAID" });

    expectNothingQueued();
  });

  it("answers NOT_FOUND for another resident's invoice", async () => {
    mocks.invoiceFindOne.mockReturnValue(lean(null));

    await expect(
      submitClaim(invoiceId.toString(), input, principal),
    ).rejects.toMatchObject({ errorCode: "INVOICE_NOT_FOUND" });

    expectNothingQueued();
  });
});

/**
 * Item E.8 — `paidAt` is not a cosmetic field.
 *
 * It becomes the event's `occurredAt`, which orders the ledger, dates the receipt
 * and decides which statement period the claim belongs to. Unbounded, a claim
 * dated next March sat permanently beyond every statement's cut-off — invisible
 * to the one bucket whose job is to notice a claim with no money behind it.
 */
describe("claimSubmitSchema — the payment date", () => {
  const body = {
    amount: 12000,
    paymentMethod: "ESEWA" as const,
    proofImageAssetId: "asset-1",
    transactionCode: "1QAXP2M",
  };

  it("accepts a payment made today", () => {
    expect(claimSubmitSchema.safeParse({ ...body, paidAt: new Date() }).success).toBe(
      true,
    );
  });

  it("refuses a date in the future", () => {
    const next = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);

    expect(claimSubmitSchema.safeParse({ ...body, paidAt: next }).success).toBe(false);
  });

  // A phone's clock and a server's disagree, and Nepal's :45 offset makes a
  // client sending local time wrong in exactly this direction.
  it("tolerates a few hours of clock skew", () => {
    const soon = new Date(Date.now() + 60 * 60 * 1000);

    expect(claimSubmitSchema.safeParse({ ...body, paidAt: soon }).success).toBe(true);
  });

  it("refuses a date more than a year old", () => {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);

    expect(claimSubmitSchema.safeParse({ ...body, paidAt: old }).success).toBe(false);
  });

  // A resident settling a genuine arrear is real, and a bound tight enough to
  // catch a typo would refuse them.
  it("accepts an arrear paid two months ago", () => {
    const then = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

    expect(claimSubmitSchema.safeParse({ ...body, paidAt: then }).success).toBe(true);
  });
});
