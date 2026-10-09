import type { Types } from "mongoose";

import { outboundUrl } from "@/lib/site";
import { Role } from "@/lib/roles";
import {
  emailPreferenceLinks,
  emailTopicMuted,
} from "@/modules/notifications/email-preference.service";
import type { EmailTopic } from "@/modules/notifications/email-topics";
import { HostelMemberModel } from "@hostel/db/models/HostelMember";
import { HostelModel } from "@hostel/db/models/Hostel";
import { ResidentModel } from "@hostel/db/models/Resident";
import { UserModel } from "@hostel/db/models/User";
import { sendEmail, sendEmailBatch } from "@hostel/shared/email/sender";
import type { EmailAttachment } from "@hostel/shared/email/sender";

export type Contact = {
  email: string;
  name: string;
  userId?: string;
};

export type ResidentRecipient = Contact & {
  residentId: string;
};

export function appUrl(path: string) {
  return `${outboundUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function getHostelName(hostelId: Types.ObjectId | string) {
  const hostel = await HostelModel.findOne({ _id: hostelId })
    .select("name")
    .lean<{ name?: string } | null>();

  return hostel?.name ?? "your hostel";
}

/**
 * Best contact address for a resident: their own record's email, falling back
 * to the linked user account. Returns `null` when neither exists — residents
 * can be registered phone-only.
 */
export async function resolveResidentContact(resident: {
  _id: Types.ObjectId;
  email?: string;
  firstName: string;
  lastName: string;
  userId?: Types.ObjectId;
}): Promise<ResidentRecipient | null> {
  const name = `${resident.firstName} ${resident.lastName}`.trim();

  if (resident.email) {
    return {
      email: resident.email,
      name,
      residentId: resident._id.toString(),
      userId: resident.userId?.toString(),
    };
  }

  if (!resident.userId) {
    return null;
  }

  const user = await UserModel.findOne({
    _id: resident.userId,
    isDeleted: { $ne: true },
  }).lean<{ _id: Types.ObjectId; email?: string; name?: string } | null>();

  if (!user?.email) {
    return null;
  }

  return {
    email: user.email,
    name: user.name ?? name,
    residentId: resident._id.toString(),
    userId: user._id.toString(),
  };
}

/**
 * Every member of staff who should be *told* something, as user ids.
 *
 * ## Why this is not `resolveHostelAdminContacts`
 *
 * That function answers a different question — "who do we **email**" — and its
 * two rules follow from that: it takes owners and `HOSTEL_ADMIN` members only,
 * and it drops anybody whose user record carries no address. Both are wrong for
 * a bell row and a push, which need a user id and nothing else.
 *
 * The wardens are the ones that matter here. A warden is the person actually at
 * the desk registering residents, raising complaints and handling the food log,
 * and they were absent from every in-app notification this hostel sends because
 * the audience was resolved by an email helper. So the warden who performed an
 * intake got no record of it, and neither did the warden on the next shift.
 *
 * The second rule is quieter and just as wrong: an owner who signed up with a
 * phone number and no email was silently excluded from their own hostel's
 * notifications, on a phone that was holding a live device token.
 *
 * ## Not narrowed to "everyone except the actor"
 *
 * Deliberately, and `notifyTheHostel` has the argument: a toast is gone in four
 * seconds and the bell row is the durable record. On a shared front desk the
 * other people's copy is the only way an intake somebody else did is ever seen.
 */
export async function resolveHostelStaffUserIds(
  hostelId: Types.ObjectId | string,
  /** `adminsOnly` drops the wardens: the owner and `HOSTEL_ADMIN` members only. */
  options: { adminsOnly?: boolean } = {},
): Promise<string[]> {
  const hostel = await HostelModel.findOne({ _id: hostelId })
    .select("ownerId")
    .lean<{ ownerId?: Types.ObjectId } | null>();

  const members = await HostelMemberModel.find({
    hostelId,
    isDeleted: { $ne: true },
    role: { $in: options.adminsOnly ? [Role.HOSTEL_ADMIN] : [Role.HOSTEL_ADMIN, Role.WARDEN] },
    status: "ACTIVE",
  }).lean<{ userId: Types.ObjectId }[]>();

  const userIds = [
    ...(hostel?.ownerId ? [hostel.ownerId] : []),
    ...members.map((member) => member.userId),
  ];

  if (userIds.length === 0) {
    return [];
  }

  /*
   * Checked against `User` rather than trusted from the membership rows: a
   * deleted account keeps its `HostelMember` row, and writing notifications to
   * it is writing rows nobody will ever read.
   */
  const users = await UserModel.find({
    _id: { $in: userIds },
    isDeleted: { $ne: true },
  })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId }[]>();

  return [...new Set(users.map((user) => user._id.toString()))];
}

/** Owner + active hostel-admin members, de-duplicated by user id. */
export async function resolveHostelAdminContacts(
  hostelId: Types.ObjectId | string,
): Promise<Contact[]> {
  const hostel = await HostelModel.findOne({ _id: hostelId })
    .select("ownerId")
    .lean<{ ownerId?: Types.ObjectId } | null>();

  const members = await HostelMemberModel.find({
    hostelId,
    isDeleted: { $ne: true },
    role: Role.HOSTEL_ADMIN,
    status: "ACTIVE",
  }).lean<{ userId: Types.ObjectId }[]>();

  const userIds = [
    ...(hostel?.ownerId ? [hostel.ownerId] : []),
    ...members.map((member) => member.userId),
  ];

  if (userIds.length === 0) {
    return [];
  }

  const users = await UserModel.find({
    _id: { $in: userIds },
    isDeleted: { $ne: true },
  }).lean<{ _id: Types.ObjectId; email?: string; name?: string }[]>();

  const byId = new Map<string, Contact>();

  for (const user of users) {
    if (!user.email) {
      continue;
    }

    byId.set(user._id.toString(), {
      email: user.email,
      name: user.name ?? "Hostel admin",
      userId: user._id.toString(),
    });
  }

  return [...byId.values()];
}

/** Active residents of a hostel that can actually be reached by email. */
export async function resolveActiveResidentRecipients(
  hostelId: Types.ObjectId | string,
): Promise<ResidentRecipient[]> {
  const residents = await ResidentModel.find({
    hostelId,
    isDeleted: false,
    status: "ACTIVE",
  }).lean<
    {
      _id: Types.ObjectId;
      email?: string;
      firstName: string;
      lastName: string;
      userId?: Types.ObjectId;
    }[]
  >();

  const recipients = await Promise.all(residents.map(resolveResidentContact));

  return recipients.filter((recipient): recipient is ResidentRecipient =>
    Boolean(recipient),
  );
}

/**
 * Fire-and-forget transactional send. Notifications must never fail the action
 * that triggered them (RULES.md), so delivery problems are logged and swallowed.
 *
 * A `topic` makes the mail optional: it is skipped for an address that turned
 * the topic off, and carries an unsubscribe link and header when it goes. Leave
 * it off for mail a person cannot refuse — credentials, receipts, SOS.
 */
export async function sendNotificationEmail(input: {
  action: string;
  /**
   * Files to send with the mail — a payment receipt, today. Optional and
   * omitted entirely when empty, so the vast majority of notifications keep
   * exactly the payload they had.
   */
  attachments?: EmailAttachment[];
  html: string;
  subject: string;
  to: string;
  topic?: EmailTopic;
}) {
  try {
    if (input.topic && (await emailTopicMuted(input.to, input.topic))) {
      return false;
    }

    const delivery = await sendEmail({
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      html: input.html,
      subject: input.subject,
      to: input.to,
      ...(input.topic ? { unsubscribe: emailPreferenceLinks(input.to, input.topic) } : {}),
    });

    if (!delivery.sent) {
      console.warn(
        JSON.stringify({
          level: "warn",
          action: `${input.action}_email_failed`,
          message: `Recipient was not notified (${delivery.reason}).`,
          to: input.to,
        }),
      );
    }

    return delivery.sent;
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        action: `${input.action}_email_error`,
        message: error instanceof Error ? error.message : "Unknown email error",
        to: input.to,
      }),
    );

    return false;
  }
}

/**
 * {@link sendNotificationEmail} for a job that mails many people in one pass —
 * one Resend request per hundred instead of one per person, which is what kept
 * a page of fee reminders under the per-second limit. Same opt-out rules; no
 * attachments. One result per input, in order.
 */
export async function sendNotificationEmailBatch(
  inputs: Array<{ action: string; html: string; subject: string; to: string; topic?: EmailTopic }>,
): Promise<boolean[]> {
  try {
    const muted = await Promise.all(
      inputs.map((input) =>
        input.topic ? emailTopicMuted(input.to, input.topic) : Promise.resolve(false),
      ),
    );
    const outgoing = inputs.filter((_, index) => !muted[index]);
    const deliveries = await sendEmailBatch(
      outgoing.map((input) => ({
        html: input.html,
        subject: input.subject,
        to: input.to,
        ...(input.topic ? { unsubscribe: emailPreferenceLinks(input.to, input.topic) } : {}),
      })),
    );
    let next = 0;

    return inputs.map((input, index) => {
      if (muted[index]) {
        return false;
      }

      const delivery = deliveries[next++];

      if (!delivery?.sent) {
        console.warn(
          JSON.stringify({
            level: "warn",
            action: `${input.action}_email_failed`,
            message: `Recipient was not notified (${delivery?.reason ?? "unknown"}).`,
            to: input.to,
          }),
        );
      }

      return Boolean(delivery?.sent);
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        action: "notification_email_batch_error",
        message: error instanceof Error ? error.message : "Unknown email error",
      }),
    );

    return inputs.map(() => false);
  }
}
