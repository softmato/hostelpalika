import { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { bsPeriodsBetween, hostelPeriodOf } from "@/lib/hostel-day";
import { listResidentInvoices } from "@/modules/finance/ledger-read.service";
import { PaymentEventModel } from "@hostel/db/models/PaymentEvent";
import { ReceiptModel } from "@hostel/db/models/Receipt";
import { ResidentModel } from "@hostel/db/models/Resident";

/**
 * One resident's whole payment history, month by month, from the day they moved
 * in (target §11.4 follow-through).
 *
 * The payments matrix answers "who has not paid *this month*". The question it
 * cannot answer is the one an owner asks the moment a name catches their eye —
 * "is this person usually late, or is this the first time?" — and answering it
 * today means changing the month picker eleven times and remembering what each
 * screen said.
 *
 * **The spine is the calendar, not the invoice list.** Rows run from the
 * resident's move-in month to the current month with no gaps, so a month that
 * was never billed shows up as `NOT_BILLED` rather than silently not existing.
 * A missing invoice is exactly the thing worth seeing: it is usually a billing
 * run that skipped someone.
 *
 * **Read-only, like the matrix.** Nothing here creates an invoice; the defect
 * item 2.5 removed was a read that billed as a side effect, and this endpoint
 * would be the obvious place to reintroduce it.
 */

export type ResidentLedgerPayment = {
  amount: number;
  /** When the money moved, per the provider — not when we heard about it. */
  occurredAt: string;
  method: string;
  receiptNumber: string | null;
  settledAt: string | null;
  transactionCode: string | null;
};

export type ResidentLedgerMonth = {
  dueAmount: number;
  dueDate: string | null;
  invoiceId: string | null;
  /** The bill's lines, for the rent / discount / fine / khata breakdown. */
  lines: { amount: number; basis: string; description: string }[];
  /** `YYYY-MM`. The screen turns this into "July 2026". */
  period: string;
  paidAmount: number;
  /** Every settled payment against this month, oldest first. */
  payments: ResidentLedgerPayment[];
  status: string;
};

export type ResidentLedger = {
  months: ResidentLedgerMonth[];
  resident: {
    fullName: string;
    id: string;
    moveInDate: string | null;
    phone: string | null;
    roomType: string | null;
  };
  totals: {
    monthsBilled: number;
    monthsPaid: number;
    outstanding: number;
    paid: number;
  };
};

type ResidentDoc = {
  _id: Types.ObjectId;
  bedType?: string;
  firstName?: string;
  hostelId: Types.ObjectId;
  lastName?: string;
  moveInDate?: Date;
  phone?: string;
  roomType?: string;
};

/**
 * Every month from `start` to `end` inclusive, as **Bikram Sambat** period keys.
 *
 * ## Why this is the whole bug
 *
 * The spine of this ledger is the calendar and the flesh is `invoiceByPeriod`,
 * so the two only meet if the keys are the same string. This walked Gregorian
 * months — `cursor.setUTCMonth(cursor.getUTCMonth() + 1)` producing `2026-09` —
 * while every invoice after the cutover is keyed `2083-05`, and a `Map` lookup
 * that misses does not raise anything. It returns `undefined`, which this file
 * already has an honest meaning for: `NOT_BILLED`.
 *
 * So the screen did not break. It rendered a full year of tidy rows saying this
 * resident had never been billed, over invoices that existed, with
 * `monthsBilled: 0` and `outstanding: 0` in the totals beside them — for every
 * resident in every hostel. The silence is the reason the walk lives in the
 * shared calendar now instead of being re-implemented per service.
 *
 * Bounded, for the reason it always was: a typo'd year in `moveInDate` would
 * otherwise spin out a row per month for half a century. The bound now keeps the
 * newest months rather than the oldest, so one bad date costs a resident their
 * early history instead of hiding the month they are actually being chased for.
 */
function monthsBetween(start: Date, end: Date): string[] {
  return bsPeriodsBetween(hostelPeriodOf(start), hostelPeriodOf(end));
}

export async function getResidentLedger(
  hostelId: Types.ObjectId | string,
  residentId: string,
): Promise<ResidentLedger | null> {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(residentId)) {
    return null;
  }

  // Scoped by hostel in the query itself, not checked afterwards: a resident id
  // from another tenant must read as "no such resident", not as a row we then
  // remember to hide.
  const resident = await ResidentModel.findOne({
    _id: residentId,
    hostelId,
    isDeleted: { $ne: true },
  })
    .select("bedType firstName hostelId lastName moveInDate phone roomType")
    .lean<ResidentDoc | null>();

  if (!resident) {
    return null;
  }

  const invoices = await listResidentInvoices({ hostelId, residentId });

  const events = await PaymentEventModel.find({
    direction: "CREDIT",
    hostelId,
    residentId,
    status: "SETTLED",
  })
    .sort({ occurredAt: 1 })
    .limit(500)
    .lean<
      {
        _id: Types.ObjectId;
        amount: number;
        invoiceId?: Types.ObjectId | null;
        occurredAt: Date;
        provider?: string;
        providerTxnId?: string | null;
        rawPayload?: { transactionCode?: string | null };
        settledAt?: Date | null;
      }[]
    >();

  const receipts = events.length
    ? await ReceiptModel.find({ eventId: { $in: events.map((event) => event._id) } })
        .select("eventId receiptNumber")
        .lean<{ eventId?: Types.ObjectId | null; receiptNumber: string }[]>()
    : [];

  const receiptByEvent = new Map(
    receipts
      .filter((receipt) => receipt.eventId)
      .map((receipt) => [receipt.eventId!.toString(), receipt.receiptNumber]),
  );

  const paymentsByInvoice = new Map<string, ResidentLedgerPayment[]>();

  for (const event of events) {
    const key = event.invoiceId?.toString() ?? "";

    if (!key) {
      continue;
    }

    const list = paymentsByInvoice.get(key) ?? [];

    list.push({
      amount: event.amount,
      method: event.provider ?? "NONE",
      occurredAt: event.occurredAt.toISOString(),
      receiptNumber: receiptByEvent.get(event._id.toString()) ?? null,
      settledAt: event.settledAt?.toISOString() ?? null,
      transactionCode:
        event.rawPayload?.transactionCode ?? event.providerTxnId ?? null,
    });
    paymentsByInvoice.set(key, list);
  }

  const invoiceByPeriod = new Map(invoices.map((invoice) => [invoice.period, invoice]));

  // Newest first: the owner opened this because of *this* month, and scrolling
  // down is how you go back in time everywhere else in the product.
  const periods = monthsBetween(
    resident.moveInDate ?? invoices.at(-1)?.dueDate ?? new Date(),
    new Date(),
  ).reverse();

  const months: ResidentLedgerMonth[] = periods.map((period) => {
    const invoice = invoiceByPeriod.get(period) ?? null;

    return {
      dueAmount: invoice?.dueAmount ?? 0,
      dueDate: invoice?.dueDate?.toISOString() ?? null,
      invoiceId: invoice?.id ?? null,
      lines: invoice?.lines ?? [],
      paidAmount: invoice?.paidAmount ?? 0,
      payments: invoice ? (paymentsByInvoice.get(invoice.id) ?? []) : [],
      period,
      status: invoice?.status ?? "NOT_BILLED",
    };
  });

  return {
    months,
    resident: {
      fullName: `${resident.firstName ?? ""} ${resident.lastName ?? ""}`.trim(),
      id: resident._id.toString(),
      moveInDate: resident.moveInDate?.toISOString() ?? null,
      phone: resident.phone ?? null,
      roomType: resident.bedType ?? resident.roomType ?? null,
    },
    totals: {
      monthsBilled: months.filter((month) => month.invoiceId).length,
      monthsPaid: months.filter((month) => month.status === "PAID").length,
      outstanding: months.reduce(
        (sum, month) => sum + Math.max(month.dueAmount - month.paidAmount, 0),
        0,
      ),
      paid: months.reduce((sum, month) => sum + month.paidAmount, 0),
    },
  };
}
