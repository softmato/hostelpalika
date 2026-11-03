import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { siteUrl } from "@/lib/site";
import { auditFinanceAction } from "@/modules/finance/audit-finance";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { notifyClaimReviewed } from "@/modules/finance/finance-notify";
import { getGatewayCredentials } from "@/modules/finance/gateway/secret-store";
import { getProvider } from "@/modules/finance/gateway/registry";
import type {
  GatewayProviderName,
  IntentHandoff,
  VerificationResult,
} from "@/modules/finance/gateway/provider.types";
import { appendEvent, settleEvent } from "@/modules/finance/payment-event.service";
import { findCurrentResident } from "@/modules/residents/resident-access";
import { InvoiceBalanceModel } from "@hostel/db/models/InvoiceBalance";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { HostelPaymentProfileModel } from "@hostel/db/models/HostelPaymentProfile";
import { PaymentIntentModel } from "@hostel/db/models/PaymentIntent";

/**
 * The one path from "a resident tapped pay" to money on the ledger
 * (target §6.5, plan item 6.2).
 *
 * Every adapter shares it, and the rules it enforces are the ones that decide
 * whether this module can be trusted with somebody's rent:
 *
 * 1. **Only {@link verifyPaymentIntent} settles.** Not the callback, not the
 *    return URL, not the resident's screen. Each of those can *trigger* a
 *    verification; none of them is evidence.
 * 2. **A verified success still has to match.** The provider's amount must equal
 *    what we asked for. A disagreement is recorded and left unsettled, because
 *    the alternative is crediting an invoice for money that did not arrive.
 * 3. **Settling is idempotent through the ledger, not through a check here.**
 *    The event's `idempotencyKey` is `gateway:{provider}:{providerTxnId}`, and
 *    the unique index on it is what makes a replayed callback a no-op. A
 *    read-then-write guard in this file would have a race; the index does not.
 */

/** How long a checkout stays payable when the provider does not say otherwise. */
const DEFAULT_INTENT_TTL_MS = 15 * 60 * 1000;

export type PaymentIntentView = {
  amount: number;
  expiresAt: string;
  handoff: IntentHandoff;
  intentId: string;
  provider: GatewayProviderName;
  reference: string;
  /** True while a test merchant is in use. The screen must say so, loudly. */
  sandbox: boolean;
  status: string;
};

type IntentRecord = {
  _id: Types.ObjectId;
  amount: number;
  attempt: number;
  expiresAt: Date;
  hostelId: Types.ObjectId;
  invoiceId: Types.ObjectId;
  mode: "LIVE" | "SANDBOX";
  provider: GatewayProviderName;
  providerTxnId?: string | null;
  reference: string;
  residentId: Types.ObjectId;
  settledEventId?: Types.ObjectId | null;
  status: string;
};

/**
 * The resident's "payment verified" email for an eSewa/Khalti checkout — the
 * same one a warden's approval sends, receipt attached. A checkout is started
 * from the invoice, so it carries its code and its receipt is certified: the
 * email says it went into the Resident Offer Program.
 *
 * **Never throws.** The money has settled and the intent is marked; a mail
 * server having a bad day must not turn that into an error on the pay screen.
 */
async function notifyGatewayPayment(
  intent: IntentRecord,
  amount: number,
  settled: Awaited<ReturnType<typeof settleEvent>> | undefined,
) {
  try {
    const invoice = await InvoiceModel.findOne({ _id: intent.invoiceId }).lean<{
      period?: string | null;
      totalAmount: number;
    } | null>();

    await notifyClaimReviewed({
      hostelId: intent.hostelId,
      invoiceId: intent.invoiceId.toString(),
      outcome: {
        certificationCode: settled?.receipt?.certificationCode ?? null,
        kind: "verified",
        method: intent.provider,
        receiptId: settled?.receipt?._id ?? null,
        receiptNumber: settled?.receipt?.receiptNumber ?? null,
        remainingAmount: Math.max(
          (invoice?.totalAmount ?? 0) - (settled?.balance?.settledAmount ?? 0),
          0,
        ),
        verifiedAmount: amount,
      },
      period: invoice?.period ?? null,
      residentId: intent.residentId,
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        action: "gateway_payment_notification_failed",
        intentId: intent._id.toString(),
        level: "warn",
        message: error instanceof Error ? error.message : "Unknown notification error",
      }),
    );
  }
}

/**
 * Starts a checkout.
 *
 * The amount is the invoice's **outstanding** balance read at this moment, never
 * its total: a resident paying the second half of a part-paid month must not be
 * sent to a checkout for the whole thing. It is frozen onto the intent because
 * the verification compares against it — if the outstanding changed while the
 * resident was on the provider's screen, we still owe them the price we quoted.
 */
export async function createPaymentIntent(
  invoiceId: string,
  provider: GatewayProviderName,
  principal: ApiPrincipal,
): Promise<PaymentIntentView> {
  await connectToDatabase();

  const resident = await findCurrentResident(principal);

  const invoice = await InvoiceModel.findOne({
    _id: Types.ObjectId.isValid(invoiceId) ? invoiceId : new Types.ObjectId(),
    hostelId: resident.hostelId,
    residentId: resident._id,
  }).lean<{
    _id: Types.ObjectId;
    hostelId: Types.ObjectId;
    referenceCode?: string;
    status: string;
    totalAmount: number;
  } | null>();

  // Out of scope and non-existent answer identically (RULES.md §3).
  if (!invoice || invoice.status === "VOID") {
    throw new FinanceServiceError("Invoice was not found.", "INVOICE_NOT_FOUND");
  }

  if (!invoice.referenceCode) {
    // Migrated invoices (item 2.4) carry no code, and the merchant reference is
    // built from it. Without one there is nothing to tie a callback back to.
    throw new FinanceServiceError(
      "This invoice cannot be paid online. Please use one of the manual methods.",
      "REFERENCE_PREFIX_MISSING",
    );
  }

  const balance = await InvoiceBalanceModel.findOne({
    invoiceId: invoice._id,
  }).lean<{ settledAmount?: number } | null>();

  const amount = Math.max(0, invoice.totalAmount - (balance?.settledAmount ?? 0));

  if (amount <= 0) {
    throw new FinanceServiceError(
      "This invoice is already paid.",
      "INVOICE_ALREADY_PAID",
    );
  }

  // Resolving credentials before creating the row means a hostel whose gateway
  // is half-configured fails here, with nothing written, rather than leaving an
  // intent nobody can ever complete.
  const credentials = await getGatewayCredentials(resident.hostelId, provider);
  const adapter = getProvider(provider);

  const attempt =
    (await PaymentIntentModel.countDocuments({
      invoiceId: invoice._id,
      provider,
    })) + 1;
  const reference = `${invoice.referenceCode}-${attempt}`;
  const base = siteUrl();

  const intent = await adapter.createIntent({
    amount,
    attempt,
    callbackUrl: `${base}/api/v1/webhooks/${provider.toLowerCase()}`,
    credentials,
    failureUrl: `${base}/resident/payments/checkout/${reference}?outcome=failed`,
    invoiceId: invoice._id.toString(),
    reference,
    referenceCode: invoice.referenceCode,
    returnUrl: `${base}/resident/payments/checkout/${reference}`,
  });

  const expiresAt = intent.expiresAt ?? new Date(Date.now() + DEFAULT_INTENT_TTL_MS);

  const created = (await PaymentIntentModel.create({
    amount,
    attempt,
    createdBy: principal.userId,
    expiresAt,
    hostelId: resident.hostelId,
    invoiceId: invoice._id,
    mode: credentials.sandbox ? "SANDBOX" : "LIVE",
    provider,
    providerTxnId: intent.providerRef,
    reference,
    residentId: resident._id,
    status: "CREATED",
  })) as unknown as IntentRecord;

  return {
    amount,
    expiresAt: expiresAt.toISOString(),
    handoff: intent.handoff,
    intentId: created._id.toString(),
    provider,
    reference,
    sandbox: credentials.sandbox,
    status: "CREATED",
  };
}

export type VerifyOutcome = {
  /** The ledger event, when this verification produced one. */
  eventId: string | null;
  /** Why it did not settle, when it did not. */
  reason: string | null;
  settled: boolean;
  status: string;
};

/**
 * Asks the provider what happened, and settles only if they agree.
 *
 * **This is the only function in the codebase that turns a gateway payment into
 * money.** Everything else — the callback receiver, the resident's polling
 * screen, the expiry sweep — calls it. Concentrating it here is what makes the
 * rules above enforceable rather than repeated.
 *
 * Safe to call repeatedly and from several places at once: an already-settled
 * intent returns its existing event, and a concurrent duplicate collides on the
 * ledger's unique index rather than crediting twice.
 */
export async function verifyPaymentIntent(
  intentId: Types.ObjectId | string,
  options: { principal?: ApiPrincipal; source?: "GATEWAY_WEBHOOK" | "GATEWAY_POLL" } = {},
): Promise<VerifyOutcome> {
  await connectToDatabase();

  const intent = await PaymentIntentModel.findOne({
    _id: Types.ObjectId.isValid(String(intentId)) ? intentId : new Types.ObjectId(),
  }).lean<IntentRecord | null>();

  if (!intent) {
    throw new FinanceServiceError("Payment attempt was not found.", "INTENT_NOT_FOUND");
  }

  // Already done. Returning the existing event rather than re-asking keeps a
  // retried callback cheap and keeps the provider's rate limits ours to spend.
  if (intent.status === "SUCCEEDED" && intent.settledEventId) {
    return {
      eventId: intent.settledEventId.toString(),
      reason: null,
      settled: true,
      status: "SUCCEEDED",
    };
  }

  const credentials = await getGatewayCredentials(intent.hostelId, intent.provider);
  const adapter = getProvider(intent.provider);

  let result: VerificationResult;

  try {
    result = await adapter.verify(
      {
        amount: intent.amount,
        providerTxnId: intent.providerTxnId ?? null,
        reference: intent.reference,
      },
      credentials,
    );
  } catch (error) {
    // The provider being unreachable is not the same as the payment failing, and
    // must never be recorded as one. The intent stays open for the next attempt
    // — the sweep, the resident's next poll, or a retried callback.
    await PaymentIntentModel.updateOne(
      { _id: intent._id },
      { $inc: { verifyCount: 1 }, $set: { lastVerifiedAt: new Date() } },
    );

    throw error instanceof FinanceServiceError
      ? error
      : new FinanceServiceError(
          "Could not reach the payment provider. Please try again in a moment.",
          "GATEWAY_UNREACHABLE",
        );
  }

  const now = new Date();

  await PaymentIntentModel.updateOne(
    { _id: intent._id },
    {
      $inc: { verifyCount: 1 },
      $set: {
        lastVerifiedAt: now,
        ...(result.providerTxnId ? { providerTxnId: result.providerTxnId } : {}),
      },
    },
  );

  if (result.status !== "SUCCESS") {
    // PENDING is not a failure — the resident may still be on the provider's
    // screen — so only an explicit refusal closes the attempt.
    if (result.status === "FAILED") {
      await closeIntent(intent, "FAILED", "The provider reported a failed payment.");
    }

    return {
      eventId: null,
      reason: null,
      settled: false,
      status: result.status === "FAILED" ? "FAILED" : intent.status,
    };
  }

  /**
   * The provider agreed, but on a different number. This is the case worth
   * being strict about: it means the resident was charged something other than
   * what we showed them, or a callback was replayed against the wrong attempt.
   * Neither is something to resolve by trusting the larger figure.
   */
  if (result.amount !== intent.amount) {
    const reason =
      `Provider reported NPR ${result.amount} for an attempt raised at ` +
      `NPR ${intent.amount}. Not settled — review manually.`;

    await closeIntent(intent, "FAILED", reason);

    await auditFinanceAction(options.principal ?? systemPrincipal(intent), {
      action: "GATEWAY_AMOUNT_MISMATCH",
      amountAfter: result.amount,
      amountBefore: intent.amount,
      entityId: intent._id,
      entityType: "PaymentIntent",
      hostelId: intent.hostelId,
      invoiceId: intent.invoiceId.toString(),
      reason,
      source: "GATEWAY_VERIFICATION",
    });

    return { eventId: null, reason, settled: false, status: "FAILED" };
  }

  const { event, created } = await appendEvent({
    amount: result.amount,
    confirmation: "GATEWAY_VERIFIED",
    hostelId: intent.hostelId,
    // The provider's own id, not ours: two attempts that somehow resolve to one
    // provider transaction must collapse to one credit.
    idempotencyKey: `gateway:${intent.provider}:${result.providerTxnId}`,
    invoiceId: intent.invoiceId,
    occurredAt: now,
    provider: intent.provider,
    providerTxnId: result.providerTxnId,
    referenceCode: intent.reference,
    residentId: intent.residentId,
    source: options.source ?? "GATEWAY_POLL",
    status: "PENDING",
  });

  // A replay: the credit already exists. Point the intent at it and stop. A
  // replay whose event is still PENDING (a call that died between the append
  // and the settle) is settled below, or it never reaches the invoice (P8-6).
  if (!created && event.status !== "PENDING") {
    await markSucceeded(intent, event._id, now);

    return {
      eventId: event._id.toString(),
      reason: null,
      settled: true,
      status: "SUCCEEDED",
    };
  }

  let settled: Awaited<ReturnType<typeof settleEvent>> | undefined;

  try {
    settled = await settleEvent(event._id, {
      confirmation: "GATEWAY_VERIFIED",
      principal: options.principal,
      settledAt: now,
    });
  } catch (error) {
    // A concurrent replay settled it first: that call sends the email.
    if (created || !(error instanceof FinanceServiceError) || error.errorCode !== "SETTLED_EVENT_IMMUTABLE") {
      throw error;
    }
  }

  await markSucceeded(intent, event._id, now);

  if (!settled) {
    return { eventId: event._id.toString(), reason: null, settled: true, status: "SUCCEEDED" };
  }

  // Only on the call that settled it — a replay above returns before here, so a
  // retried callback never sends the email twice.
  await notifyGatewayPayment(intent, result.amount, settled);

  return {
    eventId: event._id.toString(),
    reason: null,
    settled: true,
    status: "SUCCEEDED",
  };
}

/**
 * The shortest gap between two verifications of the same attempt.
 *
 * The resident's screen polls while they are on the provider's page, and every
 * poll would otherwise be a call to the provider. Providers rate-limit, and
 * being rate-limited is indistinguishable from being down at the moment it
 * matters most. Two seconds is faster than anyone perceives and an order of
 * magnitude fewer calls.
 */
const VERIFY_COOLDOWN_MS = 2_000;

export type CheckoutStatus = {
  amount: number;
  expiresAt: string;
  invoiceId: string;
  provider: GatewayProviderName;
  reference: string;
  sandbox: boolean;
  settled: boolean;
  status: string;
};

/**
 * What the resident's "checking…" screen reads.
 *
 * **The return URL settles nothing, and neither does this.** It asks
 * {@link verifyPaymentIntent}, which asks the provider — the same authority a
 * callback would go through. The distinction matters because the return URL is
 * guessable and carries no authority whatsoever; the only reason a payment
 * settles on this path is that the provider was asked and agreed.
 *
 * A provider we cannot reach leaves the attempt open and the screen polling,
 * rather than showing the resident a failure we have no evidence for.
 */
export async function getCheckoutStatus(
  reference: string,
  principal: ApiPrincipal,
): Promise<CheckoutStatus> {
  await connectToDatabase();

  const resident = await findCurrentResident(principal);

  const intent = await PaymentIntentModel.findOne({
    hostelId: resident.hostelId,
    reference,
    residentId: resident._id,
  }).lean<(IntentRecord & { lastVerifiedAt?: Date }) | null>();

  if (!intent) {
    throw new FinanceServiceError("Payment attempt was not found.", "INTENT_NOT_FOUND");
  }

  let status = intent.status;
  let settled = Boolean(intent.settledEventId);

  const cooledDown =
    !intent.lastVerifiedAt ||
    Date.now() - new Date(intent.lastVerifiedAt).getTime() > VERIFY_COOLDOWN_MS;

  if (status === "CREATED" && cooledDown) {
    try {
      const outcome = await verifyPaymentIntent(intent._id, { source: "GATEWAY_POLL" });

      settled = outcome.settled;
      status = outcome.status;
    } catch {
      // Unreachable provider, or credentials that stopped resolving. Neither is
      // evidence of anything, so the screen keeps its current state and polls on.
    }
  }

  return {
    amount: intent.amount,
    expiresAt: new Date(intent.expiresAt).toISOString(),
    invoiceId: intent.invoiceId.toString(),
    provider: intent.provider,
    reference: intent.reference,
    sandbox: intent.mode === "SANDBOX",
    settled,
    status,
  };
}

/**
 * Resolves a provider callback to an intent, then verifies it.
 *
 * The body is used for exactly one thing: working out **which attempt** this is
 * about. Its amount and its status are read, logged and then discarded, because
 * a signature proves the message came from the provider and says nothing about
 * whether the payment succeeded or for how much. Target §6.5 step 7c.
 */
export async function handleProviderCallback(
  provider: GatewayProviderName,
  rawBody: string,
  headers: Record<string, string>,
): Promise<VerifyOutcome & { intentId: string | null }> {
  await connectToDatabase();

  const adapter = getProvider(provider);

  // The reference has to be recovered before credentials can be resolved, since
  // credentials are per hostel and the body is what says which hostel. Read
  // unchecked to find the intent, then parsed with that hostel's key, and only
  // the second result is used.
  const reference = adapter.reference(rawBody);

  const intent = reference
    ? await PaymentIntentModel.findOne({ provider, reference }).lean<IntentRecord | null>()
    : null;

  if (!intent) {
    // An unresolvable callback is dropped, not errored: a provider that retries
    // on non-2xx would otherwise hammer us forever over a reference we have
    // never issued, which is also what a probe looks like.
    return { eventId: null, intentId: null, reason: null, settled: false, status: "UNKNOWN" };
  }

  const credentials = await getGatewayCredentials(intent.hostelId, provider);
  const claim = adapter.parseWebhook(rawBody, headers, credentials);

  if (!claim) {
    throw new FinanceServiceError(
      "The callback signature did not verify.",
      "GATEWAY_VERIFICATION_FAILED",
    );
  }

  await touchGatewayActivity(intent.hostelId, provider);

  const outcome = await verifyPaymentIntent(intent._id, { source: "GATEWAY_WEBHOOK" });

  return { ...outcome, intentId: intent._id.toString() };
}

/**
 * Closes attempts whose window has passed — **after asking the provider**.
 *
 * Expiring on the clock alone is how a payment that succeeded while our callback
 * endpoint was down becomes a resident who paid and an invoice that says they
 * did not. The clock decides when to *ask*, never what the answer is.
 */
export async function expireStaleIntents(
  options: { limit?: number; now?: Date } = {},
): Promise<{ expired: number; settled: number; unconfirmed: number }> {
  await connectToDatabase();

  const now = options.now ?? new Date();

  const stale = await PaymentIntentModel.find({
    expiresAt: { $lt: now },
    status: "CREATED",
  })
    // Oldest first. Without an order, a hostel generating attempts faster than
    // the batch size would starve its own oldest rows forever — and the oldest
    // are exactly the ones a resident has been staring at.
    .sort({ expiresAt: 1 })
    .limit(options.limit ?? 100)
    .lean<(IntentRecord & { verifyCount?: number })[]>();

  let expired = 0;
  let settled = 0;
  let unconfirmed = 0;

  for (const intent of stale) {
    try {
      const outcome = await verifyPaymentIntent(intent._id, { source: "GATEWAY_POLL" });

      if (outcome.settled) {
        settled += 1;
        continue;
      }
    } catch {
      // Unreachable provider, missing credentials, a removed gateway. None of
      // those is evidence the payment failed, so the row is normally left for
      // the next run rather than expired on a guess.
      //
      // Normally, but not forever. An attempt nobody can ever confirm would
      // otherwise be re-queried every five minutes indefinitely, and — worse —
      // sit in `CREATED` looking like a payment still in progress. Past the
      // grace period it is closed with a reason that says plainly that we do
      // not know what happened, which is what gateway health counts and what
      // brings a person to look at it.
      if (isUnconfirmable(intent, now)) {
        await closeIntent(intent, "EXPIRED", UNCONFIRMED_REASON);
        unconfirmed += 1;
      }

      continue;
    }

    await closeIntent(intent, "EXPIRED", "The payment window closed with no payment.");
    expired += 1;
  }

  return { expired, settled, unconfirmed };
}

/** How long we keep asking about an attempt the provider will not answer for. */
const UNCONFIRMABLE_GRACE_MS = 24 * 60 * 60 * 1000;
/** And how many times, so a provider down for a day is not mistaken for this. */
const UNCONFIRMABLE_ATTEMPTS = 12;

/**
 * The wording gateway health looks for. Deliberately not "failed" or "expired":
 * those claim knowledge, and the entire point of this state is that we have
 * none.
 */
export const UNCONFIRMED_REASON =
  "The payment provider could not be reached to confirm this attempt, so it was never confirmed either way. If money left the resident's account, it needs checking by hand.";

function isUnconfirmable(
  intent: IntentRecord & { verifyCount?: number },
  now: Date,
): boolean {
  return (
    now.getTime() - new Date(intent.expiresAt).getTime() > UNCONFIRMABLE_GRACE_MS &&
    (intent.verifyCount ?? 0) >= UNCONFIRMABLE_ATTEMPTS
  );
}

async function markSucceeded(
  intent: IntentRecord,
  eventId: Types.ObjectId,
  at: Date,
): Promise<void> {
  await PaymentIntentModel.updateOne(
    { _id: intent._id },
    { $set: { lastVerifiedAt: at, settledEventId: eventId, status: "SUCCEEDED" } },
  );

  await touchGatewayActivity(intent.hostelId, intent.provider);
}

async function closeIntent(
  intent: IntentRecord,
  status: "EXPIRED" | "FAILED",
  reason: string,
): Promise<void> {
  // Filtered on the open status, so a verification that settled concurrently
  // cannot be overwritten by a sweep that started before it.
  await PaymentIntentModel.updateOne(
    { _id: intent._id, status: "CREATED" },
    { $set: { failureReason: reason, status } },
  );
}

/**
 * Records that we heard from this provider.
 *
 * Read by gateway health (6.7): silence here alongside open invoices is the only
 * signal that separates "the webhook has been broken for a week" from "nobody
 * paid this month", which otherwise look identical from every screen.
 */
async function touchGatewayActivity(
  hostelId: Types.ObjectId,
  provider: GatewayProviderName,
): Promise<void> {
  await HostelPaymentProfileModel.updateOne(
    { hostelId },
    { $set: { "gateways.$[slot].lastEventAt": new Date() } },
    { arrayFilters: [{ "slot.provider": provider }] },
  ).catch(() => undefined);
}

/**
 * The actor for something no human triggered.
 *
 * A callback and a sweep have no principal, and the audit envelope requires one.
 * Inventing a hostel-scoped system actor is honest about that; borrowing the
 * resident's identity would attribute an automated decision to them.
 */
function systemPrincipal(intent: IntentRecord): ApiPrincipal {
  return {
    hostelIds: [intent.hostelId.toString()],
    role: "SYSTEM",
    userId: null,
  } as unknown as ApiPrincipal;
}
