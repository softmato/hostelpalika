import { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import {
  openCheckoutSession,
  documentDownloadUrl,
  readSettledReceipt,
} from "@/modules/billing/billing-gateway";
import {
  SubscriptionError,
  ensureInvoiceRaised,
  getSubscriptionState,
  graceDeadline,
  outstandingFor,
  startPlanPeriod,
  type InvoiceRecord as SubscriptionInvoiceRecord,
} from "@/modules/billing/subscription.service";
import { checkoutDocumentFor } from "@/modules/billing/balance-document";
import { claimFreeMonths } from "@/modules/billing/free-months";
import { servicePeriod } from "@/modules/billing/softmato/invoice";
import { planAfterPayment } from "@/modules/billing/subscription.service";
import { ensureLocalReceiptNumber } from "@/modules/billing/documents/issue";
import { isSoftmatoConfigured } from "@/modules/billing/softmato/config";
import { unlessSoftmatoDown } from "@/modules/billing/softmato/outage";
import { siteUrl } from "@/lib/site";
import { onPaymentSettled } from "@/modules/hostels/hostel-registration.events";
import { getOperationsConfig } from "@/modules/platform-config/operations-config";
import { creditTeamCommission } from "@/modules/team/team-commission.service";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { ReceiptCounterModel } from "@hostel/db/models/ReceiptCounter";
import { SubscriptionInvoiceModel } from "@hostel/db/models/SubscriptionInvoice";
import { SubscriptionPaymentModel } from "@hostel/db/models/SubscriptionPayment";

/**
 * Taking money for a plan, and what happens the moment it lands.
 *
 * Settling a payment is the one operation in the whole flow with consequences
 * outside its own collection: it issues a receipt, may activate a subscription,
 * and may publish a hostel to the public directory. Those all live in
 * `settlePayment` rather than being left to the caller, because a caller that
 * forgot one would leave a hostel that has paid in full sitting unpublished
 * with no error anywhere to explain it.
 */

/**
 * The same shape `subscription.service` reads, because `ensureInvoiceRaised`
 * takes one of these and a narrower local copy would only be a copy that
 * drifts — it already had, by two fields.
 */
type InvoiceRecord = SubscriptionInvoiceRecord;

async function loadInvoice(invoiceId: string) {
  const invoice = await SubscriptionInvoiceModel.findById(
    invoiceId,
  ).lean<InvoiceRecord | null>();

  if (!invoice) {
    throw new SubscriptionError("Invoice not found.", "INVOICE_NOT_FOUND", 404);
  }

  if (invoice.status === "VOID") {
    throw new SubscriptionError(
      "That invoice was voided, so it cannot take a payment.",
      "INVOICE_VOID",
      409,
    );
  }

  return invoice;
}

/* -- Opening a checkout ------------------------------------------------- */

/**
 * Opens a Softmato checkout for what is still owed, and returns where to send
 * the payer.
 *
 * ## The amount is not negotiable here
 *
 * `POST /v1/checkout` has no amount parameter -- Softmato reads it from the
 * invoice -- so an online payment settles the invoice in full. That is why this
 * takes no `amount` from the caller: there is nowhere to put one, and a client
 * that could choose its own price would be the vulnerability the API is shaped
 * to prevent.
 *
 * A part-paid invoice is still finished online, for exactly the balance:
 * Softmato charges a document's own due, so `checkoutDocumentFor` picks the
 * original when their due is ours and raises a balance document when it is
 * not. Settling still lands on this invoice.
 *
 * ## A session is minted per attempt, never stored
 *
 * It lives thirty minutes and it is closer to a cheque than to a link --
 * forwarded, reused, or paid after the price changed. So this runs every time
 * the owner presses Pay, including retries, and nothing persists the URL.
 *
 * The `PENDING` row is written first so an abandoned attempt still leaves a
 * trace. It is worth nothing until it settles: `outstandingFor` sums only
 * `SETTLED` rows, so writing one early cannot publish a hostel by accident.
 */
export async function openSubscriptionCheckout(
  invoiceId: string,
  actorId: string,
  /** Announces each stage as it starts, for the hand-off screen. */
  step: (name: "invoice" | "session") => void = () => {},
) {
  if (!isSoftmatoConfigured()) {
    throw new SubscriptionError(
      "Online payment is not set up on this deployment yet.",
      "ONLINE_PAYMENT_UNAVAILABLE",
      503,
    );
  }

  step("invoice");
  await connectToDatabase();

  const loaded = await loadInvoice(invoiceId);
  const { outstanding } = await outstandingFor(loaded);

  if (outstanding <= 0) {
    throw new SubscriptionError(
      "This invoice is already settled in full.",
      "ALREADY_SETTLED",
      409,
    );
  }

  /*
   * Softmato unreachable: the payer is told so and emailed a link once it is
   * back (`softmato/outage.ts`), rather than shown a raw gateway error.
   */
  const { invoice, session } = await unlessSoftmatoDown(
    async () => {
      const contact = await resolveOwnerEmail(loaded.hostelId);

      return {
        email: contact.email || null,
        kind: "PLAN_PAYMENT",
        link: `${siteUrl()}/hostel-admin/billing`,
        name: contact.hostelName || null,
        ref: String(loaded._id),
      };
    },
    async () => {
      /*
       * Required here, unlike at issue time: a checkout is addressed by
       * Softmato's invoice id and reads the amount from it, so without the
       * document there is nothing to check out against.
       */
      const raised = await ensureInvoiceRaised(loaded, { required: true });

      if (!raised.softmatoInvoiceId) {
        throw new SubscriptionError(
          "This invoice has no payment document yet. Try again in a moment.",
          "INVOICE_NOT_RAISED",
          503,
        );
      }

      step("session");

      return {
        invoice: raised,
        session: await openCheckoutSession({
          invoiceNumber: raised.invoiceNumber,
          softmatoInvoiceId: await checkoutDocumentFor(raised, outstanding),
        }),
      };
    },
  );

  const payment = await SubscriptionPaymentModel.create({
    amount: outstanding,
    hostelId: invoice.hostelId,
    invoiceId: invoice._id,
    method: "SOFTMATO",
    recordedBy: actorId,
    softmatoSessionId: session.sessionId,
    status: "PENDING",
    subscriptionId: invoice.subscriptionId,
  });

  return {
    allowedProviders: session.allowedProviders,
    checkoutUrl: session.checkoutUrl,
    expiresAt: session.expiresAt,
    payment: { amount: outstanding, id: String(payment._id) },
  };
}

/* ── Settling ──────────────────────────────────────────────────────────── */

/**
 * Marks a payment received, then applies everything that follows from it.
 *
 * In order, and all of it here rather than at the call site:
 *
 * 1. the payment settles and gets its receipt number and document;
 * 2. the invoice moves to `PAID` or `PARTIAL` from the recomputed balance;
 * 3. the subscription activates if nothing is left owed, or carries a due if
 *    money is still outstanding on a team-filed registration;
 * 4. the hostel publishes, if the rules for its source now allow it.
 *
 * Step 4 is where the two desks finally diverge, and it is the only branch:
 * **a public hostel publishes when it has paid in full; a team-filed hostel is
 * already published and stays that way while it owes.**
 */
export async function settlePayment(
  paymentId: string,
  options: {
    actorId?: string;
    /**
     * When present, the payment must belong to this hostel or the call is
     * refused.
     *
     * Callers that reached here from an owner-scoped route have authorised a
     * *hostel*, not a payment id, and the id then arrives in the request body.
     * Without this check, an owner of one hostel could authorise against their
     * own and then post somebody else's payment id — settling a stranger's
     * invoice and publishing a hostel that had not paid. The gateway callback,
     * which is authorised by the gateway rather than by a session, passes
     * nothing here and is unaffected.
     */
    expectedHostelId?: string;
    gatewayReference?: string;
  } = {},
) {
  await connectToDatabase();

  const payment = await SubscriptionPaymentModel.findById(paymentId).lean<{
    _id: Types.ObjectId;
    amount: number;
    hostelId: Types.ObjectId;
    invoiceId: Types.ObjectId;
    isMocked?: boolean;
    method: string;
    softmatoTransactionNo?: string | null;
    status: string;
    subscriptionId: Types.ObjectId;
  } | null>();

  if (!payment) {
    throw new SubscriptionError("Payment not found.", "PAYMENT_NOT_FOUND", 404);
  }

  if (
    options.expectedHostelId &&
    payment.hostelId.toString() !== options.expectedHostelId
  ) {
    // Same wording as a missing payment, deliberately: a caller probing ids
    // should not learn which of them exist.
    throw new SubscriptionError("Payment not found.", "PAYMENT_NOT_FOUND", 404);
  }

  /*
   * **Claim the row before doing anything with consequences.**
   *
   * Idempotent: a gateway that delivers its callback twice must not issue two
   * receipts for one payment. Reading the status and then writing it would
   * leave a window between the two that both deliveries pass through — and
   * webhook deliveries retry until they get a 2xx, so concurrent duplicates are
   * the expected traffic rather than a rare race.
   *
   * A single conditional update is the claim. Exactly one caller can move a row
   * out of `PENDING`; everyone else gets `null` here and returns having done
   * nothing. Everything below — the receipt number, the email, the activation,
   * the publish — therefore happens once.
   */
  const claimed = await SubscriptionPaymentModel.findOneAndUpdate(
    /*
     * Two openings, not one. `PENDING` is a checkout waiting on a webhook;
     * `IN_REVIEW` is a manual claim waiting on a person. Both are rows worth
     * nothing until this update lands, both settle exactly once, and widening
     * the filter is what lets an approved claim take the same path — the
     * receipt, the activation and the publish are the same four steps whether
     * a gateway or a reviewer said the money arrived.
     */
    { _id: payment._id, status: { $in: ["PENDING", "IN_REVIEW"] } },
    { $set: { settledAt: new Date(), status: "SETTLED" } },
    { new: true },
  ).lean<{ _id: Types.ObjectId } | null>();

  if (!claimed) {
    return getSubscriptionState(payment.hostelId.toString());
  }

  const invoice = await loadInvoice(payment.invoiceId.toString());
  const receiptNumber = await allocateReceiptNumber(invoice.hostelId);

  /*
   * Two kinds of receipt, and only one of them is a document we can produce.
   *
   * A Softmato payment already has one: they issue it the moment money lands
   * and email it to the owner with the PDF attached. So this reads theirs
   * rather than inventing a second document that would disagree with the one
   * already in the owner's inbox.
   *
   * A cash payment has none, because there is no transaction on any rail to
   * receipt. It keeps our own `SRC-` number and a null document — the honest
   * representation of an internal record, and better than a URL that 404s.
   *
   * Our number is allocated either way, so our own sequence stays complete and
   * every settled payment has one handle that is ours.
   */
  const receipt = payment.softmatoTransactionNo
    ? await readSettledReceipt(payment.softmatoTransactionNo).catch((error) => {
        /*
         * A receipt we cannot read must not stop us provisioning. The money is
         * confirmed — that came from a verified webhook or a server-side
         * transaction read, not from this call — and withholding the service
         * because a document endpoint was slow would punish the owner for our
         * outage. The billing screen fetches it live anyway.
         */
        console.error(
          JSON.stringify({
            action: "softmato_receipt_read_failed",
            level: "error",
            message: error instanceof Error ? error.message : String(error),
            transactionNo: payment.softmatoTransactionNo,
          }),
        );

        return null;
      })
    : null;

  await SubscriptionPaymentModel.updateOne(
    { _id: payment._id },
    {
      $set: {
        ...(options.gatewayReference
          ? { gatewayReference: options.gatewayReference }
          : {}),
        ...(receipt?.providerRef
          ? { gatewayReference: receipt.providerRef }
          : {}),
        ...(receipt?.provider ? { softmatoProvider: receipt.provider } : {}),
        receiptDocumentUrl:
          receipt?.documentUrl ?? documentDownloadUrl("receipt", receiptNumber),
        receiptIssuedAt: new Date(),
        receiptNumber,
      },
    },
  );

  /*
   * **Softmato issues the receipt.** For any payment that went through them —
   * online, or cash their admin confirmed — theirs is the only one, even when
   * it could not be read just now: the route above fetches it once they
   * answer. Only money Softmato never saw (cash or a proof approved here before
   * the move) keeps the receipt this app printed at the time.
   */
  if (!receipt && payment.method !== "SOFTMATO" && !payment.softmatoTransactionNo) {
    await ensureLocalReceiptNumber(payment._id);
  }

  const balance = await outstandingFor(invoice);

  await SubscriptionInvoiceModel.updateOne(
    { _id: invoice._id },
    { $set: { status: balance.outstanding <= 0 ? "PAID" : "PARTIAL" } },
  );

  // A team-registered hostel's setup fee paid in full earns its agent their
  // commission. Once per hostel, and never able to fail the settlement.
  if (balance.outstanding <= 0 && (await earnsCommission(invoice))) {
    await creditTeamCommission(invoice);
  }

  const subscriptionAfter = await applySettlement(
    invoice,
    balance.outstanding,
    options.actorId,
  );

  const billingContact = await resolveOwnerEmail(invoice.hostelId);

  await onPaymentSettled({
    amount: payment.amount,
    dueBy: subscriptionAfter?.dueBy ?? null,
    hostelName: billingContact.hostelName,
    invoiceNumber: invoice.invoiceNumber,
    method: payment.method,
    outstanding: balance.outstanding,
    ownerEmail: billingContact.email,
    planName: invoice.planName,
    // Softmato's number, when it has one: the receipt the owner is sent is theirs.
    receiptNumber: payment.softmatoTransactionNo ?? null,
    receiptRef: receiptNumber,
  });

  await AuditLogModel.create({
    action: "SUBSCRIPTION_PAYMENT_SETTLED",
    actorId: options.actorId ?? null,
    /*
     * A webhook settlement has no actor, and says so rather than borrowing
     * one. Nobody on our side did this: Softmato told us money arrived, on a
     * signature we verified. Naming the hostel owner here would put them in
     * the audit trail for an act they did not perform — they paid at a
     * wallet, which is a different event on somebody else's ledger.
     */
    actorType: options.actorId ? "USER" : "SYSTEM",
    entityId: String(payment._id),
    entityType: "SubscriptionPayment",
    hostelId: invoice.hostelId,
    metadata: {
      amount: payment.amount,
      invoiceNumber: invoice.invoiceNumber,
      method: payment.method,
      mocked: Boolean(payment.isMocked),
      outstandingAfter: balance.outstanding,
      receiptNumber,
    },
  });

  return getSubscriptionState(invoice.hostelId.toString());
}

/**
 * Whether paying this invoice in full earns the registering agent commission.
 *
 * The setup fee does. A team hostel filed before the setup fee existed earns it
 * on its first plan invoice instead, as it was promised when it was filed —
 * recognised by having no setup-fee invoice at all. Any later plan invoice of
 * a hostel that had a setup fee earns nothing. (`creditTeamCommission` keeps
 * it to one credit per hostel either way.)
 */
async function earnsCommission(invoice: InvoiceRecord) {
  if (invoice.kind === "SETUP_FEE") return true;
  if (invoice.source !== "TEAM") return false;

  const setupFee = await SubscriptionInvoiceModel.exists({
    kind: "SETUP_FEE",
    subscriptionId: invoice.subscriptionId,
  });

  return !setupFee;
}

/** `SRC-0001-4F2A`. Per hostel, lifetime — see `allocateNumber` next door. */
async function allocateReceiptNumber(hostelId: Types.ObjectId) {
  const counter = await ReceiptCounterModel.findOneAndUpdate(
    { hostelId, kind: "SUBSCRIPTION_RECEIPT", period: "LIFETIME" },
    { $inc: { sequence: 1 } },
    { new: true, setDefaultsOnInsert: true, upsert: true },
  ).lean<{ sequence: number } | null>();

  const sequence = String(counter?.sequence ?? 1).padStart(4, "0");

  return `SRC-${sequence}-${hostelId.toString().slice(-4).toUpperCase()}`;
}

/**
 * Moves the subscription and, where the rules allow, the hostel.
 *
 * The whole public/team difference is the `source` check below. Everything
 * above this point ran identically for both.
 */
async function applySettlement(
  invoice: InvoiceRecord,
  outstanding: number,
  actorId?: string,
): Promise<{ dueBy: Date | null } | null> {
  const subscription = await HostelSubscriptionModel.findById(
    invoice.subscriptionId,
  ).lean<{
    _id: Types.ObjectId;
    cycle?: string | null;
    cycleMonths?: number | null;
    planId?: string | null;
    source?: string;
  } | null>();

  if (!subscription) {
    return null;
  }

  // A setup fee buys no time on the plan and publishes nothing.
  if (invoice.kind === "SETUP_FEE") {
    return { dueBy: null };
  }

  if (outstanding <= 0) {
    /*
     * A renewal bought on a different plan or cycle (`raiseRenewalInvoice`)
     * becomes the hostel's plan now that it is paid — not when it was raised,
     * so an abandoned checkout never changed anything. Every other invoice was
     * raised from the subscription's own plan, and this is a no-op for it.
     */
    if (
      (invoice.planId !== subscription.planId || invoice.cycle !== subscription.cycle) &&
      (await planAfterPayment(subscription, invoice)) === "invoice"
    ) {
      await HostelSubscriptionModel.updateOne(
        { _id: subscription._id },
        {
          $set: {
            cycle: invoice.cycle,
            cycleMonths: invoice.cycleMonths,
            cycleTotal: invoice.amount,
            monthlyRate: Math.round(invoice.amount / (invoice.cycleMonths || 1)),
            planId: invoice.planId,
            planName: invoice.planName,
          },
        },
      );
    }

    /*
     * The plan runs from the day the hostel went live. A team hostel went live
     * the day it was filed and its period is already running — `startPlanPeriod`
     * sees that and leaves it alone. A public hostel goes live now, so its
     * period starts now; a renewal extends the one in hand.
     */
    await startPlanPeriod(invoice, new Date());

    await HostelSubscriptionModel.updateOne(
      { _id: subscription._id },
      { $set: { dueBy: null, status: "ACTIVE" } },
    );

    await publishForSubscription(invoice.hostelId, actorId);
    await openHostelAfterPayment(invoice.hostelId, subscription.source, actorId);

    return { dueBy: null };
  }

  // Still owed. Only a team registration may live in this state — a public one
  // simply stays unpublished and unactivated until it clears.
  if (subscription.source === "TEAM") {
    /*
     * The deadline the invoice was raised with — never a fresh one.
     *
     * This used to be "now plus the grace period" on every part payment, which
     * made each instalment buy a new grace period: a hostel added on Bhadra 25
     * that paid Rs 1,400 the same afternoon was told it had until Aswin 9, and
     * one that paid a little every few days would never have been due at all.
     * The due is counted from the day the hostel was added and does not move.
     *
     * The fallback covers invoices raised before `dueAt` was always written.
     */
    const dueBy =
      invoice.dueAt ??
      graceDeadline(
        invoice.issuedAt ?? new Date(),
        (await getOperationsConfig()).subscriptionDueGraceDays,
      );

    await HostelSubscriptionModel.updateOne(
      { _id: subscription._id },
      { $set: { dueBy, status: "PAST_DUE" } },
    );

    return { dueBy };
  }

  return { dueBy: null };
}

/**
 * Starts a hostel's free months, the moment it goes live.
 *
 * Called where a hostel goes live without paying for its plan: a public
 * hostel verified with a plan chosen (either order), and a team filing. The
 * building is matched against every earlier claim first (`claimFreeMonths`);
 * a building that has had its free months gets none, returns `null`, and the
 * caller carries on with the paid flow exactly as before.
 *
 * With free months, there is no invoice: the plan simply runs, ACTIVE, until
 * `freeUntil`, and is published and opened like a hostel that has paid. The
 * first bill is raised by the renewal sweep as that date comes up.
 *
 * Idempotent: a subscription already given its free months is returned as it
 * is, so an approval retried or a plan re-picked never restarts them.
 */
export async function startFreeMonths(hostelId: string, actorId?: string, from = new Date()) {
  await connectToDatabase();

  const subscription = await HostelSubscriptionModel.findOne({
    hostelId: new Types.ObjectId(hostelId),
  }).lean<{
    _id: Types.ObjectId;
    freeMonths?: number | null;
    freeUntil?: Date | null;
    hostelId: Types.ObjectId;
    planId?: string | null;
    source?: string;
    status?: string;
  } | null>();

  if (!subscription?.planId) {
    return null;
  }

  if (subscription.freeUntil) {
    return { freeMonths: subscription.freeMonths ?? 0, freeUntil: subscription.freeUntil };
  }

  // Only a hostel that has not started paying yet. A plan already running or
  // billed is not given months back on top.
  if (!["SELECTED", "PENDING_SELECTION"].includes(subscription.status ?? "")) {
    return null;
  }

  const claim = await claimFreeMonths(subscription.hostelId, {
    freeMonths: subscription.freeMonths ?? 0,
    id: subscription.planId,
  });

  if (claim.freeMonths <= 0) {
    await HostelSubscriptionModel.updateOne({ _id: subscription._id }, { $set: { freeMonths: 0 } });

    return null;
  }

  const period = servicePeriod(claim.freeMonths, null, from);

  await HostelSubscriptionModel.updateOne(
    { _id: subscription._id },
    {
      $set: {
        activatedAt: period.startsAt,
        currentPeriodEnd: period.endsAt,
        dueBy: null,
        freeMonths: claim.freeMonths,
        freeUntil: period.endsAt,
        status: "ACTIVE",
      },
    },
  );

  await publishForSubscription(subscription.hostelId, actorId);
  await openHostelAfterPayment(subscription.hostelId, subscription.source, actorId);

  await AuditLogModel.create({
    action: "SUBSCRIPTION_FREE_MONTHS_STARTED",
    actorId: actorId ?? null,
    actorType: actorId ? "USER" : "SYSTEM",
    entityId: subscription._id.toString(),
    entityType: "HostelSubscription",
    hostelId: subscription.hostelId,
    metadata: {
      freeMonths: claim.freeMonths,
      freeUntil: period.endsAt.toISOString(),
      planId: subscription.planId,
    },
  });

  return { freeMonths: claim.freeMonths, freeUntil: period.endsAt };
}

/**
 * What paying the plan in full opens, beyond the plan itself.
 *
 * - **A suspension ends**, at either stage. Paying is the only way out of one,
 *   so the moment the plan is paid every portal tied to the hostel opens again.
 * - **A public owner gets the portal.** Approval kept it back until now
 *   (`approvePlatformHostel`); a renewal finds the owner already holding it and
 *   changes nothing.
 * - **Referral time lands** (`settleHostelReferrals`), on this hostel and on the
 *   one whose code it registered with.
 *
 * None may fail the settlement: the money is confirmed and the receipt is
 * out. A failure is logged for a person to finish, never thrown back at a
 * gateway that would retry a payment that already landed.
 *
 * Both are imported here rather than at the top: `hostel.service` imports this
 * module, so a static import back would be a cycle, and the suspension module
 * rides along with it for the same reason.
 */
async function openHostelAfterPayment(
  hostelId: Types.ObjectId,
  source: string | undefined,
  actorId?: string,
) {
  try {
    const { liftHostelSuspension } = await import("@/modules/hostels/hostel-suspension");

    await liftHostelSuspension(hostelId, { actorId: actorId ?? null, cause: "PAID" });
  } catch (error) {
    logAccessFailure("hostel_suspension_lift_failed", hostelId, error);
  }

  // Live now: its referral (if it registered with a code) pays out, and any
  // referral time owed to it lands on the period that is now running.
  try {
    const { settleHostelReferrals } = await import(
      "@/modules/hostel-referrals/hostel-referral.service"
    );

    await settleHostelReferrals(hostelId);
  } catch (error) {
    logAccessFailure("hostel_referral_settle_failed", hostelId, error);
  }

  if (source === "TEAM") {
    return;
  }

  try {
    const { grantHostelOwnerAccess } = await import("@/modules/hostels/hostel.service");

    await grantHostelOwnerAccess(hostelId.toString(), actorId ?? null);
  } catch (error) {
    logAccessFailure("hostel_owner_access_grant_failed", hostelId, error);
  }
}

function logAccessFailure(action: string, hostelId: Types.ObjectId, error: unknown) {
  console.error(
    JSON.stringify({
      action,
      hostelId: hostelId.toString(),
      level: "error",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}

/** Who the receipt goes to, and the hostel it names. */
async function resolveOwnerEmail(hostelId: Types.ObjectId) {
  const { UserModel } = await import("@hostel/db/models/User");
  const hostel = await HostelModel.findById(hostelId)
    .select("ownerId contact name")
    .lean<{
      contact?: { email?: string };
      name?: string;
      ownerId?: Types.ObjectId;
    } | null>();

  const owner = hostel?.ownerId
    ? await UserModel.findById(hostel.ownerId)
        .select("email")
        .lean<{ email?: string } | null>()
    : null;

  return {
    email: owner?.email ?? hostel?.contact?.email ?? "",
    hostelName: hostel?.name ?? "",
  };
}

/**
 * Publishes the hostel now that its plan is paid for.
 *
 * Deliberately does not go through `publishPlatformHostel`: that one is a
 * superadmin action carrying a principal and a "verified first" guard aimed at
 * a human clicking Approve. This is the automatic consequence of money landing,
 * so it writes the status directly and leaves the audit trail to the settlement
 * entry that called it. A hostel already published — every team-filed one — is
 * left exactly as it is.
 */
async function publishForSubscription(hostelId: Types.ObjectId, actorId?: string) {
  const hostel = await HostelModel.findById(hostelId)
    .select("status verificationStatus")
    .lean<{ status?: string; verificationStatus?: string } | null>();

  if (!hostel || hostel.status === "PUBLISHED") {
    return;
  }

  await HostelModel.updateOne(
    { _id: hostelId },
    {
      $set: {
        status: "PUBLISHED",
        ...(actorId ? { updatedBy: actorId } : {}),
        verificationStatus: "VERIFIED",
      },
    },
  );
}
