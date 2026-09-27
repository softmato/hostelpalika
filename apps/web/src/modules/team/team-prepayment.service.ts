import "server-only";

import { Types } from "mongoose";
import { z } from "zod";

import { connectToDatabase } from "@/lib/db";
import { Role } from "@/lib/roles";
import { siteUrl } from "@/lib/site";
import {
  fetchInvoiceDetail,
  issueInvoiceDocument,
  openCheckoutSession,
} from "@/modules/billing/billing-gateway";
import { isSoftmatoConfigured } from "@/modules/billing/softmato/config";
import { servicePeriod } from "@/modules/billing/softmato/invoice";
import { settlePayment } from "@/modules/billing/subscription-payment.service";
import { getOperationsConfig } from "@/modules/platform-config/operations-config";
import {
  allocateNumber,
  invoiceDocumentInput,
  pricePlan,
  SubscriptionError,
  type InvoiceRecord,
} from "@/modules/billing/subscription.service";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { SubscriptionPaymentModel } from "@hostel/db/models/SubscriptionPayment";
import { TeamPrepaymentModel } from "@hostel/db/models/TeamPrepayment";
import type { BillingCycle } from "@hostel/shared/plans/catalog";

/**
 * The plan payment a field agent takes on the form's Plan & payment step,
 * before the hostel is published — see the model for why it lives apart.
 *
 * 1. **Open** (`openTeamPrepayment`): price the plan here, reserve the hostel's
 *    id, raise the Softmato document under that hostel's first invoice number,
 *    and open a checkout that returns to `/team/register?prepayment=<id>`.
 * 2. **Paid**: a verified webhook (`subscription-webhook.service.ts`) or our
 *    own server-side read (`readTeamPrepayment`) moves it `OPEN → PAID` once.
 *    The URL the agent comes back on proves nothing; the read does.
 * 3. **Claimed** at publish (`claimTeamPrepayment`): the hostel is created at
 *    the reserved id, its invoice adopts the paid document, and
 *    `settleTeamPrepayment` records the money through `settlePayment` — the
 *    receipt, the activation and the commission all follow as for any payment.
 */

export const teamPrepaymentSchema = z.object({
  area: z.string().trim().min(1, "Fill in the area on the Location step first."),
  cycle: z.enum(["monthly", "halfYearly", "annual"]),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal("")),
  hostelName: z.string().trim().min(1, "Name the hostel on the first step first."),
  ownerName: z.string().trim().min(1, "Fill in the owner's name first."),
  phone: z.string().trim().min(1, "Fill in the owner's phone first."),
  planId: z.string().trim().min(1, "Pick a plan first."),
  /** The setup fee to take online; omitted means the configured fee, which is also its ceiling. */
  amount: z.number().int("Whole rupees only.").positive("Enter an amount above zero.").optional(),
  /** The row this form already opened, so a retry reuses it. */
  prepaymentId: z.string().trim().optional(),
  /** The form as it stands, kept on the row so a paid hostel never lives in one browser only. */
  draft: z.record(z.string(), z.unknown()).optional(),
});

export type TeamPrepaymentInput = z.infer<typeof teamPrepaymentSchema>;

type PrepaymentRow = {
  _id: Types.ObjectId;
  agentId: Types.ObjectId;
  amount: number;
  billedTo?: { email?: string | null; hostelName?: string | null; name?: string | null };
  chargeAmount?: number | null;
  cycle: BillingCycle;
  cycleMonths: number;
  hostelId: Types.ObjectId;
  invoiceNumber: string;
  kind?: "PLAN" | "SETUP_FEE";
  paidAt?: Date | null;
  planId: string;
  planName: string;
  provider?: string | null;
  softmatoInvoiceId?: string | null;
  softmatoInvoiceNo?: string | null;
  status: "OPEN" | "PAID" | "CLAIMED" | "SUPERSEDED";
  transactionNo?: string | null;
};

/**
 * What the form shows. `amount` is the plan price the hostel is invoiced for;
 * `chargeAmount` is what this payment takes. `reference` is Softmato's
 * transaction, else its invoice.
 */
export type TeamPrepaymentView = {
  amount: number;
  chargeAmount: number;
  cycle: BillingCycle;
  id: string;
  /** `PLAN` only on a row taken before setup fees; see the model. */
  kind: "PLAN" | "SETUP_FEE";
  paidAt: string | null;
  planId: string;
  planName: string;
  provider: string | null;
  reference: string | null;
  status: PrepaymentRow["status"];
};

const CYCLE_WORDS: Record<BillingCycle, string> = {
  annual: "annual",
  halfYearly: "6 months",
  monthly: "monthly",
};

/** What the owner pays online on this row: a part amount, else the whole price. */
function charge(row: Pick<PrepaymentRow, "amount" | "chargeAmount">) {
  return row.chargeAmount ?? row.amount;
}

function view(row: PrepaymentRow): TeamPrepaymentView {
  return {
    amount: row.amount,
    chargeAmount: charge(row),
    cycle: row.cycle,
    id: String(row._id),
    kind: row.kind ?? "PLAN",
    paidAt: row.paidAt?.toISOString() ?? null,
    planId: row.planId,
    planName: row.planName,
    provider: row.provider ?? null,
    reference: row.transactionNo ?? row.softmatoInvoiceNo ?? null,
    status: row.status,
  };
}

function notFound() {
  return new SubscriptionError("That payment was not found.", "PREPAYMENT_NOT_FOUND", 404);
}

async function loadOwned(id: string, agent: { role: string; userId: string }) {
  if (!Types.ObjectId.isValid(id)) throw notFound();

  const row = await TeamPrepaymentModel.findById(id).lean<PrepaymentRow | null>();

  // Another agent's payment answers exactly as a missing one.
  if (!row || (agent.role !== Role.SUPERADMIN && String(row.agentId) !== agent.userId)) {
    throw notFound();
  }

  return row;
}

/**
 * `OPEN → PAID`, once, whichever of the webhook and the read gets there first.
 * A read that could not name the transaction leaves it for the webhook to fill.
 */
export async function markTeamPrepaymentPaid(
  id: Types.ObjectId,
  fields: { paidAt: Date; provider: string | null; transactionNo: string | null },
) {
  const paid = await TeamPrepaymentModel.findOneAndUpdate(
    { _id: id, status: "OPEN" },
    { $set: { ...fields, status: "PAID" } },
    { new: true },
  ).lean<PrepaymentRow | null>();

  if (paid) {
    await AuditLogModel.create({
      action: "TEAM_PREPAYMENT_PAID",
      actorType: "SYSTEM",
      entityId: String(id),
      entityType: "TeamPrepayment",
      metadata: { amount: charge(paid), invoiceNumber: paid.invoiceNumber, transactionNo: fields.transactionNo },
    });

    return paid;
  }

  if (fields.transactionNo) {
    await TeamPrepaymentModel.updateOne(
      { _id: id, status: "PAID", transactionNo: null },
      { $set: { transactionNo: fields.transactionNo } },
    );
  }

  return TeamPrepaymentModel.findById(id).lean<PrepaymentRow | null>();
}

/** Asks Softmato whether an open row is paid. Only this read, never the URL, decides. */
async function refresh(row: PrepaymentRow): Promise<PrepaymentRow> {
  if (row.status !== "OPEN" || !row.softmatoInvoiceNo) return row;

  const detail = await fetchInvoiceDetail(row.softmatoInvoiceNo).catch(() => null);

  if (detail?.status !== "paid") return row;

  const payment = detail.payments?.[0];

  return (
    (await markTeamPrepaymentPaid(row._id, {
      paidAt: payment?.paid_at ? new Date(payment.paid_at) : new Date(),
      provider: payment?.provider ?? null,
      transactionNo: payment?.transaction_id ?? null,
    })) ?? row
  );
}

export async function openTeamPrepayment(
  input: TeamPrepaymentInput,
  agent: { role: string; userId: string },
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

  // The plan is only recorded here: what is taken is the setup fee, capped by
  // the platform's own figure — never the form's.
  const priced = await pricePlan(input.planId, input.cycle);
  const { teamSetupFee } = await getOperationsConfig();
  const fee = input.amount ?? teamSetupFee;

  if (fee > teamSetupFee || fee <= 0) {
    throw new SubscriptionError(
      `The setup fee is 1 to Rs ${teamSetupFee}. It can't be more than that.`,
      "PREPAYMENT_ABOVE_PRICE",
      422,
    );
  }

  const previous = input.prepaymentId
    ? await refresh(await loadOwned(input.prepaymentId, agent))
    : null;

  if (previous?.status === "PAID" || previous?.status === "CLAIMED") {
    throw new SubscriptionError(
      previous.status === "PAID"
        ? "The setup fee is already paid. Carry on to Review & publish."
        : "That payment already belongs to a published hostel.",
      "PREPAYMENT_ALREADY_PAID",
      409,
    );
  }

  // The same fee reuses the open row whatever plan is picked: the fee does not depend on it.
  let row =
    previous?.status === "OPEN" && previous.kind === "SETUP_FEE" && previous.amount === fee
      ? previous
      : null;

  if (!row) {
    /*
     * A different plan, cycle, price or part amount: a fresh row with a fresh number, since a
     * Softmato reference answers with the invoice it already has. The old one is
     * unpaid, so nothing is lost; it keeps the hostel id so the customer stays
     * the same one on their side.
     */
    if (previous?.status === "OPEN") {
      await TeamPrepaymentModel.updateOne(
        { _id: previous._id, status: "OPEN" },
        { $set: { status: "SUPERSEDED" } },
      );
    }

    const hostelId = previous?.hostelId ?? new Types.ObjectId();
    const created = await TeamPrepaymentModel.create({
      agentId: new Types.ObjectId(agent.userId),
      amount: fee,
      billedTo: {
        email: input.email || null,
        hostelName: input.hostelName,
        name: input.ownerName,
      },
      chargeAmount: null,
      cycle: priced.cycle,
      cycleMonths: priced.cycleMonths,
      hostelId,
      invoiceNumber: await allocateNumber(hostelId, "SUBSCRIPTION_INVOICE"),
      kind: "SETUP_FEE",
      planId: priced.planId,
      planName: priced.planName,
      draft: input.draft ?? null,
    });

    row = created.toObject() as PrepaymentRow;
  } else if (input.draft) {
    await TeamPrepaymentModel.updateOne({ _id: row._id }, { $set: { draft: input.draft } });
  }

  if (!row.softmatoInvoiceId || !row.softmatoInvoiceNo) {
    const issuedAt = new Date();
    const period = servicePeriod(row.cycleMonths, null, issuedAt);
    /*
     * The same document a first plan invoice gets, built by the same function:
     * this row stands in for the invoice until publish creates the real one on
     * top of it. There is no subscription yet, so none is found.
     *
     * Checkout charges the document's own due and takes no amount, so a part
     * payment is a document for the part. The hostel's invoice keeps the full
     * price at publish, and the balance gets its own document when it is paid
     * (`balance-document.ts`), exactly as after part cash.
     */
    const document = await invoiceDocumentInput({
      _id: row._id,
      amount: charge(row),
      billedTo: {
        email: row.billedTo?.email ?? undefined,
        hostelName: row.billedTo?.hostelName ?? undefined,
        name: row.billedTo?.name ?? undefined,
      },
      cycle: row.cycle,
      cycleMonths: row.cycleMonths,
      hostelId: row.hostelId,
      invoiceNumber: row.invoiceNumber,
      issuedAt,
      kind: row.kind ?? "PLAN",
      periodEnd: period.endsAt,
      periodStart: period.startsAt,
      planId: row.planId,
      planName: row.planName,
      source: "TEAM",
      status: "OPEN",
      subscriptionId: null,
    } as unknown as InvoiceRecord);
    const raised = await issueInvoiceDocument(
      row.chargeAmount
        ? { ...document, description: `Part payment — ${document.description}` }
        : document,
    );

    await TeamPrepaymentModel.updateOne(
      { _id: row._id },
      { $set: { softmatoInvoiceId: raised.softmatoInvoiceId, softmatoInvoiceNo: raised.softmatoInvoiceNo } },
    );
    row = { ...row, softmatoInvoiceId: raised.softmatoInvoiceId, softmatoInvoiceNo: raised.softmatoInvoiceNo };
  }

  step("session");

  const session = await openCheckoutSession({
    invoiceNumber: row.invoiceNumber,
    returnUrl: `${siteUrl()}/team/register?prepayment=${String(row._id)}`,
    softmatoInvoiceId: row.softmatoInvoiceId as string,
  });

  return {
    checkoutUrl: session.checkoutUrl,
    expiresAt: session.expiresAt,
    prepayment: view(row),
  };
}

export async function readTeamPrepayment(id: string, agent: { role: string; userId: string }) {
  await connectToDatabase();

  const row = await refresh(await loadOwned(id, agent));

  return { ...view(row), draft: (row as { draft?: Record<string, unknown> | null }).draft ?? null };
}

/** Keeps the form's latest state on the row — the agent is leaving it, or moving it to the desk. */
export async function saveTeamPrepaymentDraft(
  id: string,
  agent: { role: string; userId: string },
  draft: Record<string, unknown>,
) {
  await connectToDatabase();

  const row = await loadOwned(id, agent);

  if (row.status !== "OPEN" && row.status !== "PAID") {
    throw new SubscriptionError("That payment already belongs to a published hostel.", "PREPAYMENT_CLAIMED", 409);
  }

  await TeamPrepaymentModel.updateOne({ _id: row._id }, { $set: { draft } });
}

export type UnpublishedPrepayment = TeamPrepaymentView & { hostelName: string; ownerName: string };

/**
 * The agent's desk list: money taken, hostel not published yet. Each one
 * reopens the form from its saved draft. A superadmin sees everyone's.
 */
export async function listUnpublishedPrepayments(agent: { role: string; userId: string }) {
  await connectToDatabase();

  const rows = await TeamPrepaymentModel.find({
    status: "PAID",
    ...(agent.role === Role.SUPERADMIN ? {} : { agentId: new Types.ObjectId(agent.userId) }),
  })
    .sort({ paidAt: -1 })
    .limit(100)
    .select("-draft")
    .lean<PrepaymentRow[]>();

  return rows.map(
    (row): UnpublishedPrepayment => ({
      ...view(row),
      hostelName: row.billedTo?.hostelName ?? "Hostel",
      ownerName: row.billedTo?.name ?? "",
    }),
  );
}

/**
 * Takes this form's payment for the hostel being published.
 *
 * A setup-fee row is not tied to a plan: the agent may change the plan after
 * taking the fee, so it is claimed whatever plan is picked. The rules below
 * are for a `PLAN` row from before setup fees.
 *
 * - **Paid**, same plan: claimed, and settled once the invoice exists.
 * - **Paid**, other plan: refused. The money was for that plan at that price.
 * - **Unpaid**, same plan: claimed all the same. The owner may still finish on
 *   the checkout that is open — a session lives thirty minutes — and because the
 *   hostel's invoice adopts this document, that payment lands on the hostel by
 *   webhook instead of on a row nothing reads. `paid: false` says not to settle.
 * - **Unpaid**, other plan, or already replaced: dropped; publish goes on without it.
 */
export async function claimTeamPrepayment(
  id: string,
  agent: { role: string; userId: string },
  plan: { cycle: BillingCycle; planId: string },
) {
  await connectToDatabase();

  const row = await refresh(await loadOwned(id, agent));

  if (row.status === "SUPERSEDED") return null;

  if (row.status === "CLAIMED") {
    throw new SubscriptionError(
      "That online payment already belongs to a published hostel.",
      "PREPAYMENT_CLAIMED",
      409,
    );
  }

  // Only a plan-priced row from before setup fees is tied to one plan.
  if (row.kind !== "SETUP_FEE" && (row.planId !== plan.planId || row.cycle !== plan.cycle)) {
    if (row.status === "PAID") {
      throw new SubscriptionError(
        `The online payment was for ${row.planName}, ${CYCLE_WORDS[row.cycle]}. Pick that plan to publish.`,
        "PREPAYMENT_PLAN_MISMATCH",
        409,
      );
    }

    await TeamPrepaymentModel.updateOne(
      { _id: row._id, status: "OPEN" },
      { $set: { status: "SUPERSEDED" } },
    );

    return null;
  }

  const claimed = await TeamPrepaymentModel.findOneAndUpdate(
    { _id: row._id, status: row.status },
    { $set: { claimedAt: new Date(), status: "CLAIMED" } },
    { new: true },
  ).lean<PrepaymentRow | null>();

  if (!claimed?.softmatoInvoiceId || !claimed.softmatoInvoiceNo) {
    throw new SubscriptionError(
      "That online payment already belongs to a published hostel.",
      "PREPAYMENT_CLAIMED",
      409,
    );
  }

  return {
    ...claimed,
    paid: row.status === "PAID",
    softmatoInvoiceId: claimed.softmatoInvoiceId,
    softmatoInvoiceNo: claimed.softmatoInvoiceNo,
  };
}

/** Hands a claim back when the publish that took it failed, so the agent can retry. */
export async function releaseTeamPrepayment(claim: { _id: Types.ObjectId; paid: boolean }) {
  await TeamPrepaymentModel.updateOne(
    { _id: claim._id, status: "CLAIMED" },
    { $set: { claimedAt: null, status: claim.paid ? "PAID" : "OPEN" } },
  );
}

/**
 * The claimed money, recorded against the hostel's new invoice. Through
 * `settlePayment` like every other payment, so the receipt, `PAID`, the active
 * plan and the agent's commission happen here and nowhere else. A webhook that
 * arrives later finds this row by its transaction (or its amount) and stops.
 */
export async function settleTeamPrepayment(
  row: {
    amount: number;
    chargeAmount?: number | null;
    provider?: string | null;
    transactionNo?: string | null;
  },
  invoice: { _id: Types.ObjectId; hostelId: Types.ObjectId; subscriptionId: Types.ObjectId },
  actorId: string,
) {
  const payment = await SubscriptionPaymentModel.create({
    amount: charge(row),
    hostelId: invoice.hostelId,
    invoiceId: invoice._id,
    method: "SOFTMATO",
    recordedBy: actorId,
    softmatoProvider: row.provider ?? null,
    softmatoTransactionNo: row.transactionNo ?? null,
    status: "PENDING",
    subscriptionId: invoice.subscriptionId,
  });

  await settlePayment(String(payment._id), { actorId });
}
