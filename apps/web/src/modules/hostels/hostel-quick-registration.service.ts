import { Types } from "mongoose";
import { z } from "zod";

import { connectToDatabase } from "@/lib/db";
import { Role } from "@/lib/roles";
import { siteUrl } from "@/lib/site";
import { phoneSchema } from "@/lib/validators";
import { trialWindow } from "@/modules/billing/subscription-payment.service";
import { getOrCreateSubscription } from "@/modules/billing/subscription.service";
import {
  recordHostelReferral,
  resolveHostelReferralCode,
} from "@/modules/hostel-referrals/hostel-referral.service";
import { notifyHostelOwnerOf } from "@/modules/hostels/hostel-notify";
import { formatEmailDate } from "@/modules/hostels/hostel-registration.events";
import { HostelServiceError, uniqueSlug } from "@/modules/hostels/hostel.service";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { UserModel } from "@hostel/db/models/User";
import { PLATFORM_NAME } from "@hostel/shared/brand/brand";
import { sendEmail } from "@hostel/shared/email/sender";
import { hostelPortalOpenEmail } from "@hostel/shared/email/templates/hostel/hostel-kyc";
import { revalidatePublicPages } from "@/lib/revalidate-public";

/**
 * The quick sign-up (docs/QUICK_SIGNUP_KYC_TRIAL.md): owner name, phone and
 * hostel name from a signed-in account, and the hostel portal opens on it at
 * once, on the trial. Everything else is the KYC, which our team approves
 * before the hostel is listed and its frozen features open.
 *
 * ## No password rotation
 *
 * `registerOrUpgradeUserByEmail` rotates the password of a PUBLIC account it
 * raises to HOSTEL_ADMIN — a platform admin raising *somebody else* must not
 * leave a password nobody verified in charge of a hostel. Here the account
 * raises itself, signed in, with a proven mailbox (`emailVerified` or
 * `emailVerifiedAt` is required below), so the role changes in place and the
 * session carries on.
 *
 * ## Not listed, not verified
 *
 * The hostel is `DRAFT` / `UNVERIFIED` until the KYC is approved. No cook
 * login and no owner ID card yet either: both come with the approval.
 */

export const quickHostelRegistrationSchema = z.object({
  hostelName: z.string().trim().min(2, "Enter your hostel's name.").max(120),
  ownerName: z.string().trim().min(2, "Enter the owner's name.").max(80),
  phone: phoneSchema,
  referralCode: z.string().trim().max(40).optional(),
});

export type QuickHostelRegistrationInput = z.infer<typeof quickHostelRegistrationSchema>;

export async function quickRegisterHostel(input: QuickHostelRegistrationInput, userId: string) {
  await connectToDatabase();

  const user = await UserModel.findOne({ _id: userId, isDeleted: { $ne: true } })
    .select("email emailVerified emailVerifiedAt name phone role")
    .lean<{
      _id: Types.ObjectId;
      email?: string;
      emailVerified?: boolean;
      emailVerifiedAt?: Date | null;
      name?: string;
      phone?: string;
      role: string;
    } | null>();

  if (!user) {
    throw new HostelServiceError("Sign in again to register your hostel.", "USER_NOT_FOUND", 404);
  }

  if (user.role !== Role.PUBLIC) {
    throw new HostelServiceError(
      user.role === Role.HOSTEL_ADMIN
        ? "You already run a hostel portal. Add another building from it as a branch."
        : "This account is already used for another role. Sign in with a different account to register a hostel.",
      "ACCOUNT_HAS_ROLE",
      409,
    );
  }

  // An email-OTP sign-up stores only `emailVerifiedAt`: either one is a proven mailbox.
  if (!user.email || !(user.emailVerified || user.emailVerifiedAt)) {
    throw new HostelServiceError(
      "Verify your email first, then register your hostel.",
      "EMAIL_NOT_VERIFIED",
      409,
    );
  }

  // An application filed through the old form is still with our team: one hostel, not two.
  const filed = await HostelModel.findOne({
    "kyc.required": { $ne: true },
    isDeleted: { $ne: true },
    ownerId: user._id,
  })
    .select("name")
    .lean<{ name?: string } | null>();

  if (filed) {
    throw new HostelServiceError(
      `You already registered ${filed.name ?? "a hostel"}. Our team will email you about it.`,
      "ALREADY_REGISTERED",
      409,
    );
  }

  // Before any write: a mistyped code refuses the form rather than losing its reward.
  const referral = input.referralCode ? await resolveHostelReferralCode(input.referralCode) : null;

  // The account takes this phone below. Held by another account, the unique index
  // refused that write as a 500 — after the hostel and its trial were already written.
  if (!user.phone && (await UserModel.exists({ _id: { $ne: user._id }, phone: input.phone }))) {
    throw new HostelServiceError(
      `${input.phone} is already on another ${PLATFORM_NAME} account. Use a different phone number.`,
      "PHONE_IN_USE",
      409,
    );
  }

  /*
   * A retry after a half-finished attempt (the hostel written, the role not
   * yet raised) picks the same hostel up rather than filing a second one.
   */
  const existing = await HostelModel.findOne({
    "kyc.required": true,
    isDeleted: { $ne: true },
    ownerId: user._id,
  })
    .select("_id name slug")
    .lean<{ _id: Types.ObjectId; name: string; slug: string } | null>();

  const hostel =
    existing ??
    (
      await HostelModel.create({
        contact: { email: user.email, phone: input.phone },
        createdBy: user._id,
        kyc: { required: true, status: "DRAFT" },
        name: input.hostelName,
        ownerId: user._id,
        slug: await uniqueSlug(input.hostelName, ""),
        status: "DRAFT",
        updatedBy: user._id,
        verificationStatus: "UNVERIFIED",
      })
    ).toObject();

  const subscription = await getOrCreateSubscription(hostel._id, { source: "PUBLIC" });
  let trial = { days: subscription.trialDays ?? 0, endsAt: subscription.trialEndsAt ?? null };

  if (!subscription.trialEndsAt) {
    const now = new Date();
    const window = await trialWindow(now);

    // No plan yet: the owner picks monthly or the lifetime deal on Billing.
    await HostelSubscriptionModel.updateOne(
      { _id: subscription._id },
      {
        $set: {
          activatedAt: now,
          currentPeriodEnd: window.endsAt,
          freeMonths: 0,
          freeUntil: window.endsAt,
          status: "ACTIVE",
          trialDays: window.days,
          trialEndsAt: window.endsAt,
        },
      },
    );
    await HostelModel.updateOne({ _id: hostel._id }, { $set: { "kyc.trialEndsAt": window.endsAt } });
    trial = window;
  }

  if (referral && !existing) {
    await recordHostelReferral(referral, hostel._id);
  }

  const raised = await UserModel.updateOne(
    { _id: user._id, role: Role.PUBLIC },
    {
      $addToSet: { hostelIds: hostel._id },
      $set: {
        name: input.ownerName,
        role: Role.HOSTEL_ADMIN,
        ...(user.phone ? {} : { phone: input.phone }),
      },
    },
  );

  if (!existing) {
    await AuditLogModel.create({
      action: "HOSTEL_QUICK_REGISTERED",
      actorId: user._id,
      entityId: hostel._id.toString(),
      entityType: "Hostel",
      hostelId: hostel._id,
      metadata: { referralCode: referral?.code ?? null, trialDays: trial.days },
    });
  }

  if (raised.modifiedCount) {
    await AuditLogModel.create({
      action: "USER_ROLE_UPGRADED",
      actorId: user._id,
      entityId: user._id.toString(),
      entityType: "User",
      hostelId: hostel._id,
      metadata: { previousRole: Role.PUBLIC, role: Role.HOSTEL_ADMIN, via: "quick-registration" },
    });

    const trialEndsOn = formatEmailDate(trial.endsAt) ?? "";

    await sendEmail({
      to: user.email,
      ...hostelPortalOpenEmail({
        hostelName: hostel.name,
        kycUrl: `${siteUrl()}/${encodeURIComponent(hostel.slug)}/admin/kyc`,
        ownerName: input.ownerName,
        trialDays: trial.days,
        trialEndsOn,
      }),
    }).catch(() => null);

    await notifyHostelOwnerOf(user._id, hostel._id, {
      actionUrl: "/hostel-admin",
      body: `You got ${trial.days} days free — enjoy and explore.`,
      title: `Congratulations! ${hostel.name} is on ${PLATFORM_NAME}`,
      type: "HOSTEL_PORTAL_OPEN",
    });
    await notifyHostelOwnerOf(user._id, hostel._id, {
      actionUrl: "/hostel-admin/kyc",
      body: "Complete your hostel KYC now. Our team checks it within 24 hours, then every feature opens.",
      title: "Please complete your KYC",
      type: "HOSTEL_KYC",
    });
  }

  revalidatePublicPages();
  return {
    hostelId: hostel._id.toString(),
    name: hostel.name,
    slug: hostel.slug,
    trialDays: trial.days,
    trialEndsAt: trial.endsAt ? trial.endsAt.toISOString() : null,
  };
}
