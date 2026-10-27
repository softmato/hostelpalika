import { roomTypeLabel } from "@hostel/shared/constants/room-types";
import { Types } from "mongoose";

import { createInAppNotification } from "@/modules/notifications/notification.service";
import { formatBsPeriod } from "@/lib/hostel-day";
import { periodBounds } from "@/modules/finance/fee-schedule.service";
import {
  appUrl,
  getHostelName,
  resolveHostelStaffUserIds,
  resolveResidentContact,
  sendNotificationEmail,
} from "@/modules/residents/resident-notify";
import { residentRegisteredEmail } from "@hostel/shared/email/templates/resident/resident-registered";

/**
 * Everybody who should hear that a hostel just took a resident on.
 *
 * ## Why this module exists at all
 *
 * Registering somebody was, until this, the quietest write in the product. It
 * spends a bed, raises up to two invoices, promotes an account and starts a
 * rent obligation — and it told nobody. The resident learned about it if and
 * only if the intake happened to find an existing platform account to promote
 * (`residentLinkedEmail`), which is the minority case at a desk; the owner
 * learned about it by opening a screen; and nothing reached a phone at all.
 *
 * ## Push comes free, and that is the point of routing it through here
 *
 * `createInAppNotification` fans every row out to the recipient's socket and
 * their devices (`publishNewNotification`). So the durable bell row and the push
 * are one call, and there is no way for a caller to write one without the other
 * — which is exactly the drift that adding a `dispatchPush` at each call site
 * would guarantee.
 *
 * ## Nothing here may fail a registration
 *
 * Same rule the invoices already hold (`raiseFirstMonthInvoice`): by the time
 * this runs the resident exists, their bed is spent and their money is on the
 * ledger. A notification that throws would report "could not register" over a
 * registration that succeeded, and the warden would register them again — which
 * is how the duplicate-refusal path gets exercised by accident. Every failure in
 * here is logged and swallowed.
 */
/**
 * The marker the mobile app reads to know its own role just changed.
 *
 * Duplicated as a literal in `apps/mobile/src/lib/push-link.ts` rather than
 * imported: the two ship on different clocks, and a phone that has not updated
 * in a month is reading today's payloads. A shared constant would suggest they
 * move together, which is exactly what must not be assumed — so the string is
 * frozen, and both sides carry a comment pointing at the other.
 */
const RESIDENT_REGISTERED = "RESIDENT_REGISTERED";

export async function notifyResidentRegistered(input: {
  admissionFee: number | null;
  /** Resolved by the intake, when it managed to link an account. */
  residentUserId?: string | null;
  /** That account was made by this registration, off the form's email. */
  newLogin?: boolean;
  depositAmount: number | null;
  firstMonth: {
    amount: number;
    dueDate?: Date;
    invoiceId: string;
    period: string;
    prorated: boolean;
    referenceCode?: string | null;
  } | null;
  hostelId: Types.ObjectId | string;
  monthlyRent: number | null;
  resident: {
    _id: Types.ObjectId;
    email?: string;
    firstName: string;
    lastName: string;
    moveInDate: Date;
    roomNumber?: string | null;
    roomType: string;
    userId?: Types.ObjectId;
  };
}): Promise<void> {
  try {
    const hostelName = await getHostelName(input.hostelId);
    const residentName =
      `${input.resident.firstName} ${input.resident.lastName}`.trim();
    const room = [roomTypeLabel(input.resident.roomType), input.resident.roomNumber]
      .filter(Boolean)
      .join(" · ");

    await Promise.all([
      notifyTheResident({ ...input, hostelName }),
      notifyTheHostel({ ...input, residentName, room }),
      emailTheResident({ ...input, hostelName }),
    ]);
  } catch (error) {
    console.warn(
      JSON.stringify({
        action: "resident_registered_notification_failed",
        level: "warn",
        message: error instanceof Error ? error.message : "Unknown notification error",
        residentId: input.resident._id.toString(),
      }),
    );
  }
}

/**
 * The resident's own phone.
 *
 * Only reachable when an account was linked — a resident registered at the desk
 * with no platform account has no device token, and there is nothing to push
 * to. That case is covered by the email below, which is the whole reason the
 * email is not conditional on the link.
 *
 * The category decides where a tap lands, so it follows what actually happened:
 * a resident who has been invoiced is sent to that invoice, and one who has not
 * is sent to their profile rather than to a payments screen with nothing on it.
 *
 * ## `type` is what turns the app into the resident app
 *
 * This is the one notification in the product that is *about the recipient's own
 * role changing*. Registering them promoted a `PUBLIC` account to `RESIDENT`
 * server-side, but every request the phone makes is authorised from the claims
 * baked into its access token — so until that token expires, the app they are
 * holding is still the public browsing app, and it will stay that way for the
 * rest of the token's life however many times they reopen it.
 *
 * The mobile client watches for this marker and re-reads the session when it
 * arrives, which rotates the token and lands them in the resident tabs
 * (`marksRoleChange` in `lib/push-link.ts`, `usePush`). It is sent whether or
 * not an invoice was raised, because the promotion happened either way.
 *
 * `data` is spread verbatim into the Expo payload by `sendPushToUsers`, so this
 * reaches the phone on the push as well as sitting on the durable bell row.
 */
async function notifyTheResident(input: {
  firstMonth: { amount: number; invoiceId: string; period: string } | null;
  hostelId: Types.ObjectId | string;
  hostelName: string;
  residentUserId?: string | null;
}) {
  const userId = input.residentUserId;

  if (!userId) {
    return;
  }

  await createInAppNotification({
    body: input.firstMonth
      ? `You are registered at ${input.hostelName}. Your rent for ${formatBsPeriod(input.firstMonth.period) || input.firstMonth.period} is NPR ${input.firstMonth.amount.toLocaleString("en-US")}.`
      : `You are registered at ${input.hostelName}.`,
    category: input.firstMonth ? "PAYMENT" : "ACCOUNT",
    data: {
      type: RESIDENT_REGISTERED,
      ...(input.firstMonth ? { invoiceId: input.firstMonth.invoiceId } : {}),
    },
    hostelId: input.hostelId.toString(),
    priority: "NORMAL",
    title: "You are registered",
    userId,
  });
}

/**
 * The owner, the hostel's admins **and its wardens** — including whoever
 * performed the intake.
 *
 * The actor is deliberately not excluded. A warden registering somebody at the
 * desk sees a toast that is gone in four seconds; the bell row is the durable
 * record that it happened, and on a shared front desk the owner's copy of it is
 * the only way they ever see an intake they did not do.
 *
 * ## The wardens were missing, and they are the ones at the desk
 *
 * The audience used to come from `resolveHostelAdminContacts`, which answers
 * "who do we email": owners and `HOSTEL_ADMIN` members, and only those with an
 * address on file. Resolving a *notification* audience from an email helper
 * meant the person actually performing intakes never heard about one — not in
 * the bell, and therefore not on their phone, since `createInAppNotification`
 * fans both out together. `resolveHostelStaffUserIds` asks the question this
 * call site is actually asking.
 *
 * `actionUrl` is the web portal's path — it is what the bell links to there —
 * and the app maps it to its own residents tab (`lib/push-link.ts`), which is
 * that file's entire job.
 */
async function notifyTheHostel(input: {
  hostelId: Types.ObjectId | string;
  resident: { _id: Types.ObjectId; moveInDate: Date };
  residentName: string;
  room: string;
}) {
  const staff = await resolveHostelStaffUserIds(input.hostelId);

  await Promise.all(
    staff.map(async (userId) => {
      await createInAppNotification({
        actionUrl: "/hostel-admin/residents",
        body: `${input.residentName} — ${input.room || "no room recorded"}, moving in ${input.resident.moveInDate.toDateString()}.`,
        category: "RESIDENT",
        data: { residentId: input.resident._id.toString() },
        hostelId: input.hostelId.toString(),
        title: "New resident registered",
        userId,
      });
    }),
  );
}

/**
 * The confirmation of what was agreed, to whatever address we have.
 *
 * Sent whether or not an account was linked, which is the gap this closes:
 * `residentLinkedEmail` only ever reached the minority of residents who already
 * had a platform account, so the ones registered at a desk — the ones who just
 * handed over a deposit — got nothing at all.
 *
 * `resolveResidentContact` prefers the address on the resident record and falls
 * back to the linked account's, and returns null for a phone-only registration,
 * which is a real intake rather than a failure.
 */
async function emailTheResident(input: {
  admissionFee: number | null;
  depositAmount: number | null;
  firstMonth: {
    amount: number;
    /** The bill's own due date; the month's last day when absent. */
    dueDate?: Date;
    period: string;
    prorated: boolean;
    referenceCode?: string | null;
  } | null;
  hostelName: string;
  monthlyRent: number | null;
  resident: {
    _id: Types.ObjectId;
    email?: string;
    firstName: string;
    lastName: string;
    moveInDate: Date;
    roomNumber?: string | null;
    roomType: string;
    userId?: Types.ObjectId;
  };
  residentUserId?: string | null;
  newLogin?: boolean;
}) {
  /*
   * The account we *just* linked, not the one the record remembers.
   *
   * `input.resident` is the document as it was created — the intake reads it
   * back only when the link succeeded, and this notification is handed the
   * in-memory copy either way, so its `userId` is still empty at this point.
   * A resident registered from a scanned card with the email box left blank
   * therefore resolved to no contact at all and was sent nothing, even though
   * the card had already resolved them to an account with a working address.
   * `residentUserId` is that account, and it is the reason it is passed in.
   */
  const contact = await resolveResidentContact({
    ...input.resident,
    userId:
      input.resident.userId ??
      (input.residentUserId ? new Types.ObjectId(input.residentUserId) : undefined),
  });

  if (!contact) {
    return;
  }

  const email = residentRegisteredEmail({
    admissionFee: input.admissionFee,
    dashboardUrl: residentDashboardUrl(),
    depositAmount: input.depositAmount,
    firstMonth: input.firstMonth
      ? {
          amount: input.firstMonth.amount,
          // The billing run dates a month's invoice to the last day of that
          // month, so this is derived rather than passed — one answer to "when
          // is it due", in the module that decides it. `lastDay`, not `end`:
          // `end` is 23:59:59.999 UTC, which Nepal has already carried into the
          // next morning, so a Bhadra invoice would be emailed as due in Aswin.
          dueDate: input.firstMonth.dueDate ?? periodBounds(input.firstMonth.period).lastDay,
          period: input.firstMonth.period,
          prorated: input.firstMonth.prorated,
          referenceCode: input.firstMonth.referenceCode,
        }
      : null,
    hostelName: input.hostelName,
    monthlyRent: input.monthlyRent,
    moveInDate: input.resident.moveInDate,
    residentName: input.resident.firstName,
    roomNumber: input.resident.roomNumber,
    roomType: input.resident.roomType,
    signIn: input.residentUserId ? (input.newLogin ? "NEW_ACCOUNT" : "EXISTING_ACCOUNT") : "ACTIVATION_CODE",
    signInEmail: contact.email,
  });

  await sendNotificationEmail({
    action: "resident_registered",
    html: email.html,
    subject: email.subject,
    to: contact.email,
  });
}

/**
 * The resident portal's own front door.
 *
 * `appUrl` is the shared origin helper every other notification module already
 * uses, so this is the same URL `residentLinkedEmail` sends — one origin, read
 * from one place.
 */
function residentDashboardUrl() {
  return appUrl("/resident/dashboard");
}
