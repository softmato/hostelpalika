import type { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { hostelDaysBetween } from "@/lib/hostel-day";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { getOperationsConfig } from "@/modules/platform-config/operations-config";
import { withRun } from "@/modules/finance/reconciliation/run-recorder";
import {
  appUrl,
  getHostelName,
  resolveHostelAdminContacts,
  resolveResidentContact,
  sendNotificationEmail,
  sendNotificationEmailBatch,
} from "@/modules/residents/resident-notify";
import { InvoiceBalanceModel } from "@hostel/db/models/InvoiceBalance";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { ResidentModel } from "@hostel/db/models/Resident";
import { paymentDueReminderEmail } from "@hostel/shared/email/templates/payment/payment-due-reminder";
import type { ReminderStage } from "@hostel/shared/email/templates/payment/payment-due-reminder";
import { paymentOverdueEmail } from "@hostel/shared/email/templates/payment/payment-overdue";
import {
  type PaymentLine,
  unpaidFeesEmail,
} from "@hostel/shared/email/templates/hostel/staff-alerts";

/**
 * Reminders and overdue chases (target §10.3, plan item 5.2).
 *
 * Three defects of the job this replaces, and the shape of each fix:
 *
 * 1. **`.limit(500)`, platform-wide, with no pagination.** Not a safety valve —
 *    a silent cap. The 501st open invoice on the platform was never chased and
 *    nothing said so. Fixed early, in 2.8, by the id cursor below.
 * 2. **Exact-day equality** (`daysUntilDue === N`). A single missed cron run
 *    skipped that resident *permanently*, because the day it would have fired
 *    never comes back. Replaced by a **stage recorded on the invoice**: the
 *    question is no longer "is today the day" but "has this invoice been chased
 *    at this stage yet", which a late run answers correctly and a double-run
 *    answers once.
 * 3. **No stop condition.** Chases continued forever. The ladder now terminates:
 *    three reminders (a week out, three days out, the due day) → first overdue
 *    on day three → second on day seven → four weekly chases → escalate to the
 *    owner → stop. After `STOPPED` the software never contacts the
 *    resident about this invoice again. That is the line between dunning and
 *    harassment, and it belongs in code rather than in a hostel's restraint.
 *
 * Every run writes a `ReconciliationRun` (§5.4), so a job that has been throwing
 * for a fortnight is visible rather than silent — which is exactly the failure
 * current §5.6 describes, where the run stats were returned to nobody.
 */

type DunningState = {
  chaseCount?: number;
  lastNotifiedAt?: Date | null;
  stage?: DunningStage;
};

/**
 * The rungs, in the order an invoice climbs them.
 *
 * `REMINDED` is the first of **three** notices before the due date, not the only
 * one — it keeps its name so invoices already sitting on that rung when this
 * shipped carry on from where they are rather than being re-reminded.
 */
export type DunningStage =
  | "CHASING"
  | "ESCALATED"
  | "NONE"
  | "OVERDUE_FIRST"
  | "OVERDUE_SECOND"
  /** A week out, or whatever `paymentReminderDaysBefore` says. */
  | "REMINDED"
  /** The due day itself. */
  | "REMINDED_DUE"
  /** Three days out. */
  | "REMINDED_SOON"
  | "STOPPED";

type InvoiceRow = {
  _id: Types.ObjectId;
  dueDate: Date;
  dunning?: DunningState;
  hostelId: Types.ObjectId;
  period?: string;
  residentId: Types.ObjectId;
  status: string;
  totalAmount: number;
};

type ResidentRow = {
  _id: Types.ObjectId;
  email?: string;
  firstName: string;
  hostelId: Types.ObjectId;
  lastName: string;
  userId?: Types.ObjectId;
};

const OPEN_STATUSES = ["OPEN", "PARTIAL", "OVERDUE"];
const BATCH_SIZE = 200;

/**
 * Weekly chases before the invoice becomes a person's problem instead of a
 * cron's. Four is a month: long enough that a resident who is simply late still
 * gets there on their own, short enough that a genuinely stuck account reaches
 * the owner while the resident is still living there.
 */
export const MAX_CHASES = 4;
const CHASE_INTERVAL_DAYS = 7;

/**
 * The second pre-due notice. The first is the hostel's own
 * `paymentReminderDaysBefore` (a week by default) and the third is the due day.
 *
 * Three notices before a bill is late, then nothing for two days, then the
 * overdue notice on day three: a resident who has simply forgotten has been
 * told twice with time to act, and one who has not paid by the third day late
 * is being chased about something real rather than nagged about a date.
 */
const REMINDER_SOON_DAYS = 3;

/**
 * How late the first overdue notice waits, and the second.
 *
 * The first used to be day one, which reached residents whose transfer had
 * cleared the day before and had not been verified yet — the most common
 * complaint about the old job. Day three is past that.
 */
const OVERDUE_FIRST_DAYS = 3;
const OVERDUE_SECOND_DAYS = 7;

/**
 * Whole days in Kathmandu. The local `setHours` this replaced counted UTC days
 * on the server, right only while the job ran between 05:45 and midnight Nepal
 * time.
 */
const daysBetween = hostelDaysBetween;

export type PaymentReminderRun = {
  escalated: number;
  markedOverdue: number;
  overdueNotified: number;
  reminded: number;
  scanned: number;
  stopped: number;
};

export type DunningAction = {
  /** What to send. `stop` sends nothing and only closes the ladder. */
  kind: "chase" | "escalate" | "overdue" | "reminder" | "stop";
  stage: DunningStage;
};

/**
 * The next thing owed on an invoice, or null for "nothing today". **Pure.**
 *
 * The whole correctness argument of this rebuild lives in this function, so it
 * takes no clock and no database: every threshold is `>=`, never `===`, which is
 * what makes a missed day self-healing — a run three days late still finds the
 * stage unreached and acts. Re-running the same day finds the stage already
 * recorded and does nothing, so the job stays idempotent without a lock.
 */
export function nextDunningAction(input: {
  chaseCount: number;
  daysSinceLastNotice: number | null;
  daysUntilDue: number;
  reminderDaysBefore: number;
  stage: DunningStage;
}): DunningAction | null {
  const { chaseCount, daysSinceLastNotice, daysUntilDue, stage } = input;

  if (stage === "STOPPED") {
    return null;
  }

  // The ladder ends one run after the owner was told, so `ESCALATED` is a state
  // the invoice is observed in rather than one it passes straight through.
  if (stage === "ESCALATED") {
    return { kind: "stop", stage: "STOPPED" };
  }

  if (daysUntilDue >= 0) {
    /*
     * Three notices before the bill is late: the hostel's window (a week by
     * default), three days out, and the due day itself.
     *
     * **Read from the last rung backwards**, which is what keeps a late job
     * honest. A run that has not fired since Monday and wakes on the due date
     * sends *one* email — "due today" — rather than working up through "due in a
     * week" and "due in three days" on the three days after they were true. The
     * stage still records where it got to, so the rungs it skipped never fire
     * afterwards.
     */
    if (stage === "REMINDED_DUE") {
      return null;
    }

    if (daysUntilDue <= 0) {
      return { kind: "reminder", stage: "REMINDED_DUE" };
    }

    if (daysUntilDue <= REMINDER_SOON_DAYS && stage !== "REMINDED_SOON") {
      return { kind: "reminder", stage: "REMINDED_SOON" };
    }

    // The configurable one, and the only rung a hostel can move. A hostel that
    // sets a window of three days or fewer simply starts at the rung above.
    return stage === "NONE" && daysUntilDue <= input.reminderDaysBefore
      ? { kind: "reminder", stage: "REMINDED" }
      : null;
  }

  const daysOverdue = -daysUntilDue;
  const beforeOverdue =
    stage === "NONE" ||
    stage === "REMINDED" ||
    stage === "REMINDED_DUE" ||
    stage === "REMINDED_SOON";

  if (daysOverdue >= OVERDUE_FIRST_DAYS && beforeOverdue) {
    return { kind: "overdue", stage: "OVERDUE_FIRST" };
  }

  if (daysOverdue >= OVERDUE_SECOND_DAYS && stage === "OVERDUE_FIRST") {
    return { kind: "overdue", stage: "OVERDUE_SECOND" };
  }

  if (stage === "OVERDUE_SECOND" || stage === "CHASING") {
    if (chaseCount >= MAX_CHASES) {
      return { kind: "escalate", stage: "ESCALATED" };
    }

    // A chase is due a week after the *last notice*, not a week after the due
    // date — otherwise a late first run collapses four chases into one day.
    const readyForChase =
      daysSinceLastNotice === null || daysSinceLastNotice >= CHASE_INTERVAL_DAYS;

    return readyForChase && daysOverdue >= CHASE_INTERVAL_DAYS
      ? { kind: "chase", stage: "CHASING" }
      : null;
  }

  return null;
}

export async function runPaymentReminders(now = new Date()): Promise<PaymentReminderRun> {
  await connectToDatabase();

  const config = await getOperationsConfig();

  const { result } = await withRun(
    // Platform-wide: one row for the whole nightly pass rather than one per
    // hostel, because the job pages across every hostel's invoices at once.
    { hostelId: null, kind: "DUNNING", triggeredBy: "CRON" },
    async (recorder) => {
      const totals: PaymentReminderRun = {
        escalated: 0,
        markedOverdue: 0,
        overdueNotified: 0,
        reminded: 0,
        scanned: 0,
        stopped: 0,
      };

      const hostelNames = new Map<string, string>();
      // One rent email per resident per run, however many of their bills moved a
      // rung today; the bell still gets a row per bill.
      const emailedResidents = new Set<string>();
      // Owners hear about every resident who ran out of reminders in one email.
      const escalations = new Map<string, PaymentLine[]>();
      let cursor: Types.ObjectId | null = null;

      for (;;) {
        const batch: InvoiceRow[] = await InvoiceModel.find({
          status: { $in: OPEN_STATUSES },
          ...(cursor ? { _id: { $gt: cursor } } : {}),
        })
          // Ordered by id, not due date: the cursor has to be on the field it
          // pages by, or a batch boundary can skip or repeat invoices.
          .sort({ _id: 1 })
          .limit(BATCH_SIZE)
          .lean<InvoiceRow[]>();

        if (batch.length === 0) {
          break;
        }

        cursor = batch[batch.length - 1]!._id;
        totals.scanned += batch.length;
        recorder.count("scanned", batch.length);

        const [residents, balances] = await Promise.all([
          ResidentModel.find({
            _id: { $in: batch.map((invoice) => invoice.residentId) },
            isDeleted: false,
            status: { $ne: "MOVED_OUT" },
          }).lean<ResidentRow[]>(),
          InvoiceBalanceModel.find({
            invoiceId: { $in: batch.map((invoice) => invoice._id) },
          }).lean<{ invoiceId: Types.ObjectId; settledAmount: number }[]>(),
        ]);

        const residentById = new Map(
          residents.map((resident) => [resident._id.toString(), resident]),
        );
        const settledByInvoice = new Map(
          balances.map((balance) => [
            balance.invoiceId.toString(),
            balance.settledAmount,
          ]),
        );

        const planned: {
          action: DunningAction;
          invoice: InvoiceRow;
          outstanding: number;
          resident: ResidentRow;
        }[] = [];

        for (const invoice of batch) {
          const resident = residentById.get(invoice.residentId.toString());

          if (!resident) {
            continue;
          }

          const daysUntilDue = daysBetween(now, invoice.dueDate);

          if (daysUntilDue < 0 && invoice.status !== "OVERDUE") {
            // The status is derived everywhere else; here the derivation is
            // simply being applied on time rather than waiting for a payment.
            await InvoiceModel.updateOne(
              { _id: invoice._id },
              { $set: { status: "OVERDUE" } },
            );
            totals.markedOverdue += 1;
          }

          const action = nextDunningAction({
            chaseCount: invoice.dunning?.chaseCount ?? 0,
            daysSinceLastNotice: invoice.dunning?.lastNotifiedAt
              ? daysBetween(invoice.dunning.lastNotifiedAt, now)
              : null,
            daysUntilDue,
            reminderDaysBefore: config.paymentReminderDaysBefore,
            stage: invoice.dunning?.stage ?? "NONE",
          });

          if (!action) {
            continue;
          }

          planned.push({
            action,
            invoice,
            outstanding: Math.max(
              invoice.totalAmount -
                (settledByInvoice.get(invoice._id.toString()) ?? 0),
              0,
            ),
            resident,
          });
        }

        // Hostel names first, deduplicated: the loop below would otherwise fetch
        // the same name once per invoice.
        for (const item of planned) {
          const key = item.invoice.hostelId.toString();

          if (!hostelNames.has(key)) {
            hostelNames.set(key, await getHostelName(item.invoice.hostelId));
          }
        }

        // **Batched.** The old job awaited each send inside the loop, so a
        // hostel with three hundred overdue invoices ran three hundred round
        // trips end to end and routinely hit the function timeout — at which
        // point the tail of the list was silently never contacted.
        // Late notices first, so a resident's one email is about what is overdue.
        // ponytail: per batch — bills of one resident split across batches keep id order.
        planned.sort(
          (a, b) => Number(a.action.kind === "reminder") - Number(b.action.kind === "reminder"),
        );

        // Residents' emails are collected here and go out as one Resend batch
        // per page: two hundred single sends at once overran the per-second
        // limit, and a 429 was a reminder marked sent that nobody received.
        const emails: ResidentEmail[] = [];
        const outcomes = await Promise.all(
          planned.map((item) => {
            const residentKey = item.resident._id.toString();
            // The three-days-out rung is bell only: the fee push already goes
            // twice a day from then on.
            const email =
              config.sendPaymentEmails &&
              item.action.stage !== "REMINDED_SOON" &&
              !emailedResidents.has(residentKey);

            if (email) {
              emailedResidents.add(residentKey);
            }

            return deliver({
              action: item.action,
              email,
              emails,
              hostelName: hostelNames.get(item.invoice.hostelId.toString()) ?? "",
              invoice: item.invoice,
              outstanding: item.outstanding,
              resident: item.resident,
            });
          }),
        );

        await sendNotificationEmailBatch(emails);

        for (let index = 0; index < planned.length; index += 1) {
          const item = planned[index]!;
          const delivered = outcomes[index]!;

          if (!delivered) {
            recorder.count("errors");
            recorder.finding({
              code: "DUNNING_SEND_FAILED",
              detail: `stage ${item.action.stage}`,
              entityId: item.invoice._id,
              entityType: "Invoice",
              severity: "WARN",
            });
            continue;
          }

          await InvoiceModel.updateOne(
            { _id: item.invoice._id },
            {
              $set: {
                "dunning.lastNotifiedAt":
                  item.action.kind === "stop"
                    ? (item.invoice.dunning?.lastNotifiedAt ?? null)
                    : now,
                "dunning.stage": item.action.stage,
              },
              ...(item.action.kind === "chase"
                ? { $inc: { "dunning.chaseCount": 1 } }
                : {}),
            },
          );

          if (item.action.kind === "reminder") {
            totals.reminded += 1;
            recorder.count("reminded");
          } else if (item.action.kind === "overdue" || item.action.kind === "chase") {
            totals.overdueNotified += 1;
            recorder.count("overdueNotified");
          } else if (item.action.kind === "escalate") {
            const hostelKey = item.invoice.hostelId.toString();

            escalations.set(hostelKey, [
              ...(escalations.get(hostelKey) ?? []),
              {
                amount: item.outstanding,
                month: item.invoice.period,
                name: `${item.resident.firstName} ${item.resident.lastName}`.trim(),
              },
            ]);
            totals.escalated += 1;
            recorder.count("escalated");
            recorder.finding({
              code: "DUNNING_ESCALATED",
              detail: `${MAX_CHASES} chases sent with no payment; handed to the hostel`,
              entityId: item.invoice._id,
              entityType: "Invoice",
              severity: "WARN",
            });
          } else {
            totals.stopped += 1;
            recorder.count("stopped");
          }
        }

        if (batch.length < BATCH_SIZE) {
          break;
        }
      }

      if (config.sendPaymentEmails) {
        await Promise.all(
          [...escalations].map(([hostelId, residents]) =>
            emailEscalations(hostelId, hostelNames.get(hostelId) ?? "", residents),
          ),
        );
      }

      return totals;
    },
  );

  return result;
}

/**
 * Sends one rung of the ladder. Returns false if nothing could be delivered.
 *
 * The in-app notification always fires; `email` gates only the email — it
 * folds in `sendPaymentEmails` (§5.5, item 0.6). A hostel with email switched
 * off must still see its own reminders in the app, which is the bug that fix was
 * about.
 */
type ResidentEmail = Parameters<typeof sendNotificationEmailBatch>[0][number];

async function deliver(input: {
  action: DunningAction;
  /** Whether this rung may email the resident. The run decides — see above. */
  email: boolean;
  /** Where the resident's email is left for the page's one batch send. */
  emails: ResidentEmail[];
  hostelName: string;
  invoice: InvoiceRow;
  outstanding: number;
  resident: ResidentRow;
}): Promise<boolean> {
  try {
    const { action, invoice, resident } = input;
    const period = invoice.period ?? "";
    const hostelKey = invoice.hostelId.toString();

    if (action.kind === "stop") {
      // Nothing is sent. The ladder simply closes, and the escalation notice the
      // owner already has is the last word.
      return true;
    }

    if (action.kind === "escalate") {
      return await escalateToHostel({
        invoice,
        outstanding: input.outstanding,
        resident,
      });
    }

    const overdue = action.kind !== "reminder";
    const daysOverdue = Math.max(0, -daysBetween(new Date(), invoice.dueDate));

    /*
     * Which of the three pre-due notices this is. The stage is the only thing
     * that knows — `daysUntilDue` cannot be trusted for the wording, because a
     * job that ran late climbs to the rung it should be on and would otherwise
     * send "due in three days" on the day itself.
     */
    const reminderStage: ReminderStage =
      action.stage === "REMINDED_DUE"
        ? "TODAY"
        : action.stage === "REMINDED_SOON"
          ? "SOON"
          : "WEEK";

    if (resident.userId) {
      await createInAppNotification({
        body: overdue
          ? `Your ${period} fee is overdue.`
          : reminderStage === "TODAY"
            ? `Your ${period} fee is due today.`
            : `Your ${period} fee is due on ${invoice.dueDate.toDateString()}.`,
        category: "PAYMENT",
        data: { invoiceId: invoice._id.toString() },
        hostelId: hostelKey,
        // The bell row only: the resident's push is the automatic fee reminder
        // (`fee-due-reminders.service`), which would otherwise land beside it.
        push: false,
        title: overdue
          ? "Payment overdue"
          : reminderStage === "TODAY"
            ? "Payment due today"
            : "Payment due soon",
        userId: resident.userId.toString(),
      });
    }

    const contact = input.email ? await resolveResidentContact(resident) : null;

    if (!contact) {
      return true;
    }

    const email = overdue
      ? paymentOverdueEmail({
          amount: input.outstanding,
          daysOverdue,
          dueDate: invoice.dueDate,
          hostelName: input.hostelName,
          month: period,
          paymentsUrl: appUrl("/resident/payments"),
          residentName: contact.name,
        })
      : paymentDueReminderEmail({
          amount: input.outstanding,
          dueDate: invoice.dueDate,
          hostelName: input.hostelName,
          month: period,
          paymentsUrl: appUrl("/resident/payments"),
          residentName: contact.name,
          stage: reminderStage,
        });

    input.emails.push({
      action: overdue ? "payment_overdue" : "payment_due_reminder",
      html: email.html,
      subject: email.subject,
      to: contact.email,
      topic: "RENT_REMINDERS",
    });

    return true;
  } catch {
    // A failed send must not abort the batch. The stage is not advanced, so the
    // next run retries this rung rather than skipping to the following one.
    return false;
  }
}

/**
 * The end of the automated ladder: hand the invoice to a person (target §10.3).
 *
 * Deliberately a notification to the hostel's admins rather than another message
 * to the resident. Four weekly chases that produced nothing is not evidence that
 * a fifth would work — it is evidence that something the software cannot see is
 * wrong, and the only useful next step is a human who can knock on a door.
 */
async function escalateToHostel(input: {
  invoice: InvoiceRow;
  outstanding: number;
  resident: ResidentRow;
}): Promise<boolean> {
  const admins = await resolveHostelAdminContacts(input.invoice.hostelId);
  const body = `${escalationLine(input.resident, input.outstanding, input.invoice.period)} Automated reminders have stopped.`;

  await Promise.all(
    admins.map(async (admin) => {
      if (admin.userId) {
        await createInAppNotification({
          body,
          category: "PAYMENT",
          data: { invoiceId: input.invoice._id.toString() },
          hostelId: input.invoice.hostelId.toString(),
          title: "Unpaid fee needs your attention",
          userId: admin.userId.toString(),
        });
      }
    }),
  );

  return true;
}

function escalationLine(resident: ResidentRow, outstanding: number, period?: string | null) {
  const name = `${resident.firstName} ${resident.lastName}`.trim();

  return `${name} has not paid NPR ${outstanding.toLocaleString("en-IN")} for ${
    period ?? "an earlier period"
  } after ${MAX_CHASES} reminders.`;
}

/** One email per admin for every resident escalated in this run. */
async function emailEscalations(hostelId: string, hostelName: string, residents: PaymentLine[]) {
  const admins = await resolveHostelAdminContacts(hostelId);
  const email = unpaidFeesEmail({
    hostelName,
    paymentsUrl: appUrl("/hostel-admin/payments"),
    reminders: MAX_CHASES,
    residents,
  });

  await Promise.all(
    admins.map((admin) =>
      sendNotificationEmail({
        action: "payment_escalated",
        html: email.html,
        subject: email.subject,
        to: admin.email,
        topic: "PAYMENT_SUMMARY",
      }),
    ),
  );
}
