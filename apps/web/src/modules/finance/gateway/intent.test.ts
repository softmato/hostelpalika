/**
 * Gateway intents and settlement — Block 6 item 6.2 of
 * docs/FINANCE_IMPLEMENTATION_PLAN.md (target §6.5).
 *
 * This is the module that turns a provider's word into money, so almost every
 * test below is about **refusing** to: a callback body that claims success, a
 * verification whose amount disagrees with what we charged, a provider we could
 * not reach, an attempt that has already settled. The one happy path is short;
 * the ways it must not fire are the point.
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiPrincipal } from "@/lib/api-auth";
import { Role } from "@/lib/roles";

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1");
const residentId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0b1");
const invoiceId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0c1");
const intentId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0d1");
const eventId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0e1");

const mocks = vi.hoisted(() => ({
  appendEvent: vi.fn(),
  audit: vi.fn(),
  balanceFindOne: vi.fn(),
  createIntent: vi.fn(),
  credentials: vi.fn(),
  findCurrentResident: vi.fn(),
  intentCountDocuments: vi.fn(),
  intentCreate: vi.fn(),
  intentFind: vi.fn(),
  intentFindOne: vi.fn(),
  intentUpdateOne: vi.fn(),
  invoiceFindOne: vi.fn(),
  notifyClaimReviewed: vi.fn(),
  parseWebhook: vi.fn(),
  profileUpdateOne: vi.fn(),
  settleEvent: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/lib/site", () => ({ siteUrl: () => "https://softmato.test" }));
vi.mock("@/modules/finance/audit-finance", () => ({ auditFinanceAction: mocks.audit }));
vi.mock("@/modules/residents/resident-access", () => ({
  findCurrentResident: mocks.findCurrentResident,
}));
vi.mock("@/modules/finance/payment-event.service", () => ({
  appendEvent: mocks.appendEvent,
  settleEvent: mocks.settleEvent,
}));
vi.mock("@/modules/finance/finance-notify", () => ({
  notifyClaimReviewed: mocks.notifyClaimReviewed,
}));
vi.mock("@/modules/finance/gateway/secret-store", () => ({
  getGatewayCredentials: mocks.credentials,
}));
vi.mock("@/modules/finance/gateway/registry", () => ({
  getProvider: () => ({
    createIntent: mocks.createIntent,
    name: "ESEWA",
    parseWebhook: mocks.parseWebhook,
    reference: (raw: string) => (raw === "not json" ? null : "EDU-0001-F-1"),
    verify: mocks.verify,
  }),
}));
vi.mock("@hostel/db/models/Invoice", () => ({
  InvoiceModel: { findOne: mocks.invoiceFindOne },
}));
vi.mock("@hostel/db/models/InvoiceBalance", () => ({
  InvoiceBalanceModel: { findOne: mocks.balanceFindOne },
}));
vi.mock("@hostel/db/models/HostelPaymentProfile", () => ({
  HostelPaymentProfileModel: { updateOne: mocks.profileUpdateOne },
}));
vi.mock("@hostel/db/models/PaymentIntent", () => ({
  PaymentIntentModel: {
    countDocuments: mocks.intentCountDocuments,
    create: mocks.intentCreate,
    find: mocks.intentFind,
    findOne: mocks.intentFindOne,
    updateOne: mocks.intentUpdateOne,
  },
}));

const {
  createPaymentIntent,
  expireStaleIntents,
  getCheckoutStatus,
  handleProviderCallback,
  verifyPaymentIntent,
} = await import("./intent.service");

const principal = {
  hostelIds: [hostelId.toString()],
  role: Role.RESIDENT,
  userId: "64f0f0f0f0f0f0f0f0f0f0f1",
} as ApiPrincipal;

function lean<T>(value: T) {
  return { lean: () => Promise.resolve(value) };
}

const invoice = {
  _id: invoiceId,
  hostelId,
  referenceCode: "EDU-0001-F",
  status: "OPEN",
  totalAmount: 12000,
};

const intent = {
  _id: intentId,
  amount: 12000,
  attempt: 1,
  expiresAt: new Date("2026-08-10T10:15:00.000Z"),
  hostelId,
  invoiceId,
  mode: "SANDBOX" as const,
  provider: "ESEWA" as const,
  providerTxnId: null,
  reference: "EDU-0001-F-1",
  residentId,
  settledEventId: null,
  status: "CREATED",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findCurrentResident.mockResolvedValue({ _id: residentId, hostelId });
  mocks.invoiceFindOne.mockReturnValue(lean(invoice));
  mocks.balanceFindOne.mockReturnValue(lean(null));
  mocks.intentCountDocuments.mockResolvedValue(0);
  mocks.intentCreate.mockResolvedValue({ _id: intentId });
  mocks.intentFindOne.mockReturnValue(lean(intent));
  mocks.intentUpdateOne.mockResolvedValue({});
  mocks.profileUpdateOne.mockReturnValue({ catch: () => Promise.resolve() });
  mocks.credentials.mockResolvedValue({
    merchantCode: "EPAYTEST",
    provider: "ESEWA",
    sandbox: true,
    secret: "test-secret",
    webhookSecret: "test-secret",
  });
  mocks.createIntent.mockResolvedValue({
    expiresAt: new Date("2026-08-10T10:15:00.000Z"),
    handoff: { fields: { total_amount: "12000" }, kind: "FORM_POST", url: "https://esewa.test/form" },
    providerRef: null,
  });
  mocks.appendEvent.mockResolvedValue({ created: true, event: { _id: eventId } });
  mocks.settleEvent.mockResolvedValue({});
  mocks.audit.mockResolvedValue(undefined);
});

describe("starting a checkout", () => {
  it("charges the outstanding balance, not the invoice total", async () => {
    mocks.balanceFindOne.mockReturnValue(lean({ settledAmount: 5000 }));

    // A resident paying the second half of a part-paid month must not be sent
    // to a checkout for the whole thing.
    expect((await createPaymentIntent(invoiceId.toString(), "ESEWA", principal)).amount).toBe(
      7000,
    );
  });

  it("freezes the quoted amount onto the attempt", async () => {
    await createPaymentIntent(invoiceId.toString(), "ESEWA", principal);

    expect(mocks.intentCreate.mock.calls[0]![0]).toMatchObject({ amount: 12000 });
  });

  it("builds a per-attempt merchant reference so a retry is payable", async () => {
    // Providers reject a repeated merchant reference. Without the suffix, a
    // resident who abandoned one checkout could never pay that invoice at all.
    mocks.intentCountDocuments.mockResolvedValue(2);

    const result = await createPaymentIntent(invoiceId.toString(), "ESEWA", principal);

    expect(result.reference).toBe("EDU-0001-F-3");
    expect(mocks.intentCreate.mock.calls[0]![0]).toMatchObject({ attempt: 3 });
  });

  it("records which environment the attempt was made against", async () => {
    // A hostel that later switches to live must not retroactively relabel the
    // test payments it made on the way.
    await createPaymentIntent(invoiceId.toString(), "ESEWA", principal);

    expect(mocks.intentCreate.mock.calls[0]![0]).toMatchObject({ mode: "SANDBOX" });
  });

  it("tells the screen it is a sandbox, so it can say so", async () => {
    expect(
      (await createPaymentIntent(invoiceId.toString(), "ESEWA", principal)).sandbox,
    ).toBe(true);
  });

  it("moves no money", async () => {
    await createPaymentIntent(invoiceId.toString(), "ESEWA", principal);

    expect(mocks.appendEvent).not.toHaveBeenCalled();
    expect(mocks.settleEvent).not.toHaveBeenCalled();
  });

  it("refuses an invoice that is already paid", async () => {
    mocks.balanceFindOne.mockReturnValue(lean({ settledAmount: 12000 }));

    await expect(
      createPaymentIntent(invoiceId.toString(), "ESEWA", principal),
    ).rejects.toMatchObject({ errorCode: "INVOICE_ALREADY_PAID" });
  });

  it("refuses an invoice with no reference code to build one from", async () => {
    mocks.invoiceFindOne.mockReturnValue(lean({ ...invoice, referenceCode: undefined }));

    await expect(
      createPaymentIntent(invoiceId.toString(), "ESEWA", principal),
    ).rejects.toMatchObject({ errorCode: "REFERENCE_PREFIX_MISSING" });
  });

  it("answers NOT_FOUND for another resident's invoice, and for a void one", async () => {
    mocks.invoiceFindOne.mockReturnValue(lean(null));
    await expect(
      createPaymentIntent(invoiceId.toString(), "ESEWA", principal),
    ).rejects.toMatchObject({ errorCode: "INVOICE_NOT_FOUND" });

    mocks.invoiceFindOne.mockReturnValue(lean({ ...invoice, status: "VOID" }));
    await expect(
      createPaymentIntent(invoiceId.toString(), "ESEWA", principal),
    ).rejects.toMatchObject({ errorCode: "INVOICE_NOT_FOUND" });
  });

  /**
   * Credentials are resolved before anything is written, so a half-configured
   * hostel fails with nothing persisted rather than leaving an attempt nobody
   * can ever complete.
   */
  it("writes no attempt when the gateway cannot be resolved", async () => {
    mocks.credentials.mockRejectedValue(
      Object.assign(new Error("nope"), { errorCode: "GATEWAY_NOT_CONFIGURED" }),
    );

    await expect(
      createPaymentIntent(invoiceId.toString(), "ESEWA", principal),
    ).rejects.toThrow();
    expect(mocks.intentCreate).not.toHaveBeenCalled();
  });

  it("gives the provider our callback URL, not the resident's return URL", async () => {
    await createPaymentIntent(invoiceId.toString(), "ESEWA", principal);

    const request = mocks.createIntent.mock.calls[0]![0];

    expect(request.callbackUrl).toBe("https://softmato.test/api/v1/webhooks/esewa");
    expect(request.returnUrl).toContain("/resident/payments/checkout/EDU-0001-F-1");
  });
});

describe("verifying an attempt", () => {
  const success = { amount: 12000, providerTxnId: "ESW-77123", status: "SUCCESS" as const };

  it("settles when the provider agrees on the amount", async () => {
    mocks.verify.mockResolvedValue(success);

    const outcome = await verifyPaymentIntent(intentId);

    expect(outcome.settled).toBe(true);
    expect(mocks.settleEvent).toHaveBeenCalledWith(
      eventId,
      expect.objectContaining({ confirmation: "GATEWAY_VERIFIED" }),
    );
  });

  it("keys the credit by the provider's transaction id", async () => {
    // Two attempts that somehow resolve to one provider transaction must
    // collapse to one credit. The unique index on this key is what does it.
    mocks.verify.mockResolvedValue(success);

    await verifyPaymentIntent(intentId);

    expect(mocks.appendEvent.mock.calls[0]![0]).toMatchObject({
      confirmation: "GATEWAY_VERIFIED",
      idempotencyKey: "gateway:ESEWA:ESW-77123",
      providerTxnId: "ESW-77123",
    });
  });

  /**
   * The strictest rule here. A disagreement means the resident was charged
   * something other than what we showed them, or a callback was replayed against
   * the wrong attempt — neither is resolved by trusting the larger figure.
   */
  it("does not settle when the provider's amount disagrees", async () => {
    mocks.verify.mockResolvedValue({ ...success, amount: 1 });

    const outcome = await verifyPaymentIntent(intentId);

    expect(outcome.settled).toBe(false);
    expect(mocks.appendEvent).not.toHaveBeenCalled();
    expect(mocks.settleEvent).not.toHaveBeenCalled();
  });

  it("records a disagreement where a human will find it", async () => {
    mocks.verify.mockResolvedValue({ ...success, amount: 100 });

    await verifyPaymentIntent(intentId);

    const entry = mocks.audit.mock.calls[0]![1];

    expect(entry.action).toBe("GATEWAY_AMOUNT_MISMATCH");
    expect(entry.amountBefore).toBe(12000);
    expect(entry.amountAfter).toBe(100);
  });

  it("does not settle a payment the provider says failed", async () => {
    mocks.verify.mockResolvedValue({ ...success, status: "FAILED" });

    const outcome = await verifyPaymentIntent(intentId);

    expect(outcome.settled).toBe(false);
    expect(outcome.status).toBe("FAILED");
    expect(mocks.appendEvent).not.toHaveBeenCalled();
  });

  /**
   * PENDING is not a failure — the resident may still be on the provider's
   * screen — so the attempt stays open rather than being closed against them.
   */
  it("leaves a pending attempt open", async () => {
    mocks.verify.mockResolvedValue({ ...success, status: "PENDING" });

    const outcome = await verifyPaymentIntent(intentId);

    expect(outcome.settled).toBe(false);
    const closed = mocks.intentUpdateOne.mock.calls.some(
      (call) => call[1]?.$set?.status === "FAILED",
    );

    expect(closed).toBe(false);
  });

  it("returns the existing credit for an attempt that already settled", async () => {
    mocks.intentFindOne.mockReturnValue(
      lean({ ...intent, settledEventId: eventId, status: "SUCCEEDED" }),
    );

    const outcome = await verifyPaymentIntent(intentId);

    expect(outcome).toMatchObject({ eventId: eventId.toString(), settled: true });
    // No second call to the provider, and no second credit.
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.appendEvent).not.toHaveBeenCalled();
  });

  it("does not settle twice when the ledger says the credit already exists", async () => {
    mocks.verify.mockResolvedValue(success);
    mocks.appendEvent.mockResolvedValue({ created: false, event: { _id: eventId } });

    const outcome = await verifyPaymentIntent(intentId);

    expect(outcome.settled).toBe(true);
    expect(mocks.settleEvent).not.toHaveBeenCalled();
    // A replay must not email the resident a second time.
    expect(mocks.notifyClaimReviewed).not.toHaveBeenCalled();
  });

  it("emails the resident their certified receipt once it settles", async () => {
    mocks.verify.mockResolvedValue(success);
    mocks.settleEvent.mockResolvedValue({
      balance: { settledAmount: 12000 },
      receipt: { _id: eventId, certificationCode: "HP-7K2M-9QXD-4TRA", receiptNumber: "RCP-1" },
    });

    await verifyPaymentIntent(intentId);

    expect(mocks.notifyClaimReviewed).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: expect.objectContaining({
          certificationCode: "HP-7K2M-9QXD-4TRA",
          kind: "verified",
          receiptNumber: "RCP-1",
          verifiedAmount: 12000,
        }),
      }),
    );
  });

  it("still reports the payment settled when the email fails", async () => {
    mocks.verify.mockResolvedValue(success);
    mocks.notifyClaimReviewed.mockRejectedValueOnce(new Error("SMTP down"));

    expect((await verifyPaymentIntent(intentId)).settled).toBe(true);
  });

  /**
   * An unreachable provider is not a failed payment, and recording it as one
   * would close an attempt the resident may have completed.
   */
  it("leaves the attempt open when the provider cannot be reached", async () => {
    mocks.verify.mockRejectedValue(new Error("ECONNRESET"));

    await expect(verifyPaymentIntent(intentId)).rejects.toMatchObject({
      errorCode: "GATEWAY_UNREACHABLE",
    });

    const closed = mocks.intentUpdateOne.mock.calls.some((call) =>
      ["EXPIRED", "FAILED"].includes(call[1]?.$set?.status),
    );

    expect(closed).toBe(false);
  });

  it("answers NOT_FOUND for an attempt that does not exist", async () => {
    mocks.intentFindOne.mockReturnValue(lean(null));

    await expect(verifyPaymentIntent(intentId)).rejects.toMatchObject({
      errorCode: "INTENT_NOT_FOUND",
    });
  });

  it("closes a settled attempt against a concurrent sweep", async () => {
    mocks.verify.mockResolvedValue({ ...success, status: "FAILED" });

    await verifyPaymentIntent(intentId);

    // Filtered on the open status, so a verification that settled concurrently
    // cannot be overwritten by a sweep that started before it.
    const close = mocks.intentUpdateOne.mock.calls.find(
      (call) => call[1]?.$set?.status === "FAILED",
    );

    expect(close![0]).toMatchObject({ status: "CREATED" });
  });
});

describe("a provider callback", () => {
  beforeEach(() => {
    mocks.parseWebhook.mockReturnValue({
      amount: 12000,
      providerTxnId: "ESW-77123",
      reference: "EDU-0001-F-1",
    });
    mocks.verify.mockResolvedValue({
      amount: 12000,
      providerTxnId: "ESW-77123",
      status: "SUCCESS",
    });
  });

  it("settles only after asking the provider directly", async () => {
    await handleProviderCallback("ESEWA", "{}", {});

    // The body said SUCCESS too, but it is not what settled — target §6.5 step
    // 7c. A signature proves who sent the message, not that money moved.
    expect(mocks.verify).toHaveBeenCalled();
    expect(mocks.appendEvent).toHaveBeenCalled();
  });

  /**
   * The body's own numbers are used for exactly one thing: identifying which
   * attempt this is about. A callback claiming a larger amount settles the
   * verified one, or nothing.
   */
  it("ignores the amount the body claims", async () => {
    mocks.parseWebhook.mockReturnValue({
      amount: 999999,
      providerTxnId: "ESW-77123",
      reference: "EDU-0001-F-1",
    });

    await handleProviderCallback("ESEWA", "{}", {});

    expect(mocks.appendEvent.mock.calls[0]![0]).toMatchObject({ amount: 12000 });
  });

  it("rejects a callback whose signature does not verify", async () => {
    // The reference is read unchecked to find the hostel; only the parse with
    // that hostel's key may be acted on.
    mocks.parseWebhook.mockReturnValueOnce(null);

    await expect(handleProviderCallback("ESEWA", "{}", {})).rejects.toMatchObject({
      errorCode: "GATEWAY_VERIFICATION_FAILED",
    });
    expect(mocks.appendEvent).not.toHaveBeenCalled();
  });

  it("drops a callback for a reference we never issued", async () => {
    // Not an error: a provider that retries on non-2xx would otherwise hammer us
    // forever over a reference that does not exist, which is also what a probe
    // looks like.
    mocks.intentFindOne.mockReturnValue(lean(null));

    const outcome = await handleProviderCallback("ESEWA", "{}", {});

    expect(outcome).toMatchObject({ intentId: null, settled: false });
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("drops an unparseable body without reaching the database", async () => {
    mocks.parseWebhook.mockReturnValue(null);

    expect((await handleProviderCallback("ESEWA", "not json", {})).settled).toBe(false);
  });

  it("records that the provider is alive", async () => {
    // Silence here alongside open invoices is the only thing separating "the
    // webhook broke a week ago" from "nobody paid this month".
    await handleProviderCallback("ESEWA", "{}", {});

    expect(mocks.profileUpdateOne).toHaveBeenCalled();
  });
});

/**
 * The screen the resident lands on after leaving the provider. Its URL is
 * guessable and carries no authority of its own, which is the whole reason these
 * assertions exist.
 */
describe("the checkout status screen", () => {
  const success = { amount: 12000, providerTxnId: "ESW-77123", status: "SUCCESS" as const };

  it("settles only through the provider, never by being visited", async () => {
    mocks.verify.mockResolvedValue(success);

    const status = await getCheckoutStatus("EDU-0001-F-1", principal);

    // Visiting the URL triggered a verification; the verification settled it.
    // Had `verify` said PENDING, nothing would have moved.
    expect(mocks.verify).toHaveBeenCalled();
    expect(status.settled).toBe(true);
  });

  it("moves nothing when the provider has not agreed", async () => {
    mocks.verify.mockResolvedValue({ ...success, status: "PENDING" });

    expect((await getCheckoutStatus("EDU-0001-F-1", principal)).settled).toBe(false);
    expect(mocks.settleEvent).not.toHaveBeenCalled();
  });

  it("scopes the attempt to the calling resident", async () => {
    // A guessable reference must not be an oracle for anyone else's attempts.
    await getCheckoutStatus("EDU-0001-F-1", principal);

    expect(mocks.intentFindOne.mock.calls[0]![0]).toMatchObject({
      hostelId,
      reference: "EDU-0001-F-1",
      residentId,
    });
  });

  it("answers NOT_FOUND for a reference that is not theirs", async () => {
    mocks.intentFindOne.mockReturnValue(lean(null));

    await expect(getCheckoutStatus("EDU-9999-Z-1", principal)).rejects.toMatchObject({
      errorCode: "INTENT_NOT_FOUND",
    });
  });

  /**
   * The screen polls while the resident is on the provider's page, and every
   * poll would otherwise be a call to the provider. Being rate-limited is
   * indistinguishable from being down at the moment it matters most.
   */
  it("does not call the provider again within the cooldown", async () => {
    mocks.intentFindOne.mockReturnValue(lean({ ...intent, lastVerifiedAt: new Date() }));

    await getCheckoutStatus("EDU-0001-F-1", principal);

    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("keeps polling rather than showing a failure it cannot evidence", async () => {
    mocks.verify.mockRejectedValue(new Error("ETIMEDOUT"));

    const status = await getCheckoutStatus("EDU-0001-F-1", principal);

    expect(status.status).toBe("CREATED");
    expect(status.settled).toBe(false);
  });

  it("tells the screen when a test merchant is in use", async () => {
    mocks.verify.mockResolvedValue({ ...success, status: "PENDING" });

    expect((await getCheckoutStatus("EDU-0001-F-1", principal)).sandbox).toBe(true);
  });
});

describe("expiring stale attempts", () => {
  function staleFind(rows: unknown[]) {
    const chain = {
      lean: () => Promise.resolve(rows),
      limit: () => chain,
      sort: () => chain,
    };

    return chain;
  }

  it("asks the provider before writing anything off", async () => {
    mocks.intentFind.mockReturnValue(staleFind([intent]));
    mocks.verify.mockResolvedValue({
      amount: 0,
      providerTxnId: "",
      status: "PENDING",
    });

    const result = await expireStaleIntents({ now: new Date("2026-08-10T11:00:00Z") });

    expect(mocks.verify).toHaveBeenCalled();
    expect(result.expired).toBe(1);
  });

  /**
   * The failure this exists to prevent: our callback endpoint is down for an
   * hour, a resident pays successfully, and a clock-only sweep writes their
   * payment off as abandoned.
   */
  it("settles a payment that succeeded while the callback was down", async () => {
    mocks.intentFind.mockReturnValue(staleFind([intent]));
    mocks.verify.mockResolvedValue({
      amount: 12000,
      providerTxnId: "ESW-77123",
      status: "SUCCESS",
    });

    const result = await expireStaleIntents();

    expect(result).toEqual({ expired: 0, settled: 1, unconfirmed: 0 });
    expect(mocks.settleEvent).toHaveBeenCalled();
  });

  it("leaves a row alone when the provider cannot be reached", async () => {
    mocks.intentFind.mockReturnValue(staleFind([intent]));
    mocks.verify.mockRejectedValue(new Error("ETIMEDOUT"));

    // An unreachable provider is not evidence the payment failed, so the row
    // waits for the next run rather than being expired on a guess.
    expect(await expireStaleIntents()).toEqual({
      expired: 0,
      settled: 0,
      unconfirmed: 0,
    });
  });

  /**
   * Not forever, though. An attempt nobody can ever confirm would otherwise be
   * re-queried every five minutes indefinitely and — worse — sit in `CREATED`
   * looking like a payment still in progress.
   */
  it("gives up on an attempt it has failed to confirm for a day", async () => {
    mocks.intentFind.mockReturnValue(
      staleFind([
        {
          ...intent,
          expiresAt: new Date("2026-08-08T10:00:00.000Z"),
          verifyCount: 40,
        },
      ]),
    );
    mocks.verify.mockRejectedValue(new Error("ETIMEDOUT"));

    const result = await expireStaleIntents({ now: new Date("2026-08-10T12:00:00Z") });

    expect(result.unconfirmed).toBe(1);

    // Closed with a reason that claims no knowledge — "failed" and "expired"
    // both assert something we do not know.
    const close = mocks.intentUpdateOne.mock.calls.find(
      (call) => call[1]?.$set?.status === "EXPIRED",
    );

    expect(close![1].$set.failureReason).toContain("never confirmed");
    expect(close![1].$set.failureReason).toContain("by hand");
  });

  it("does not give up on one that is merely old, if we have barely asked", async () => {
    // A provider down for an afternoon must not be mistaken for an attempt that
    // can never be resolved.
    mocks.intentFind.mockReturnValue(
      staleFind([
        { ...intent, expiresAt: new Date("2026-08-08T10:00:00.000Z"), verifyCount: 2 },
      ]),
    );
    mocks.verify.mockRejectedValue(new Error("ETIMEDOUT"));

    expect(
      (await expireStaleIntents({ now: new Date("2026-08-10T12:00:00Z") })).unconfirmed,
    ).toBe(0);
  });

  it("does not give up inside the grace period however often it has asked", async () => {
    mocks.intentFind.mockReturnValue(staleFind([{ ...intent, verifyCount: 99 }]));
    mocks.verify.mockRejectedValue(new Error("ETIMEDOUT"));

    expect(
      (await expireStaleIntents({ now: new Date("2026-08-10T11:00:00Z") })).unconfirmed,
    ).toBe(0);
  });

  /**
   * Without an order, a hostel generating attempts faster than the batch size
   * would starve its own oldest rows forever — and the oldest are exactly the
   * ones a resident has been staring at.
   */
  it("takes the oldest attempts first", async () => {
    const chain = staleFind([]);
    const sort = vi.spyOn(chain, "sort");

    mocks.intentFind.mockReturnValue(chain);

    await expireStaleIntents();

    expect(sort).toHaveBeenCalledWith({ expiresAt: 1 });
  });

  it("only looks at open attempts past their window", async () => {
    mocks.intentFind.mockReturnValue(staleFind([]));
    const now = new Date("2026-08-10T11:00:00.000Z");

    await expireStaleIntents({ now });

    expect(mocks.intentFind.mock.calls[0]![0]).toEqual({
      expiresAt: { $lt: now },
      status: "CREATED",
    });
  });
});
