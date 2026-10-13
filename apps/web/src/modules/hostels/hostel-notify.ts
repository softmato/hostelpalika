import type { Types } from "mongoose";

import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { Role } from "@/lib/roles";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import {
  appUrl,
  resolveHostelAdminContacts,
  sendNotificationEmail,
} from "@/modules/residents/resident-notify";
import { UserModel } from "@hostel/db/models/User";
import { hostelInquiryReceivedEmail } from "@hostel/shared/email/templates/hostel/inquiry-received";
import { newHostelPendingEmail } from "@hostel/shared/email/templates/platform/new-hostel-pending";

/**
 * Notifications for events on a hostel that previously reached nobody.
 *
 * Both functions here swallow their own errors. They are called after the row
 * that triggered them has already been written, and a failed email must never
 * turn a submitted inquiry or a submitted hostel registration into a failed
 * request (RULES.md §8, and the same pattern used by the complaint, notice and
 * SOS fan-outs).
 */

type HostelRef = {
  _id: Types.ObjectId;
  location?: { city?: string } | null;
  name: string;
  slug?: string;
};

/** EMAIL_SYSTEM.md §2.4 — tell the hostel's admins a public inquiry arrived. */
export async function notifyHostelOfInquiry(
  hostel: HostelRef,
  visitor: {
    email?: string;
    message?: string;
    name: string;
    phone?: string;
    preferredVisitDate?: Date;
  },
) {
  const contacts = await resolveHostelAdminContacts(hostel._id);

  if (contacts.length === 0) {
    return;
  }

  const dashboardUrl = appUrl("/hostel-admin/inquiries");
  const preferredVisitDate = visitor.preferredVisitDate
    ? visitor.preferredVisitDate.toISOString().slice(0, 10)
    : undefined;
  const email = hostelInquiryReceivedEmail({
    dashboardUrl,
    hostelName: hostel.name,
    message: visitor.message,
    preferredVisitDate,
    visitorEmail: visitor.email,
    visitorName: visitor.name,
    visitorPhone: visitor.phone,
  });

  await Promise.all(
    contacts.map(async (contact) => {
      await sendNotificationEmail({
        action: "hostel_inquiry_received",
        html: email.html,
        subject: email.subject,
        to: contact.email,
      });

      // `Contact.userId` is optional — a contact resolved by email alone has
      // no account to hang an in-app notification on.
      if (!contact.userId) {
        return;
      }

      await createInAppNotification({
        actionUrl: "/hostel-admin/inquiries",
        body: `${visitor.name} enquired about ${hostel.name}.`,
        category: "INQUIRY",
        data: { hostelId: hostel._id.toString() },
        hostelId: hostel._id.toString(),
        // An inquiry needs a human reply, not a button — deep link only.
        kind: "ACTION",
        title: "New inquiry",
        userId: contact.userId,
      }).catch(() => {});
    }),
  );

  await publishResourceChange({
    hostelIds: [hostel._id.toString()],
    topics: [REALTIME_TOPIC.INQUIRIES],
  });
}

/**
 * EMAIL_SYSTEM.md §7.1 — tell platform staff a hostel is waiting for review.
 *
 * Targets SUPERADMIN and PLATFORM_MODERATOR, because approving hostels is one
 * of the things a moderator is explicitly allowed to do (PRD.md §7).
 */
export async function notifyPlatformOfPendingHostel(
  hostel: HostelRef,
  owner: { email?: string; name?: string },
) {
  const staff = await UserModel.find({
    isDeleted: { $ne: true },
    role: { $in: [Role.SUPERADMIN, Role.PLATFORM_MODERATOR] },
    status: "ACTIVE",
  })
    .select("_id email name")
    .lean<{ _id: Types.ObjectId; email?: string; name?: string }[]>();

  if (staff.length === 0) {
    return;
  }

  const email = newHostelPendingEmail({
    city: hostel.location?.city,
    hostelName: hostel.name,
    ownerEmail: owner.email,
    ownerName: owner.name,
    queueUrl: appUrl("/platform/hostels"),
  });

  await Promise.all(
    staff.map(async (member) => {
      if (member.email) {
        await sendNotificationEmail({
          action: "platform_hostel_pending",
          html: email.html,
          subject: email.subject,
          to: member.email,
        });
      }

      await createInAppNotification({
        // Approving is a single decision with no required input, so it is
        // offered inline. Rejection asks for a reason, so it stays on the
        // review screen behind `actionUrl`.
        actions: [
          {
            endpoint: `/api/v1/platform/hostels/${hostel._id.toString()}/approve`,
            key: "approve",
            label: "Approve hostel",
            method: "PATCH",
            payload: {},
            tone: "primary",
          },
        ],
        actionUrl: "/platform/hostels",
        body: `${hostel.name}${
          hostel.location?.city ? ` (${hostel.location.city})` : ""
        } was submitted and is waiting for approval.`,
        category: "HOSTEL_APPROVAL",
        data: { hostelId: hostel._id.toString() },
        kind: "ACTION",
        title: "Hostel awaiting approval",
        userId: member._id.toString(),
      }).catch(() => {});
    }),
  );

  // Refresh the platform approval queue for any staff member with it open.
  await publishResourceChange({
    platform: true,
    topics: [REALTIME_TOPIC.HOSTELS],
  });
}

/** Bell + push to the owner. `type` routes the app (`push-routing.ts`); `actionUrl` the web bell. */
export async function notifyHostelOwnerOf(
  userId: Types.ObjectId | string,
  hostelId: Types.ObjectId | string,
  message: { actionUrl: string; body: string; title: string; type: string },
) {
  await createInAppNotification({
    actionUrl: message.actionUrl,
    body: message.body,
    category: "GENERAL",
    data: { hostelId: String(hostelId), type: message.type },
    hostelId: String(hostelId),
    priority: "HIGH",
    title: message.title,
    userId: String(userId),
  }).catch(() => null);
}
