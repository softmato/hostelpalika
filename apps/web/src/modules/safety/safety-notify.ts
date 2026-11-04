import type { Types } from "mongoose";

import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { Role } from "@/lib/roles";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { GuardianAccessModel } from "@hostel/db/models/GuardianAccess";
import { GuardianModel } from "@hostel/db/models/Guardian";
import { HostelMemberModel } from "@hostel/db/models/HostelMember";
import { UserModel } from "@hostel/db/models/User";
import { sosAlertEmail } from "@hostel/shared/email/templates/guardian/sos-alert";
import {
  appUrl,
  getHostelName,
  resolveHostelAdminContacts,
  sendNotificationEmail,
  type Contact,
} from "@/modules/residents/resident-notify";

/** Active wardens of a hostel that can actually be reached by email. */
export async function resolveHostelWardenContacts(
  hostelId: Types.ObjectId | string,
): Promise<Contact[]> {
  const members = await HostelMemberModel.find({
    hostelId,
    isDeleted: { $ne: true },
    role: Role.WARDEN,
    status: "ACTIVE",
  }).lean<{ userId: Types.ObjectId }[]>();

  if (members.length === 0) {
    return [];
  }

  const users = await UserModel.find({
    _id: { $in: members.map((member) => member.userId) },
    isDeleted: { $ne: true },
  }).lean<{ _id: Types.ObjectId; email?: string; name?: string }[]>();

  return users
    .filter((user) => Boolean(user.email))
    .map((user) => ({
      email: user.email as string,
      name: user.name ?? "Warden",
      userId: user._id.toString(),
    }));
}

/**
 * Guardians linked to a resident. Only guardians whose access is live
 * (ACTIVE or already USED — a used invitation is an accepted one) are
 * returned, so a revoked or expired guardian stops receiving alerts.
 */
export async function resolveResidentGuardianContacts(
  hostelId: Types.ObjectId | string,
  residentId: Types.ObjectId | string,
): Promise<Contact[]> {
  const accesses = await GuardianAccessModel.find({
    hostelId,
    residentId,
    status: { $in: ["ACTIVE", "USED"] },
  }).lean<{ guardianId: Types.ObjectId; userId?: Types.ObjectId }[]>();

  if (accesses.length === 0) {
    return [];
  }

  const guardians = await GuardianModel.find({
    _id: { $in: accesses.map((access) => access.guardianId) },
  }).lean<
    { _id: Types.ObjectId; email?: string; firstName: string; lastName: string }[]
  >();
  const userIdByGuardianId = new Map(
    accesses.map((access) => [access.guardianId.toString(), access.userId?.toString()]),
  );

  return guardians
    .filter((guardian) => Boolean(guardian.email))
    .map((guardian) => ({
      email: guardian.email as string,
      name: `${guardian.firstName} ${guardian.lastName}`.trim(),
      userId: userIdByGuardianId.get(guardian._id.toString()),
    }));
}

/**
 * Emergency fan-out for an SOS (PHASES.md §4.1). Emails and in-app
 * notifications go out to every hostel admin, every active warden, and the
 * linked guardians when the resident left guardian alerting on.
 *
 * Every side effect is best-effort: the alert row is already persisted by the
 * time this runs, and a bounced email must never turn a raised SOS into an
 * error response (RULES.md).
 */
export async function fanOutSOSAlert(input: {
  alertId: string;
  guardianAlertEnabled: boolean;
  hostelId: Types.ObjectId;
  message?: string;
  residentId: Types.ObjectId;
  residentName: string;
  residentPhone?: string;
  triggeredAt: Date;
}) {
  const [hostelName, admins, wardens, guardians] = await Promise.all([
    getHostelName(input.hostelId),
    resolveHostelAdminContacts(input.hostelId),
    resolveHostelWardenContacts(input.hostelId),
    input.guardianAlertEnabled
      ? resolveResidentGuardianContacts(input.hostelId, input.residentId)
      : Promise.resolve([] as Contact[]),
  ]);

  const staff = [...admins, ...wardens].filter(
    (contact, index, all) =>
      all.findIndex((other) => other.email === contact.email) === index,
  );
  const staffUrl = appUrl("/hostel-admin/sos-alerts");
  const guardianUrl = appUrl("/guardian/safety");

  const deliveries: Promise<unknown>[] = [];

  for (const contact of staff) {
    const email = sosAlertEmail({
      actionUrl: staffUrl,
      hostelName,
      message: input.message,
      recipientKind: "STAFF",
      residentName: input.residentName,
      residentPhone: input.residentPhone,
      triggeredAt: input.triggeredAt,
    });

    deliveries.push(
      sendNotificationEmail({
        action: "sos_alert_staff",
        category: email.category, html: email.html,
        subject: email.subject,
        to: contact.email,
      }),
    );

    if (contact.userId) {
      deliveries.push(
        createInAppNotification({
          actionUrl: "/hostel-admin/sos-alerts",
          body: `${input.residentName} raised an emergency SOS. Respond immediately.`,
          category: "SOS",
          data: { alertId: input.alertId, priority: "URGENT" },
          hostelId: input.hostelId.toString(),
          kind: "ACTION",
          priority: "URGENT",
          title: "🚨 Emergency SOS",
          userId: contact.userId,
        }),
      );
    }
  }

  for (const contact of guardians) {
    const email = sosAlertEmail({
      actionUrl: guardianUrl,
      hostelName,
      message: input.message,
      recipientKind: "GUARDIAN",
      residentName: input.residentName,
      residentPhone: input.residentPhone,
      triggeredAt: input.triggeredAt,
    });

    deliveries.push(
      sendNotificationEmail({
        action: "sos_alert_guardian",
        category: email.category, html: email.html,
        subject: email.subject,
        to: contact.email,
      }),
    );

    if (contact.userId) {
      deliveries.push(
        createInAppNotification({
          body: `${input.residentName} raised an emergency SOS at ${hostelName}.`,
          category: "SOS",
          data: { alertId: input.alertId, priority: "URGENT" },
          hostelId: input.hostelId.toString(),
          priority: "URGENT",
          title: "🚨 Emergency SOS",
          userId: contact.userId,
        }),
      );
    }
  }

  const results = await Promise.allSettled(deliveries);

  // An SOS is the one event where a stale panel is genuinely dangerous, so the
  // whole hostel's safety screens are refreshed, not just the recipients'.
  await publishResourceChange({
    hostelIds: [input.hostelId.toString()],
    topics: [REALTIME_TOPIC.SAFETY],
  });

  return {
    guardiansNotified: guardians.length,
    staffNotified: staff.length,
    failures: results.filter((result) => result.status === "rejected").length,
  };
}
