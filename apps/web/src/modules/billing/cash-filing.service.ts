import "server-only";

import { SubscriptionInvoiceModel } from "@hostel/db/models/SubscriptionInvoice";
import { SubscriptionPaymentModel } from "@hostel/db/models/SubscriptionPayment";
import { sendEmail } from "@hostel/shared/email/sender";
import { fieldCashReceivedEmail } from "@hostel/shared/email/templates/billing/field-cash-received";

import { connectToDatabase } from "@/lib/db";
import { isSoftmatoDown, softmato } from "@/modules/billing/softmato/client";
import { rupeesToPaisa } from "@/modules/billing/softmato/money";
import { rememberTask } from "@/modules/billing/softmato/outage";
import { readTransaction } from "@/modules/billing/softmato/transaction";
import { recordSoftmatoPayment } from "@/modules/billing/subscription-webhook.service";
import { ensureInvoiceRaised, type InvoiceRecord } from "@/modules/billing/subscription.service";
import { HostelModel } from "@hostel/db/models/Hostel";
import { UserModel } from "@hostel/db/models/User";
import type { FieldCashRow } from "@/lib/billing/billing.types";
export type { FieldCashRow } from "@/lib/billing/billing.types";

/**
 * Cash an agent took, filed with Softmato as a claim: it books — and the
 * receipt is issued — only when a Softmato admin confirms it against the money
 * handed over (two people). Recorded here as PENDING with the agent as the
 * collector; `payment.success` for its transaction settles it like any other.
 */
export async function fileFieldCash(
  invoiceId: string,
  input: { amount: number; reference?: string },
  agent: { name: string; userId: string },
): Promise<void> {
  await connectToDatabase();

  const invoice = await SubscriptionInvoiceModel.findById(invoiceId).lean<InvoiceRecord | null>();

  if (!invoice) return;

  const payment = await SubscriptionPaymentModel.create({
    amount: input.amount,
    collectedBy: agent.userId,
    gatewayReference: input.reference || null,
    hostelId: invoice.hostelId,
    invoiceId: invoice._id,
    method: "CASH",
    recordedBy: agent.userId,
    status: "PENDING",
    subscriptionId: invoice.subscriptionId,
  });

  /*
   * Filed automatically once Softmato answers (`softmato/retry.ts`). Any failure
   * is remembered, not only an outage (P7-11): the hostel is already published
   * when this runs, and rethrowing failed a registration that had gone live.
   */
  await submitFieldCash(String(payment._id), agent.name).catch(async (error: unknown) => {
    console.error(
      JSON.stringify({
        action: "field_cash_filing_deferred",
        down: isSoftmatoDown(error),
        level: "error",
        message: error instanceof Error ? error.message : String(error),
        paymentId: String(payment._id),
      }),
    );
    await rememberTask({ kind: "CASH_FILING", name: agent.name, ref: String(payment._id) });
  });
}

/** Files one waiting cash payment with Softmato and tells the owner. Throws on an outage. */
export async function submitFieldCash(paymentId: string, collectedBy: string | null): Promise<void> {
  const payment = await SubscriptionPaymentModel.findById(paymentId).lean<{
    amount: number;
    gatewayReference?: string | null;
    invoiceId: string;
    softmatoTransactionNo?: string | null;
    status: string;
  } | null>();

  if (!payment || payment.status !== "PENDING" || payment.softmatoTransactionNo) return;

  const loaded = await SubscriptionInvoiceModel.findById(payment.invoiceId).lean<InvoiceRecord | null>();

  if (!loaded) return;

  const invoice = await ensureInvoiceRaised(loaded, { required: true });
  const filed = await softmato().recordOfflinePayment(
    {
      amount_minor: rupeesToPaisa(payment.amount),
      collected_by: collectedBy || "Field agent",
      invoice_id: invoice.softmatoInvoiceNo as string,
      ...(payment.gatewayReference ? { reference: payment.gatewayReference } : {}),
    },
    { idempotencyKey: `hh-cash:${paymentId}` },
  );

  await SubscriptionPaymentModel.updateOne(
    { _id: paymentId },
    { $set: { softmatoTransactionNo: filed.transaction_id } },
  );

  const email = invoice.billedTo?.email;

  if (!email) return;

  await sendEmail({
    ...fieldCashReceivedEmail({
      amount: payment.amount,
      collectedBy,
      planName: invoice.planName,
      transactionId: filed.transaction_id,
    }),
    to: email,
  });
}

/**
 * Where a Softmato admin confirms cash. Their API files cash but cannot confirm
 * it — that is the two-person check — so our queue links here rather than
 * pretending to book it.
 */
export const SOFTMATO_CASH_QUEUE_URL = "https://admin.softmato.com/cash";

/** Cash agents collected that nobody has confirmed yet, oldest first. */
export async function listFieldCashToConfirm(): Promise<FieldCashRow[]> {
  await connectToDatabase();

  const rows = await SubscriptionPaymentModel.find({ method: "CASH", status: "PENDING" })
    .sort({ createdAt: 1 })
    .limit(200)
    .lean<
      Array<{
        _id: unknown;
        amount: number;
        collectedBy?: unknown;
        createdAt: Date;
        gatewayReference?: string | null;
        hostelId: unknown;
        invoiceId: unknown;
        softmatoTransactionNo?: string | null;
      }>
    >();

  const [invoices, hostels, agents] = await Promise.all([
    SubscriptionInvoiceModel.find({ _id: { $in: rows.map((row) => row.invoiceId) } })
      .select("invoiceNumber planName")
      .lean<Array<{ _id: unknown; invoiceNumber: string; planName: string }>>(),
    HostelModel.find({ _id: { $in: rows.map((row) => row.hostelId) } })
      .select("name")
      .lean<Array<{ _id: unknown; name?: string }>>(),
    UserModel.find({ _id: { $in: rows.map((row) => row.collectedBy).filter(Boolean) } })
      .select("name")
      .lean<Array<{ _id: unknown; name?: string }>>(),
  ]);
  const byId = <T extends { _id: unknown }>(list: T[]) => new Map(list.map((item) => [String(item._id), item]));
  const invoiceOf = byId(invoices);
  const hostelOf = byId(hostels);
  const agentOf = byId(agents);

  return rows.map((row) => ({
    amount: row.amount,
    collectedAt: row.createdAt.toISOString(),
    collectedBy: agentOf.get(String(row.collectedBy))?.name ?? "Field agent",
    hostelName: hostelOf.get(String(row.hostelId))?.name ?? "Hostel",
    id: String(row._id),
    invoiceNumber: invoiceOf.get(String(row.invoiceId))?.invoiceNumber ?? "—",
    planName: invoiceOf.get(String(row.invoiceId))?.planName ?? "",
    reference: row.gatewayReference ?? null,
    transactionNo: row.softmatoTransactionNo ?? null,
  }));
}

/**
 * "Check now" on one row: files it if Softmato never got it, otherwise asks
 * Softmato where it stands and settles it here if they confirmed — the same
 * path the webhook takes, so the receipt is theirs and it happens once.
 */
export async function checkFieldCash(paymentId: string): Promise<"filed" | "rejected" | "settled" | "waiting"> {
  await connectToDatabase();

  const payment = await SubscriptionPaymentModel.findById(paymentId).lean<{
    _id: unknown;
    amount: number;
    collectedBy?: unknown;
    hostelId: InvoiceRecord["hostelId"];
    invoiceId: InvoiceRecord["_id"];
    method: string;
    softmatoTransactionNo?: string | null;
    status: string;
    subscriptionId: InvoiceRecord["subscriptionId"];
  } | null>();

  if (!payment || payment.method !== "CASH") return "waiting";
  if (payment.status === "SETTLED") return "settled";
  if (payment.status === "FAILED") return "rejected";

  if (!payment.softmatoTransactionNo) {
    const agent = payment.collectedBy
      ? await UserModel.findById(payment.collectedBy).select("name").lean<{ name?: string } | null>()
      : null;

    await submitFieldCash(paymentId, agent?.name ?? null);

    return "filed";
  }

  const outcome = await readTransaction(payment.softmatoTransactionNo);

  if (outcome.kind === "settled") {
    await recordSoftmatoPayment(
      { _id: payment.invoiceId, hostelId: payment.hostelId, subscriptionId: payment.subscriptionId },
      payment.softmatoTransactionNo,
      payment.amount,
    );

    return "settled";
  }

  if (outcome.kind === "not_completed") {
    await SubscriptionPaymentModel.updateOne({ _id: payment._id, status: "PENDING" }, { $set: { status: "FAILED" } });

    return "rejected";
  }

  return "waiting";
}
