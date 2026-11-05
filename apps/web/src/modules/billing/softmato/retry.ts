import "server-only";

import { BookingModel } from "@hostel/db/models/Booking";
import { SoftmatoTaskModel } from "@hostel/db/models/SoftmatoTask";
import { SubscriptionInvoiceModel } from "@hostel/db/models/SubscriptionInvoice";
import { sendEmail } from "@hostel/shared/email/sender";
import { softmatoBackEmail } from "@hostel/shared/email/templates/billing/softmato-back";

import { connectToDatabase } from "@/lib/db";
import { submitFieldCash } from "@/modules/billing/cash-filing.service";
import { ensureInvoiceRaised, type InvoiceRecord } from "@/modules/billing/subscription.service";
import { ensureBookingInvoice } from "@/modules/bookings/booking-softmato.service";
import { refileBookingRefund } from "@/modules/bookings/booking-refund.service";
import type { BookingRecord } from "@/modules/bookings/booking-views";

import { isSoftmatoDown } from "./client";
import { softmato } from "./client";
import { isSoftmatoConfigured } from "./config";

type Task = {
  _id: unknown;
  email?: string | null;
  kind: string;
  link?: string | null;
  name?: string | null;
  ref: string;
};

/**
 * Keeps the promise `outage.ts` made: once Softmato answers again, finish what
 * waited and email the person the link. Runs on the every-minute cron; costs
 * one read when nothing is waiting. Returns whether the person still has
 * something to do (only then is the email sent).
 */
const HANDLERS: Record<string, (task: Task) => Promise<boolean>> = {
  BOOKING_PAYMENT: async (task) => {
    const booking = await BookingModel.findById(task.ref).lean<BookingRecord | null>();

    if (booking?.status !== "AWAITING_PAYMENT") return false;

    await ensureBookingInvoice(booking);

    return true;
  },
  CASH_FILING: async (task) => {
    await submitFieldCash(task.ref, task.name ?? null);

    return false; // it emails the owner itself
  },
  PLAN_PAYMENT: async (task) => {
    const invoice = await SubscriptionInvoiceModel.findById(task.ref).lean<InvoiceRecord | null>();

    if (!invoice || invoice.status === "PAID" || invoice.status === "VOID") return false;

    await ensureInvoiceRaised(invoice, { required: true });

    return true;
  },
  REFUND_FILING: async (task) => {
    await refileBookingRefund(task.ref);

    return false;
  },
};

export async function retrySoftmatoTasks(now = new Date()) {
  if (!isSoftmatoConfigured()) return { done: 0 };

  await connectToDatabase();

  const tasks = await SoftmatoTaskModel.find({ attempts: { $lt: 50 }, doneAt: null })
    .sort({ createdAt: 1 })
    .limit(20)
    .lean<Task[]>();

  if (tasks.length === 0) return { done: 0 };

  // Back yet? A "not found" is an answer; only silence or a 5xx is not.
  try {
    await softmato().getInvoice("INV-0000/00-000000");
  } catch (error) {
    if (isSoftmatoDown(error)) return { done: 0, down: true };
  }

  let done = 0;

  for (const task of tasks) {
    try {
      const needsPerson = await (HANDLERS[task.kind] ?? (async () => false))(task);

      if (needsPerson && task.email && task.link) await sendEmail({ ...softmatoBackEmail({ link: task.link, name: task.name }), to: task.email });

      await SoftmatoTaskModel.updateOne({ _id: task._id }, { $set: { doneAt: now } });
      done += 1;
    } catch (error) {
      await SoftmatoTaskModel.updateOne(
        { _id: task._id },
        { $inc: { attempts: 1 }, $set: { lastError: String(error).slice(0, 300) } },
      );

      if (isSoftmatoDown(error)) break;
    }
  }

  return { done };
}
