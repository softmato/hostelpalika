import "server-only";

import { Types } from "mongoose";

import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelPayoutAccountModel } from "@hostel/db/models/HostelPayoutAccount";
import { UserModel } from "@hostel/db/models/User";
import {
  payoutAccountChangedEmail,
  payoutAccountReviewedEmail,
} from "@hostel/shared/email/templates/booking/payout-account";
import { emailDateTime, type EmailContent } from "@hostel/shared/email/templates/layout";
import { sendEmail } from "@hostel/shared/email/sender";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { personalLookupHash } from "@/lib/personal-data-crypto";
import { Role } from "@/lib/roles";
import { BookingError } from "@/modules/bookings/booking.errors";
import {
  PAYOUT_METHOD_LABELS,
  maskedPayoutNumber,
  payoutAccountInputSchema,
  type PayoutMethod,
} from "@/lib/bookings/payout-account.validation";
import type { SecretEnvelope } from "@/modules/finance/gateway/envelope-crypto";
import { openValue, sealValue } from "@/modules/finance/gateway/secret-store";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { appUrl, resolveHostelAdminContacts } from "@/modules/residents/resident-notify";
import type { PayoutAccountForReview, PayoutAccountStatus, PayoutAccountView } from "@/lib/bookings/booking.types";
export type { PayoutAccountStatus } from "@/lib/bookings/booking.types";
export type { PayoutAccountView, PayoutAccountForReview } from "@/lib/bookings/booking.types";

/**
 * A hostel's payout account: where its share of booking fees is sent.
 *
 * The number is sealed to the hostel (`sealValue`) and the only plaintext kept
 * is the last four characters. Anybody may be *shown* the account masked; the
 * full number is opened in exactly one place, `revealHostelPayoutAccount`, for a
 * superadmin about to send money, and every opening is written to the audit log.
 *
 * Every save goes back to review, and payouts wait for a verified account —
 * see `isPayoutAccountVerified`. The owner is emailed on every change so a
 * change they did not make is noticed before any money moves.
 */

const PURPOSE = "PAYOUT_ACCOUNT_NUMBER";

type PayoutRecord = {
  _id: Types.ObjectId;
  bankName?: string;
  branch?: string;
  holderName: string;
  hostelId: Types.ObjectId;
  method: PayoutMethod;
  number: SecretEnvelope;
  numberLast4: string;
  numberLookup: string;
  reviewNote?: string | null;
  reviewedAt?: Date | null;
  status: PayoutAccountStatus;
  submittedAt: Date;
};

export type PayoutActor = {
  /** Where the save came from. A registration form sends no change email. */
  source: "HOSTEL_ADMIN" | "PLATFORM" | "REGISTRATION";
  userId: string | null;
};

function scopeFor(hostelId: Types.ObjectId | string) {
  return { hostelId: String(hostelId), purpose: PURPOSE };
}

function toView(record: PayoutRecord): PayoutAccountView {
  return {
    bankName: record.bankName ?? "",
    branch: record.branch ?? "",
    holderName: record.holderName,
    maskedNumber: maskedPayoutNumber(record.numberLast4),
    method: record.method,
    methodLabel: PAYOUT_METHOD_LABELS[record.method],
    reviewNote: record.reviewNote ?? null,
    reviewedAt: record.reviewedAt?.toISOString() ?? null,
    status: record.status,
    submittedAt: record.submittedAt.toISOString(),
  };
}

function emailFacts(record: PayoutRecord) {
  return {
    bankName: record.bankName || null,
    holderName: record.holderName,
    maskedNumber: maskedPayoutNumber(record.numberLast4),
    methodLabel: PAYOUT_METHOD_LABELS[record.method],
  };
}

/** Never throws: a mail that fails must not undo a save that succeeded. */
async function deliver(action: string, to: string, message: EmailContent) {
  try {
    const result = await sendEmail({
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

async function hostelOrThrow(hostelId: string) {
  if (!Types.ObjectId.isValid(hostelId)) {
    throw new BookingError("Hostel not found.", "HOSTEL_NOT_FOUND", 404);
  }

  const hostel = await HostelModel.findById(hostelId)
    .select("name slug")
    .lean<{ _id: Types.ObjectId; name: string; slug?: string } | null>();

  if (!hostel) {
    throw new BookingError("Hostel not found.", "HOSTEL_NOT_FOUND", 404);
  }

  return hostel;
}

function settingsUrl(slug?: string) {
  return slug
    ? appUrl(`/${encodeURIComponent(slug)}/admin/bookings?tab=payout`)
    : appUrl("/hostel-admin/bookings?tab=payout");
}

export async function getHostelPayoutAccount(
  hostelId: Types.ObjectId | string,
): Promise<PayoutAccountView | null> {
  await connectToDatabase();

  const record = await HostelPayoutAccountModel.findOne({ hostelId }).lean<PayoutRecord | null>();

  return record ? toView(record) : null;
}

export async function isPayoutAccountVerified(hostelId: Types.ObjectId | string) {
  await connectToDatabase();

  return Boolean(await HostelPayoutAccountModel.exists({ hostelId, status: "VERIFIED" }));
}

export async function setHostelPayoutAccount(
  hostelId: string,
  input: unknown,
  actor: PayoutActor,
): Promise<PayoutAccountView> {
  await connectToDatabase();

  const value = payoutAccountInputSchema.parse(input);
  const hostel = await hostelOrThrow(hostelId);
  const existing = await HostelPayoutAccountModel.findOne({ hostelId: hostel._id }).lean<PayoutRecord | null>();

  if (
    existing &&
    existing.method === value.method &&
    existing.holderName === value.holderName &&
    (existing.bankName ?? "") === value.bankName &&
    (existing.branch ?? "") === value.branch
  ) {
    let sameNumber = false;

    try {
      sameNumber = openValue(existing.number, scopeFor(hostel._id)) === value.number;
    } catch {
      // Unreadable under the configured keys: treat it as a new number.
    }

    // Saving the same account again is not a change and must not reset a review.
    if (sameNumber) {
      return toView(existing);
    }
  }

  const now = new Date();
  const record = await HostelPayoutAccountModel.findOneAndUpdate(
    { hostelId: hostel._id },
    {
      $set: {
        bankName: value.bankName,
        branch: value.branch,
        holderName: value.holderName,
        method: value.method,
        number: sealValue(value.number, scopeFor(hostel._id)),
        numberLast4: value.number.slice(-4),
        numberLookup: personalLookupHash(`payout:${value.method}:${value.number}`),
        reviewNote: null,
        reviewedAt: null,
        reviewedBy: null,
        status: "PENDING_REVIEW",
        submittedAt: now,
        submittedBy: actor.userId,
      },
      $setOnInsert: { hostelId: hostel._id },
    },
    { new: true, upsert: true },
  ).lean<PayoutRecord | null>();

  if (!record) {
    throw new BookingError("The payout account could not be saved.", "PAYOUT_ACCOUNT_NOT_SAVED", 500);
  }

  await AuditLogModel.create({
    action: existing ? "PAYOUT_ACCOUNT_CHANGED" : "PAYOUT_ACCOUNT_SET",
    actorId: actor.userId ?? undefined,
    actorType: actor.userId ? "USER" : "SYSTEM",
    entityId: String(record._id),
    entityType: "HostelPayoutAccount",
    hostelId: hostel._id,
    metadata: {
      next: { bankName: value.bankName, holderName: value.holderName, last4: record.numberLast4, method: value.method },
      previous: existing
        ? {
            bankName: existing.bankName,
            holderName: existing.holderName,
            last4: existing.numberLast4,
            method: existing.method,
            status: existing.status,
          }
        : null,
      source: actor.source,
    },
  });

  if (actor.source !== "REGISTRATION") {
    const contacts = await resolveHostelAdminContacts(hostel._id).catch(() => []);

    await Promise.all(
      contacts.map((contact) =>
        deliver(
          "payout_account_changed",
          contact.email,
          payoutAccountChangedEmail({
            account: emailFacts(record),
            changedAt: emailDateTime(now) ?? "",
            hostelName: hostel.name,
            name: contact.name,
            settingsUrl: settingsUrl(hostel.slug),
          }),
        ),
      ),
    );
  }

  await notifyPlatformOfPayoutReview(hostel);

  return toView(record);
}

async function notifyPlatformOfPayoutReview(hostel: { _id: Types.ObjectId; name: string }) {
  try {
    const staff = await UserModel.find({
      isDeleted: { $ne: true },
      role: Role.SUPERADMIN,
      status: "ACTIVE",
    })
      .select("_id")
      .lean<{ _id: Types.ObjectId }[]>();

    await Promise.all(
      staff.map((member) =>
        createInAppNotification({
          actionUrl: "/platform/bookings?tab=payout-accounts",
          body: `${hostel.name} set a payout account. Check it before any payout.`,
          category: "BOOKING",
          data: { hostelId: String(hostel._id), type: "PAYOUT_ACCOUNT_REVIEW" },
          title: "Payout account to check",
          userId: String(member._id),
        }).catch(() => undefined),
      ),
    );
  } catch {
    // The queue on the Bookings screen is the guarantee; the bell is a courtesy.
  }
}

/** Accounts waiting for a superadmin, oldest first. */
export async function listPayoutAccounts(
  filter: { hostelId?: string; status?: PayoutAccountStatus } = {},
): Promise<PayoutAccountForReview[]> {
  await connectToDatabase();

  const records = await HostelPayoutAccountModel.find({
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.hostelId ? { hostelId: filter.hostelId } : {}),
  })
    .sort({ submittedAt: 1 })
    .limit(500)
    .lean<PayoutRecord[]>();

  if (records.length === 0) {
    return [];
  }

  const lookups = [...new Set(records.map((record) => record.numberLookup))];
  const twins = await HostelPayoutAccountModel.find({ numberLookup: { $in: lookups } })
    .select("hostelId numberLookup")
    .lean<Array<{ hostelId: Types.ObjectId; numberLookup: string }>>();

  const hostelIds = [...new Set([...records, ...twins].map((row) => String(row.hostelId)))];
  const hostels = await HostelModel.find({ _id: { $in: hostelIds } })
    .select("name")
    .lean<Array<{ _id: Types.ObjectId; name: string }>>();
  const nameOf = new Map(hostels.map((hostel) => [String(hostel._id), hostel.name]));

  return records.map((record) => ({
    ...toView(record),
    hostelId: String(record.hostelId),
    hostelName: nameOf.get(String(record.hostelId)) ?? "—",
    sharedWith: twins
      .filter(
        (twin) =>
          twin.numberLookup === record.numberLookup && String(twin.hostelId) !== String(record.hostelId),
      )
      .map((twin) => nameOf.get(String(twin.hostelId)) ?? "another hostel"),
  }));
}

/** The full number, for a superadmin about to send a payout. Audited every time. */
export async function revealHostelPayoutAccount(hostelId: string, principal: ApiPrincipal) {
  await connectToDatabase();

  if (principal.role !== Role.SUPERADMIN) {
    throw new BookingError("Only a superadmin can see a full payout account.", "FORBIDDEN", 403);
  }

  const hostel = await hostelOrThrow(hostelId);
  const record = await HostelPayoutAccountModel.findOne({ hostelId: hostel._id }).lean<PayoutRecord | null>();

  if (!record) {
    throw new BookingError("This hostel has no payout account.", "PAYOUT_ACCOUNT_MISSING", 404);
  }

  const number = openValue(record.number, scopeFor(hostel._id));

  await AuditLogModel.create({
    action: "PAYOUT_ACCOUNT_REVEALED",
    actorId: principal.userId,
    actorType: "USER",
    entityId: String(record._id),
    entityType: "HostelPayoutAccount",
    hostelId: hostel._id,
    metadata: { last4: record.numberLast4, method: record.method },
  });

  return { ...toView(record), number };
}

export async function reviewHostelPayoutAccount(
  hostelId: string,
  input: { approve: boolean; note?: string },
  principal: ApiPrincipal,
): Promise<PayoutAccountView> {
  await connectToDatabase();

  const hostel = await hostelOrThrow(hostelId);
  const note = input.note?.trim().slice(0, 500) || null;

  if (!input.approve && !note) {
    throw new BookingError(
      "Say what is wrong so the hostel can fix it.",
      "VALIDATION_ERROR",
      422,
    );
  }

  const record = await HostelPayoutAccountModel.findOneAndUpdate(
    { hostelId: hostel._id, status: "PENDING_REVIEW" },
    {
      $set: {
        reviewNote: note,
        reviewedAt: new Date(),
        reviewedBy: principal.userId,
        status: input.approve ? "VERIFIED" : "REJECTED",
      },
    },
    { new: true },
  ).lean<PayoutRecord | null>();

  if (!record) {
    throw new BookingError(
      "There is no payout account waiting for review on this hostel.",
      "PAYOUT_ACCOUNT_NOT_IN_REVIEW",
      409,
    );
  }

  await AuditLogModel.create({
    action: input.approve ? "PAYOUT_ACCOUNT_VERIFIED" : "PAYOUT_ACCOUNT_REJECTED",
    actorId: principal.userId,
    actorType: "USER",
    entityId: String(record._id),
    entityType: "HostelPayoutAccount",
    hostelId: hostel._id,
    metadata: { last4: record.numberLast4, method: record.method, note },
  });

  const contacts = await resolveHostelAdminContacts(hostel._id).catch(() => []);

  await Promise.all(
    contacts.map(async (contact) => {
      await deliver(
        "payout_account_reviewed",
        contact.email,
        payoutAccountReviewedEmail({
          account: emailFacts(record),
          approved: input.approve,
          hostelName: hostel.name,
          name: contact.name,
          note,
          settingsUrl: settingsUrl(hostel.slug),
        }),
      );

      if (contact.userId) {
        await createInAppNotification({
          actionUrl: "/hostel-admin/bookings?tab=payout",
          body: input.approve
            ? "Your payout account is verified. Booking payouts will go there."
            : `Your payout account needs fixing: ${note}`,
          category: "BOOKING",
          data: { hostelId: String(hostel._id), type: "PAYOUT_ACCOUNT_REVIEWED" },
          hostelId: String(hostel._id),
          title: input.approve ? "Payout account verified" : "Payout account needs fixing",
          userId: contact.userId,
        }).catch(() => undefined);
      }
    }),
  );

  return toView(record);
}
