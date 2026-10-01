import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { addBsMonths, formatBsDate, formatBsPeriod } from "@/lib/hostel-day";
import { logger } from "@/lib/logger";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { activationUrl, issueActivationCode } from "@/modules/residents/activation.service";
import {
  appUrl,
  getHostelName,
  resolveHostelStaffUserIds,
  resolveResidentContact,
  sendNotificationEmail,
} from "@/modules/residents/resident-notify";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { ResidentModel } from "@hostel/db/models/Resident";
import { UserModel } from "@hostel/db/models/User";
import { existingResidentAddedEmail } from "@hostel/shared/email/templates/resident/existing-resident-added";

/**
 * Telling people about an existing-residents list once it is added
 * (docs/EXISTING_RESIDENTS.md).
 *
 * ## One message per resident, and it carries their money
 *
 * A resident who has paid hears "your hostel is now on the platform, your rent is
 * paid till Aswin, your next bill is for Kartik". One who has not hears the same
 * opening and then exactly what is due — each month and the old dues on its own
 * line with its code, one total, one pay-by date. Not a welcome now and a bill
 * later: the bills are raised in the same press, so the message that says hello
 * is the message that says what is owed.
 *
 * Email to the address on the record. When that address already has an account,
 * its bell (which is also the push) gets "confirm your hostel" — the account is
 * not linked yet, and the person says it is them when they open the app
 * (`residency-invite.service.ts`). A resident with no email — a phone number in a
 * notebook — is reached by the hostel, and the staff summary says how many.
 *
 * ## A way in without asking the hostel
 *
 * The intake's own email tells an unlinked resident to ask the desk for an
 * activation code. For one person at a counter that is fine; for forty people
 * added from a spreadsheet it is forty conversations. So an unlinked resident
 * with an email gets a fresh activation link in the same email.
 *
 * ## Nothing here can undo the add
 *
 * Runs after the response, and every failure is logged and swallowed — the
 * residents and their bills are already written.
 */

/**
 * Tells the app to ask "is this you?" now rather than on its next open. Frozen
 * with `apps/mobile/src/lib/residency-invite.ts`.
 */
const RESIDENCY_INVITE = "RESIDENCY_INVITE";
const OPEN = ["OPEN", "PARTIAL", "OVERDUE"];
const CONCURRENCY = 5;

type AddedResident = { rent: number | null; residentId: Types.ObjectId };

type ResidentDoc = {
  _id: Types.ObjectId;
  depositAmount?: number;
  email?: string;
  firstName: string;
  hostelId: Types.ObjectId;
  lastName: string;
  paidTill?: string | null;
  roomType: string;
  userId?: Types.ObjectId;
};

type InvoiceDoc = {
  _id: Types.ObjectId;
  dueDate: Date;
  kind: string;
  lines?: { description: string }[];
  period?: string | null;
  referenceCode?: string;
  totalAmount: number;
};

function monthLabel(period: string) {
  return (formatBsPeriod(period) || period).replace(/\s*BS$/, "");
}

function dueLabel(invoice: InvoiceDoc) {
  if (invoice.kind === "MONTHLY_RENT" && invoice.period) {
    return `${monthLabel(invoice.period)} rent`;
  }

  return invoice.kind === "ADJUSTMENT" ? "Old dues" : (invoice.lines?.[0]?.description ?? "Bill");
}

async function tellOne(
  added: AddedResident,
  context: { hostelId: Types.ObjectId; hostelName: string; principal: ApiPrincipal },
): Promise<"emailed" | "app-only" | "unreached"> {
  const resident = await ResidentModel.findById(added.residentId)
    .select("depositAmount email firstName hostelId lastName paidTill roomType userId")
    .lean<ResidentDoc | null>();

  if (!resident) {
    return "unreached";
  }

  const invoices = await InvoiceModel.find({
    hostelId: context.hostelId,
    residentId: resident._id,
    status: { $in: OPEN },
  })
    .select("dueDate kind lines period referenceCode totalAmount")
    .sort({ period: 1, issuedAt: 1 })
    .lean<InvoiceDoc[]>();

  // Rent months first, oldest first, then the old dues — the order they happened.
  const ordered = [
    ...invoices.filter((invoice) => invoice.kind === "MONTHLY_RENT"),
    ...invoices.filter((invoice) => invoice.kind !== "MONTHLY_RENT"),
  ];
  const dues = ordered.map((invoice) => ({
    amount: invoice.totalAmount,
    code: invoice.referenceCode ?? null,
    label: dueLabel(invoice),
  }));
  const payBy = ordered.length
    ? formatBsDate(new Date(Math.max(...ordered.map((invoice) => new Date(invoice.dueDate).getTime()))))
    : "";
  const paidTill = resident.paidTill ? monthLabel(resident.paidTill) : "";
  const nextBillMonth = resident.paidTill ? monthLabel(addBsMonths(resident.paidTill, 1)) : "";
  // Linked already — scanned at the desk, or their own join request — so there is nothing to confirm.
  const account = resident.userId
    ? { _id: resident.userId }
    : resident.email
    ? await UserModel.findOne({ email: resident.email.toLowerCase(), isDeleted: { $ne: true } })
        .select("_id")
        .lean<{ _id: Types.ObjectId } | null>()
    : null;
  const userId = account?._id.toString() ?? null;

  if (resident.userId) {
    await createInAppNotification({
      actionUrl: "/resident/payments",
      body: `${context.hostelName} added you as a resident. Your rent and bills are in the app.`,
      category: "ACCOUNT",
      // The account just became a resident's: the app rotates its session on this (`push-link.ts`).
      data: { type: "RESIDENT_REGISTERED" },
      priority: "NORMAL",
      title: `Welcome to ${context.hostelName}`,
      userId: resident.userId.toString(),
    });
  } else if (userId) {
    await createInAppNotification({
      body: `${context.hostelName} added you as a resident. Open to confirm it is you.`,
      category: "ACCOUNT",
      data: { type: RESIDENCY_INVITE },
      priority: "NORMAL",
      title: "Confirm your hostel",
      userId,
    });
  }

  const contact = await resolveResidentContact(resident);

  if (!contact) {
    return userId ? "app-only" : "unreached";
  }

  let activation: { expiresOn: string; url: string } | null = null;

  if (!userId) {
    try {
      const issued = await issueActivationCode(resident, context.principal);

      activation = {
        expiresOn: formatBsDate(issued.expiresAt).replace(/\s*BS$/, ""),
        url: activationUrl(issued.code),
      };
    } catch (error) {
      logger.warn("Existing resident: activation link could not be made", {
        error: error instanceof Error ? error.message : String(error),
        residentId: resident._id.toString(),
      });
    }
  }

  const email = existingResidentAddedEmail({
    activation,
    dashboardUrl: appUrl("/login"),
    offerProgramUrl: appUrl("/resident-offer-program"),
    depositPaid: resident.depositAmount ?? 0,
    dues,
    hasAccount: Boolean(userId),
    hostelName: context.hostelName,
    monthlyRent: added.rent,
    nextBillMonth,
    paidTill,
    payBy,
    residentName: resident.firstName,
    roomType: resident.roomType,
  });

  const sent = await sendNotificationEmail({
    action: "existing_resident_added",
    html: email.html,
    subject: email.subject,
    to: contact.email,
  });

  return sent ? "emailed" : userId ? "app-only" : "unreached";
}

export async function notifyExistingResidentsAdded(input: {
  added: AddedResident[];
  billsRaised: number;
  hostelId: Types.ObjectId;
  principal: ApiPrincipal;
}): Promise<{ emailed: number; unreached: number }> {
  const counts = { "app-only": 0, emailed: 0, unreached: 0 };

  if (input.added.length === 0) {
    return { emailed: 0, unreached: 0 };
  }

  const hostelName = await getHostelName(input.hostelId);
  const context = { hostelId: input.hostelId, hostelName, principal: input.principal };

  // A few at a time: forty residents is forty emails, and the mail provider and
  // the database both prefer a steady trickle to a burst.
  for (let index = 0; index < input.added.length; index += CONCURRENCY) {
    const outcomes = await Promise.all(
      input.added.slice(index, index + CONCURRENCY).map(async (added) => {
        try {
          return await tellOne(added, context);
        } catch (error) {
          logger.warn("Existing resident could not be told", {
            error: error instanceof Error ? error.message : String(error),
            residentId: added.residentId.toString(),
          });

          return "unreached" as const;
        }
      }),
    );

    for (const outcome of outcomes) {
      counts[outcome] += 1;
    }
  }

  try {
    const staff = await resolveHostelStaffUserIds(input.hostelId);
    const count = input.added.length;

    await Promise.all(
      staff.map((userId) =>
        createInAppNotification({
          actionUrl: "/hostel-admin/residents",
          body: [
            `${input.billsRaised} ${input.billsRaised === 1 ? "bill" : "bills"} made`,
            `${counts.emailed} emailed`,
            counts.unreached ? `${counts.unreached} with no email — tell them yourself` : null,
          ]
            .filter(Boolean)
            .join(" · "),
          category: "RESIDENT",
          hostelId: input.hostelId.toString(),
          title: `${count} existing ${count === 1 ? "resident" : "residents"} added`,
          userId,
        }),
      ),
    );
  } catch (error) {
    logger.warn("Existing residents: staff summary failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { emailed: counts.emailed, unreached: counts.unreached };
}
