import type { Types } from "mongoose";
import { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { hostelDaysBetween } from "@/lib/hostel-day";
import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { notifyResident, notifyResidentsBatch } from "@/modules/finance/finance-notify";
import { recomputeInvoiceBalance } from "@/modules/finance/payment-event.service";
import { HostelSettingsModel } from "@hostel/db/models/HostelSettings";
import { InvoiceModel } from "@hostel/db/models/Invoice";

/**
 * Fine for paying rent late.
 *
 * The hostel picks rupees a day or a percent of the bill a day, and how many
 * days from the 1st a bill may be paid without one. With it on, the billing run
 * dates the month's bill on that day, and the daily pass below writes one
 * `Late fine` line on every rent bill still unpaid after it — recomputed from
 * scratch each run (days late × rate), so a missed or doubled cron run lands on
 * the same figure.
 *
 * The line carries the rule it was first charged at (`fineMode`/`fineRate`), so
 * changing the rate moves only bills that fall late afterwards. Turning the fine
 * off stops every fine where it stands; waiving one removes it from that bill
 * for good. A bill is never fined for days before the fine was switched on.
 */

export type LateFineMode = "PER_DAY_AMOUNT" | "PER_DAY_PERCENT";

export type LateFineSettings = {
  enabled: boolean;
  graceDays: number;
  mode: LateFineMode;
  rate: number;
};

type StoredLateFine = Partial<LateFineSettings> & { enabledAt?: Date | null };

const DEFAULTS: LateFineSettings = {
  enabled: false,
  graceDays: 5,
  mode: "PER_DAY_AMOUNT",
  rate: 0,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const lateFineSaveSchema = z
  .object({
    enabled: z.boolean(),
    graceDays: z.number().int().min(1).max(28),
    hostelId: z.string().optional(),
    mode: z.enum(["PER_DAY_AMOUNT", "PER_DAY_PERCENT"]),
    rate: z.number().min(0),
  })
  .superRefine((input, context) => {
    if (!input.enabled) {
      return;
    }

    const valid =
      input.mode === "PER_DAY_AMOUNT"
        ? Number.isInteger(input.rate) && input.rate >= 1 && input.rate <= 5000
        : input.rate >= 0.1 && input.rate <= 10 && Math.round(input.rate * 100) === input.rate * 100;

    if (!valid) {
      context.addIssue({
        code: "custom",
        message:
          input.mode === "PER_DAY_AMOUNT"
            ? "Fine a day must be whole rupees, 1 to 5,000."
            : "Percent a day must be 0.1 to 10.",
        path: ["rate"],
      });
    }
  });

function rupees(amount: number) {
  return `Rs ${amount.toLocaleString("en-US")}`;
}

/** Day `graceDays` of the month — the bill's due date when the fine is on. */
export function fineDueDate(periodStart: Date, graceDays: number): Date {
  return new Date(periodStart.getTime() + (graceDays - 1) * MS_PER_DAY);
}

/**
 * The fine one bill carries today, or null when it carries none.
 *
 * `baseAmount` is the bill without its fine. A percent rule rounds the daily
 * figure to whole rupees once, so "Rs 80 a day × 3 days" always multiplies out.
 */
export function lateFineLine(input: {
  baseAmount: number;
  dueDate: Date;
  enabledAt: Date | null;
  mode: LateFineMode;
  now: Date;
  rate: number;
}) {
  const from =
    input.enabledAt && input.enabledAt.getTime() > input.dueDate.getTime()
      ? input.enabledAt
      : input.dueDate;
  const days = hostelDaysBetween(from, input.now);
  const perDay =
    input.mode === "PER_DAY_AMOUNT"
      ? Math.round(input.rate)
      : Math.round((Math.max(input.baseAmount, 0) * input.rate) / 100);

  if (days <= 0 || perDay <= 0) {
    return null;
  }

  const dayWord = days === 1 ? "1 day" : `${days} days`;

  return {
    amount: perDay * days,
    basis: "FINE" as const,
    description:
      input.mode === "PER_DAY_AMOUNT"
        ? `Late fine — ${rupees(perDay)} a day × ${dayWord}`
        : `Late fine — ${input.rate}% of ${rupees(input.baseAmount)} a day (${rupees(perDay)}) × ${dayWord}`,
    fineMode: input.mode,
    fineRate: input.rate,
  };
}

function readSettings(stored: StoredLateFine | undefined): LateFineSettings & {
  enabledAt: Date | null;
} {
  return {
    enabled: stored?.enabled ?? DEFAULTS.enabled,
    enabledAt: stored?.enabledAt ?? null,
    graceDays: stored?.graceDays ?? DEFAULTS.graceDays,
    mode: stored?.mode ?? DEFAULTS.mode,
    rate: stored?.rate ?? DEFAULTS.rate,
  };
}

export async function getLateFine(hostelId: Types.ObjectId | string) {
  await connectToDatabase();

  const row = await HostelSettingsModel.findOne({ hostelId })
    .select("lateFine")
    .lean<{ lateFine?: StoredLateFine } | null>();

  return readSettings(row?.lateFine);
}

export async function saveLateFine(
  hostelId: Types.ObjectId | string,
  input: LateFineSettings,
  principal: ApiPrincipal,
) {
  const before = await getLateFine(hostelId);
  const enabledAt =
    input.enabled && !before.enabled ? new Date() : before.enabledAt;

  await HostelSettingsModel.updateOne(
    { hostelId },
    {
      $set: {
        lateFine: {
          enabled: input.enabled,
          enabledAt,
          graceDays: input.graceDays,
          mode: input.mode,
          rate: input.rate,
        },
        updatedBy: principal.userId,
      },
      $setOnInsert: { createdBy: principal.userId },
    },
    { upsert: true },
  );

  await publishResourceChange({
    hostelIds: [String(hostelId)],
    topics: [REALTIME_TOPIC.PAYMENTS],
  });

  return { ...input, enabledAt };
}

type FineableInvoice = {
  _id: Types.ObjectId;
  dueDate: Date;
  lines: {
    amount: number;
    basis: string;
    fineMode?: LateFineMode;
    fineRate?: number;
  }[];
  totalAmount: number;
};

/**
 * The bill with its fine brought up to today, or null when nothing changes.
 * Pure, so the daily pass and its test share one answer.
 */
export function refineInvoice(
  invoice: FineableInvoice,
  settings: { enabledAt: Date | null; mode: LateFineMode; rate: number },
  now: Date,
) {
  const existing = invoice.lines.find((line) => line.basis === "FINE");
  const others = invoice.lines.filter((line) => line.basis !== "FINE");
  const baseAmount = others.reduce((sum, line) => sum + line.amount, 0);
  const line = lateFineLine({
    baseAmount,
    dueDate: invoice.dueDate,
    enabledAt: settings.enabledAt,
    mode: existing?.fineMode ?? settings.mode,
    now,
    rate: existing?.fineRate ?? settings.rate,
  });

  if (!line || line.amount === existing?.amount) {
    return null;
  }

  return {
    lines: [...others, line],
    totalAmount: baseAmount + line.amount,
  };
}

/**
 * The daily pass, run by `cron/billing-cycle` after it bills.
 *
 * Only rent bills, only unpaid ones, only hostels with the fine on. The write is
 * conditional on the total it read, so a payment or a waive landing mid-pass
 * wins and the bill is simply picked up again tomorrow.
 */
export async function accrueLateFines(now = new Date()) {
  await connectToDatabase();

  const hostels = await HostelSettingsModel.find({ "lateFine.enabled": true })
    .select("hostelId lateFine")
    .lean<{ hostelId: Types.ObjectId; lateFine?: StoredLateFine }[]>();

  let invoicesFined = 0;

  for (const hostel of hostels) {
    const settings = readSettings(hostel.lateFine);
    const invoices = await InvoiceModel.find({
      dueDate: { $lt: now },
      fineWaived: { $ne: true },
      hostelId: hostel.hostelId,
      kind: "MONTHLY_RENT",
      status: { $in: ["OPEN", "OVERDUE", "PARTIAL"] },
    })
      .select("dueDate lines residentId totalAmount")
      .lean<(FineableInvoice & { residentId: Types.ObjectId })[]>();

    let changed = 0;
    // Only the day a fine first lands is news — a daily fine growing is not a push a day.
    const firstFined: { body: string; data: Record<string, string>; residentId: string }[] = [];

    for (const invoice of invoices) {
      const next = refineInvoice(invoice, settings, now);

      if (!next) {
        continue;
      }

      const result = await InvoiceModel.updateOne(
        { _id: invoice._id, totalAmount: invoice.totalAmount },
        { $set: next },
      );

      changed += result.modifiedCount;

      if (result.modifiedCount > 0 && !invoice.lines.some((line) => line.basis === "FINE")) {
        firstFined.push({
          body: `A late fine was added. Your bill is now NPR ${next.totalAmount.toLocaleString("en-US")}.`,
          data: { invoiceId: invoice._id.toString(), type: "LATE_FINE_ADDED" },
          residentId: invoice.residentId.toString(),
        });
      }
    }

    await notifyResidentsBatch({
      hostelId: hostel.hostelId,
      pushBody: "Your rent is overdue and a late fine was added. Tap to pay.",
      rows: firstFined,
      title: "Late fine added",
    });

    if (changed > 0) {
      invoicesFined += changed;
      await publishResourceChange({
        hostelIds: [hostel.hostelId.toString()],
        topics: [REALTIME_TOPIC.PAYMENTS],
      });
    }
  }

  return { hostels: hostels.length, invoicesFined };
}

/**
 * Takes the fine off one bill and keeps it off.
 *
 * Refused once money has covered the fine — that money is real, and the honest
 * correction then is a reversal, not a smaller bill.
 */
export async function waiveLateFine(
  invoiceId: string,
  hostelIds: string[],
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const invoice = await InvoiceModel.findOne({
    _id: invoiceId,
    hostelId: { $in: hostelIds },
  }).lean<
    (FineableInvoice & { hostelId: Types.ObjectId; residentId: Types.ObjectId; status: string }) | null
  >();

  if (!invoice) {
    throw new FinanceServiceError("Invoice was not found.", "INVOICE_NOT_FOUND");
  }

  if (invoice.status === "PAID") {
    throw new FinanceServiceError(
      "This bill is already paid, fine included.",
      "INVOICE_ALREADY_PAID",
    );
  }

  const others = invoice.lines.filter((line) => line.basis !== "FINE");

  await InvoiceModel.updateOne(
    { _id: invoice._id },
    {
      $set: {
        fineWaived: true,
        lines: others,
        totalAmount: others.reduce((sum, line) => sum + line.amount, 0),
        updatedBy: principal.userId,
      },
    },
  );
  // Money already in may now cover the smaller bill.
  await recomputeInvoiceBalance(invoice._id);

  await publishResourceChange({
    hostelIds: [invoice.hostelId.toString()],
    topics: [REALTIME_TOPIC.PAYMENTS],
  });

  await notifyResident({
    body: "The late fine on your bill was waived.",
    data: { invoiceId: invoice._id.toString(), type: "LATE_FINE_WAIVED" },
    hostelId: invoice.hostelId,
    residentId: invoice.residentId,
    title: "Late fine waived",
  });

  return { invoiceId: invoice._id.toString() };
}
