import type { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { planPayLink } from "@/modules/billing/plan-pay-link";
import { Role } from "@/lib/roles";
import {
  attach,
  formatEmailDate,
  hostelBillingUrl,
  registrationStatusUrl,
} from "@/modules/hostels/hostel-registration.events";
import {
  DAILY_FROM_DAYS,
  remindsToday,
} from "@/modules/notifications/platform-push-schedule";
import { PLAN_DUE_NOTIFICATION_TYPE } from "@/modules/notifications/push-routing";
import { sendPushToUsers } from "@/modules/notifications/push.service";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelMemberModel } from "@hostel/db/models/HostelMember";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { SubscriptionInvoiceModel } from "@hostel/db/models/SubscriptionInvoice";
import { SubscriptionPaymentModel } from "@hostel/db/models/SubscriptionPayment";
import { formatBsDate, hostelDayEnd, hostelDaysBetween } from "@hostel/shared/calendar/bs";
import { sendEmail } from "@hostel/shared/email/sender";
import {
  planDueSoonEmail,
  planOverdueEmail,
} from "@hostel/shared/email/templates/billing/plan-due";
import { formatRupees } from "@hostel/shared/email/templates/billing/subscription-invoice";
import type { EmailContent } from "@hostel/shared/email/templates/layout";

/**
 * Reminders to a hostel about a plan payment that has not arrived.
 *
 * ## When
 *
 * Two automatic rows on the superadmin Push tab run this — 08:00 and 21:00
 * Nepal time (`AUTOMATIC_PUSHES` in `platform-push.service.ts`). A week and five
 * days before the due day the morning run reminds once; from three days before,
 * both runs remind, every day, until the bill is paid. The email is sparser than
 * the push — see {@link planEmailsToday}.
 *
 * | Channel | Goes to | Opens |
 * |---|---|---|
 * | Email | the owner | the billing page on the website, or the registration progress page for a hostel not live yet |
 * | Push | the hostel's admin accounts, live hostel only | Billing — `/manage/billing` in the app, `/{slug}/admin/billing` on the web |
 *
 * ## Push states facts, email says where to pay
 *
 * The app takes no plan payments, and Google Play's payments policy also bars
 * in-app messaging that points to another way to pay for business software. So
 * the push is the amount, the plan and the day, and a tap opens the Billing
 * screen — while the email, which is outside the app, carries the website link.
 *
 * ## Why "late" needs a live hostel
 *
 * A self-registered hostel's invoice has a due date too, but nothing about it
 * is late: the hostel is simply not published until it pays. An open renewal on
 * an active plan is the owner paying early, not owing. `PAST_DUE` — live, and
 * money still owed — is the only state where a missed date means something.
 *
 * ## Quiet while proof is with us, and on the day the invoice went
 *
 * An owner who has sent a payment claim is waiting on a person, not late. And
 * the day an invoice is raised its own email already gave the amount and date.
 *
 * ## Once per run
 *
 * The row's `nextRunAt` advance is the claim (`dispatchDuePlatformPushes`), so a
 * run happens once however many cron ticks overlap, and a run the cron missed
 * is skipped rather than replayed. One reminder per hostel per run, about its
 * earliest open bill.
 */

export type PlanReminderRun = { devices: number; emails: number; recipients: number };

type InvoiceRow = {
  _id: Types.ObjectId;
  amount: number;
  billedTo?: { email?: string; hostelName?: string; name?: string };
  createdAt?: Date;
  dueAt: Date;
  hostelId: Types.ObjectId;
  invoiceNumber: string;
  issuedAt?: Date | null;
  planName: string;
  subscriptionId: Types.ObjectId;
};

type HostelRow = {
  _id: Types.ObjectId;
  contact?: { email?: string };
  name?: string;
  ownerId?: Types.ObjectId;
  slug?: string;
  status?: string;
};

type UserRow = { _id: Types.ObjectId; email?: string; name?: string; role?: string };

type Reminder = {
  /** Admin accounts to push to. Empty for a hostel that is not live. */
  admins: string[];
  hostel: HostelRow;
  invoice: InvoiceRow;
  outstanding: number;
  ownerName?: string;
  /** The owner's address, or empty when this run sends no email. */
  to: string;
};

/** Whether a plan bill is reminded about on this run. **Pure.** */
export function planRemindsToday(input: {
  /** A payment claim for this invoice is waiting on a person. */
  claimInReview: boolean;
  /** Nepal days from the day the invoice was raised to today. */
  daysSinceIssue: number;
  /** Nepal days from today to the due day: 0 on the day, negative once late. */
  daysUntilDue: number;
  earlyDays: readonly number[];
  /** The hostel is live and still owes — `PAST_DUE`. */
  owingWhileLive: boolean;
}) {
  if (input.claimInReview || input.daysSinceIssue <= 0) {
    return false;
  }

  if (input.daysUntilDue < 0 && !input.owingWhileLive) {
    return false;
  }

  return remindsToday(input.daysUntilDue, input.earlyDays);
}

/**
 * Whether the morning run's reminder also goes by email. **Pure.**
 *
 * A week out, three days out, the due day, then once a week while it stays
 * unpaid. The push already goes twice a day from three days out; a daily email
 * on top of it is what made owners feel hounded.
 */
export function planEmailsToday(daysUntilDue: number) {
  return daysUntilDue === 7 || daysUntilDue === 3 || (daysUntilDue <= 0 && daysUntilDue % 7 === 0);
}

export async function sendPlanDueReminders(input: {
  earlyDays: readonly number[];
  /** The morning run emails the owner too. */
  email: boolean;
  now?: Date;
}): Promise<PlanReminderRun> {
  await connectToDatabase();

  const now = input.now ?? new Date();
  const totals: PlanReminderRun = { devices: 0, emails: 0, recipients: 0 };

  // ponytail: one unpaged read — plan invoices are one per hostel per period;
  // page by `_id` like `dunning.service` if hostels ever number in the thousands.
  const invoices = await SubscriptionInvoiceModel.find({
    dueAt: { $lte: hostelDayEnd(now, Math.max(DAILY_FROM_DAYS, ...input.earlyDays)), $ne: null },
    status: { $in: ["OPEN", "PARTIAL"] },
  })
    .sort({ dueAt: 1 })
    .lean<InvoiceRow[]>();

  if (invoices.length === 0) {
    return totals;
  }

  const context = await loadContext(invoices);
  const reminded = new Set<string>();
  const reminders: Reminder[] = [];

  // Earliest due first, so the one reminder a hostel gets is its most urgent bill.
  for (const invoice of invoices) {
    const key = invoice._id.toString();
    const hostelKey = invoice.hostelId.toString();
    const hostel = context.hostels.get(hostelKey);
    const outstanding = Math.max(0, invoice.amount - (context.settled.get(key) ?? 0));

    if (!hostel || outstanding <= 0 || reminded.has(hostelKey)) {
      continue;
    }

    const daysUntilDue = hostelDaysBetween(now, invoice.dueAt);
    const due = planRemindsToday({
      claimInReview: context.inReview.has(key),
      daysSinceIssue: hostelDaysBetween(invoice.issuedAt ?? invoice.createdAt ?? now, now),
      daysUntilDue,
      earlyDays: input.earlyDays,
      owingWhileLive: context.pastDue.has(invoice.subscriptionId.toString()),
    });

    if (!due) {
      continue;
    }

    const owner = hostel.ownerId ? context.users.get(hostel.ownerId.toString()) : undefined;
    const to = input.email && planEmailsToday(daysUntilDue)
      ? owner?.email || hostel.contact?.email || invoice.billedTo?.email || ""
      : "";
    const admins = isLive(hostel) ? (context.admins.get(hostelKey) ?? []) : [];

    if (!to && admins.length === 0) {
      continue;
    }

    reminded.add(hostelKey);
    reminders.push({
      admins,
      hostel,
      invoice,
      outstanding,
      ownerName: owner?.name || invoice.billedTo?.name,
      to,
    });
  }

  const outcomes = await Promise.all(reminders.map((item) => deliver(item, now)));

  for (const outcome of outcomes) {
    totals.devices += outcome.devices;
    totals.emails += outcome.email ? 1 : 0;
    totals.recipients += outcome.recipients;
  }

  return totals;
}

function isLive(hostel: HostelRow) {
  return hostel.status === "PUBLISHED" && Boolean(hostel.slug);
}

/** Everything the invoices need beyond themselves, in a handful of reads. */
async function loadContext(batch: InvoiceRow[]) {
  const { UserModel } = await import("@hostel/db/models/User");
  const invoiceIds = batch.map((invoice) => invoice._id);

  const [hostels, pastDue, payments] = await Promise.all([
    HostelModel.find({
      _id: { $in: batch.map((invoice) => invoice.hostelId) },
      isDeleted: { $ne: true },
    })
      .select("contact name ownerId slug status")
      .lean<HostelRow[]>(),
    HostelSubscriptionModel.find({
      _id: { $in: batch.map((invoice) => invoice.subscriptionId) },
      status: "PAST_DUE",
    })
      .select("_id")
      .lean<{ _id: Types.ObjectId }[]>(),
    /*
     * Settled money and claims in review, together. Only `SETTLED` reduces the
     * balance — the same rule as `outstandingFor` — while a claim only silences
     * the reminder.
     */
    SubscriptionPaymentModel.aggregate<{
      _id: { invoiceId: Types.ObjectId; status: string };
      total: number;
    }>([
      { $match: { invoiceId: { $in: invoiceIds }, status: { $in: ["IN_REVIEW", "SETTLED"] } } },
      {
        $group: {
          _id: { invoiceId: "$invoiceId", status: "$status" },
          total: { $sum: "$amount" },
        },
      },
    ]),
  ]);

  /*
   * Push goes to the owner and the hostel's active admin members — the accounts
   * that can open Billing. Wardens are left out: plan billing is not in their
   * portal.
   */
  const liveHostels = hostels.filter(isLive);
  const members =
    liveHostels.length > 0
      ? await HostelMemberModel.find({
          hostelId: { $in: liveHostels.map((hostel) => hostel._id) },
          isDeleted: { $ne: true },
          role: Role.HOSTEL_ADMIN,
          status: "ACTIVE",
        })
          .select("hostelId userId")
          .lean<{ hostelId: Types.ObjectId; userId: Types.ObjectId }[]>()
      : [];

  const userIds = [
    ...hostels.flatMap((hostel) => (hostel.ownerId ? [hostel.ownerId] : [])),
    ...members.map((member) => member.userId),
  ];
  const users =
    userIds.length > 0
      ? await UserModel.find({ _id: { $in: userIds }, isDeleted: { $ne: true } })
          .select("email name role")
          .lean<UserRow[]>()
      : [];
  const usersById = new Map(users.map((user) => [user._id.toString(), user]));

  const admins = new Map<string, string[]>();

  for (const hostel of liveHostels) {
    const candidates = [
      ...(hostel.ownerId ? [hostel.ownerId.toString()] : []),
      ...members
        .filter((member) => member.hostelId.toString() === hostel._id.toString())
        .map((member) => member.userId.toString()),
    ];

    admins.set(hostel._id.toString(), [
      // An owner whose account was never made an admin cannot open Billing.
      ...new Set(candidates.filter((id) => usersById.get(id)?.role === Role.HOSTEL_ADMIN)),
    ]);
  }

  const settled = new Map<string, number>();
  const inReview = new Set<string>();

  for (const row of payments) {
    const key = row._id.invoiceId.toString();

    if (row._id.status === "SETTLED") {
      settled.set(key, row.total);
    } else {
      inReview.add(key);
    }
  }

  return {
    admins,
    hostels: new Map(hostels.map((hostel) => [hostel._id.toString(), hostel])),
    inReview,
    pastDue: new Set(pastDue.map((subscription) => subscription._id.toString())),
    settled,
    users: usersById,
  };
}

/** Never throws. A failed push or email is simply not counted — the next run reminds again. */
async function deliver(item: Reminder, now: Date) {
  const [email, push] = await Promise.all([
    item.to ? deliverEmail(item, now) : false,
    item.admins.length > 0
      ? sendPushToUsers(item.admins, {
          ...composeNotice(item, now),
          category: "PAYMENT",
          data: {
            hostelSlug: item.hostel.slug ?? "",
            invoiceNumber: item.invoice.invoiceNumber,
            subscriptionInvoiceId: item.invoice._id.toString(),
            type: PLAN_DUE_NOTIFICATION_TYPE,
          },
          hostelId: item.hostel._id.toString(),
          priority: "NORMAL",
        }).catch(() => null)
      : null,
  ]);

  return {
    devices: push?.sent ?? 0,
    email,
    recipients: push ? item.admins.length : 0,
  };
}

/** The push text. Facts only — see the file header. */
export function composePlanDueNotice(input: {
  dueAt: Date;
  hostelName: string;
  invoiceNumber: string;
  now: Date;
  outstanding: number;
  planName: string;
}) {
  const daysUntilDue = hostelDaysBetween(input.now, input.dueAt);
  const dueDay = formatBsDate(input.dueAt);
  const body = `${formatRupees(input.outstanding)} for ${input.planName} · ${input.hostelName}${
    dueDay ? `, due ${dueDay}` : ""
  }. Invoice ${input.invoiceNumber}.`;

  if (daysUntilDue < 0) {
    const late = -daysUntilDue;

    return { body, title: `Plan payment overdue by ${late} ${late === 1 ? "day" : "days"}` };
  }

  const when =
    daysUntilDue === 0 ? "today" : daysUntilDue === 1 ? "tomorrow" : `in ${daysUntilDue} days`;

  return { body, title: `Plan payment due ${when}` };
}

function composeNotice(item: Reminder, now: Date) {
  return composePlanDueNotice({
    dueAt: item.invoice.dueAt,
    hostelName: item.hostel.name || item.invoice.billedTo?.hostelName || "",
    invoiceNumber: item.invoice.invoiceNumber,
    now,
    outstanding: item.outstanding,
    planName: item.invoice.planName,
  });
}

function composeEmail(item: Reminder, now: Date, attached: boolean, payLink?: string): EmailContent {
  const { hostel, invoice } = item;
  const live = hostel.status === "PUBLISHED";
  const daysUntilDue = hostelDaysBetween(now, invoice.dueAt);
  const common = {
    amountDue: item.outstanding,
    attached,
    dueDate: formatEmailDate(invoice.dueAt) ?? "",
    hostelName: hostel.name || invoice.billedTo?.hostelName || "",
    invoiceNumber: invoice.invoiceNumber,
    ownerName: item.ownerName,
    // A live hostel pays from its billing page; one waiting to go live, from
    // the registration progress page that publishes it.
    payUrl: live && hostel.slug ? (payLink ?? hostelBillingUrl(hostel.slug)) : registrationStatusUrl(),
    planName: invoice.planName,
  };

  return daysUntilDue < 0
    ? planOverdueEmail(common)
    : planDueSoonEmail({ ...common, daysUntilDue, live });
}

/** Never throws — `sendEmail` reports failure in its result. */
async function deliverEmail(item: Reminder, now: Date) {
  const { to } = item;
  const { invoiceNumber } = item.invoice;
  // A reminder carries the invoice it is chasing, same as the email that raised it.
  const attachments = await attach("invoice", invoiceNumber);
  // The emailed link opens the checkout on this hostel, no sign-in (`plan-pay-link.ts`).
  const payLink =
    item.hostel.status === "PUBLISHED" && item.hostel.slug
      ? await planPayLink({ slug: item.hostel.slug }, hostelBillingUrl(item.hostel.slug))
      : undefined;
  const message = composeEmail(item, now, attachments.length > 0, payLink);
  const result = await sendEmail({
    ...(attachments.length ? { attachments } : {}),
    category: message.category,
    html: message.html,
    subject: message.subject,
    to,
  }).catch((error: unknown) => ({ reason: String(error), sent: false }));

  if (!result.sent) {
    console.warn(
      JSON.stringify({
        action: "plan_due_email_failed",
        invoiceNumber,
        level: "warn",
        reason: "reason" in result ? result.reason : undefined,
      }),
    );
  }

  return result.sent;
}
