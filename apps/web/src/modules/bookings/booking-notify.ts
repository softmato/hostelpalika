import "server-only";

import { Types } from "mongoose";

import { UserModel } from "@hostel/db/models/User";
import { sendEmail, type EmailAttachment } from "@hostel/shared/email/sender";
import { bookingsPausedEmail } from "@hostel/shared/email/templates/booking/hostel";
import { hostelBookingsPausedEmail } from "@hostel/shared/email/templates/booking/platform";
import { emailDateTime, type EmailContent } from "@hostel/shared/email/templates/layout";

import { Role } from "@/lib/roles";
import type { BookingRecord } from "@/modules/bookings/booking-views";
import { amountDue, stayDatesText } from "@/modules/bookings/short-stay";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { appUrl, resolveHostelAdminContacts } from "@/modules/residents/resident-notify";

/**
 * Who hears about a booking, and through which door.
 *
 * Three audiences: the person who booked (email + bell/push), the hostel's
 * admins (email + bell/push), and the platform's superadmins (email +
 * bell/push). Every function here swallows its own failures — a booking step
 * that has been written must never be reported as failed because a mailbox or
 * a phone did not answer.
 *
 * Bell rows use category `BOOKING` and carry `data.bookingId`, which is what the
 * app's push router opens.
 */

export const BOOKING_CATEGORY = "BOOKING";

export function when(value: Date | null | undefined) {
  return emailDateTime(value ?? null) ?? "";
}

export function guestBookingPath(booking: Pick<BookingRecord, "_id">) {
  return `/bookings/${String(booking._id)}`;
}

export function hostelBookingsPath(booking: Pick<BookingRecord, "hostelSnapshot">) {
  const slug = booking.hostelSnapshot.slug;

  return slug ? `/${encodeURIComponent(slug)}/admin/bookings` : "/hostel-admin/bookings";
}

export const PLATFORM_BOOKINGS_PATH = "/platform/bookings";

export function bookingFacts(booking: BookingRecord) {
  return {
    code: booking.code,
    fee: booking.fee,
    hostelName: booking.hostelSnapshot.name,
    monthlyRent: booking.monthlyRent,
    roomType: booking.roomType,
    stay: booking.stay
      ? { amount: booking.stay.amount, dates: stayDatesText(booking.stay), nights: booking.stay.nights }
      : null,
    total: amountDue(booking),
  };
}

async function deliver(
  action: string,
  to: string | null | undefined,
  message: EmailContent,
  attachments?: EmailAttachment[],
) {
  if (!to) return;

  try {
    const result = await sendEmail({
      ...(attachments?.length ? { attachments } : {}),
      category: message.category,
      html: message.html,
      subject: message.subject,
      to,
    });

    if (!result.sent) {
      console.warn(JSON.stringify({ action: `${action}_email_failed`, level: "warn", reason: result.reason, to }));
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        action: `${action}_email_failed`,
        level: "warn",
        reason: error instanceof Error ? error.message : String(error),
        to,
      }),
    );
  }
}

/** Who a booking bell is for. `push-routing.ts` picks the app screen from it. */
type BookingAudience = "GUEST" | "HOSTEL" | "PLATFORM";

async function bell(input: {
  audience: BookingAudience;
  body: string;
  booking: BookingRecord;
  hostelId?: string;
  path: string;
  priority?: "HIGH" | "NORMAL";
  title: string;
  type: string;
  userId: string;
}) {
  await createInAppNotification({
    actionUrl: input.path,
    body: input.body,
    category: BOOKING_CATEGORY,
    data: {
      audience: input.audience,
      bookingCode: input.booking.code,
      bookingId: String(input.booking._id),
      type: input.type,
    },
    hostelId: input.hostelId,
    priority: input.priority,
    title: input.title,
    userId: input.userId,
  }).catch(() => undefined);
}

/** The guest: their own email on the booking, and a bell on their account. */
export async function notifyGuest(
  booking: BookingRecord,
  input: {
    action: string;
    /** Papers that ride along with the mail — the invoice, the receipt. */
    attachments?: EmailAttachment[];
    body: string;
    email?: EmailContent;
    title: string;
    type: string;
  },
) {
  await Promise.all([
    input.email
      ? deliver(input.action, booking.guest.email, input.email, input.attachments)
      : Promise.resolve(),
    bell({
      audience: "GUEST",
      body: input.body,
      booking,
      path: guestBookingPath(booking),
      title: input.title,
      type: input.type,
      userId: String(booking.userId),
    }),
  ]);
}

/** Every admin of the hostel. `email` is built per person so it can greet them. */
export async function notifyHostel(
  booking: BookingRecord,
  input: {
    action: string;
    body: string;
    email?: (contact: { name?: string }) => EmailContent;
    priority?: "HIGH" | "NORMAL";
    title: string;
    type: string;
  },
) {
  const contacts = await resolveHostelAdminContacts(booking.hostelId).catch(() => []);

  await Promise.all(
    contacts.map(async (contact) => {
      if (input.email) {
        await deliver(input.action, contact.email, input.email(contact));
      }

      if (contact.userId) {
        await bell({
          audience: "HOSTEL",
          body: input.body,
          booking,
          hostelId: String(booking.hostelId),
          path: "/hostel-admin/bookings",
          priority: input.priority,
          title: input.title,
          type: input.type,
          userId: contact.userId,
        });
      }
    }),
  );
}

/** Every active superadmin: the people who check payments and send money. */
export async function notifyPlatform(
  booking: BookingRecord,
  input: { action: string; body: string; email?: EmailContent; tab: string; title: string; type: string },
) {
  try {
    const staff = await UserModel.find({
      isDeleted: { $ne: true },
      role: Role.SUPERADMIN,
      status: "ACTIVE",
    })
      .select("_id email")
      .lean<Array<{ _id: Types.ObjectId; email?: string }>>();

    await Promise.all(
      staff.map(async (member) => {
        if (input.email) {
          await deliver(input.action, member.email, input.email);
        }

        await bell({
          audience: "PLATFORM",
          body: input.body,
          booking,
          path: `${PLATFORM_BOOKINGS_PATH}?tab=${input.tab}`,
          title: input.title,
          type: input.type,
          userId: String(member._id),
        });
      }),
    );
  } catch {
    // The queues on Platform → Bookings are the guarantee; this is a courtesy.
  }
}

/** A superadmin switched a hostel's Book button off or back on. Bell only: no booking to email about. */
export async function notifyHostelBookingPause(
  hostelId: Types.ObjectId | string,
  input: { paused: boolean; reason: string | null },
) {
  const contacts = await resolveHostelAdminContacts(new Types.ObjectId(String(hostelId))).catch(() => []);

  await Promise.all(
    contacts.map((contact) =>
      contact.userId
        ? createInAppNotification({
            actionUrl: "/hostel-admin/bookings",
            body: input.paused
              ? `People can no longer book your hostel. ${input.reason ?? ""}`.trim()
              : "People can book your hostel again.",
            category: BOOKING_CATEGORY,
            data: { audience: "HOSTEL", type: input.paused ? "BOOKINGS_PAUSED" : "BOOKINGS_RESUMED" },
            hostelId: String(hostelId),
            priority: input.paused ? "HIGH" : "NORMAL",
            title: input.paused ? "Bookings paused" : "Bookings back on",
            userId: contact.userId,
          }).catch(() => undefined)
        : Promise.resolve(),
    ),
  );
}

/** The strike rule just switched a hostel's Book button off. Sent once, by the call that paused it. */
export async function announceBookingsPaused(
  booking: BookingRecord,
  rule: { strikes: number; windowDays: number },
) {
  const hostelName = booking.hostelSnapshot.name;
  const body = `${rule.strikes} missed or cancelled bookings in ${rule.windowDays} days. Bookings on ${hostelName} are paused.`;

  await Promise.all([
    notifyHostel(booking, {
      action: "bookings_paused",
      body,
      email: (contact) =>
        bookingsPausedEmail({
          bookingsUrl: appUrl(hostelBookingsPath(booking)),
          hostelName,
          name: contact.name,
          strikes: rule.strikes,
          windowDays: rule.windowDays,
        }),
      priority: "HIGH",
      title: "Bookings paused",
      type: "BOOKINGS_PAUSED",
    }),
    notifyPlatform(booking, {
      action: "hostel_bookings_paused",
      body,
      email: hostelBookingsPausedEmail({
        hostelName,
        reviewUrl: appUrl(`${PLATFORM_BOOKINGS_PATH}?tab=paused`),
        strikes: rule.strikes,
        windowDays: rule.windowDays,
      }),
      tab: "paused",
      title: "Hostel bookings paused",
      type: "BOOKINGS_PAUSED",
    }),
  ]);
}

export { appUrl };
