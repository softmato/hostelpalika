import { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";

/**
 * What a quick sign-up may not change until its KYC is approved
 * (docs/QUICK_SIGNUP_KYC_TRIAL.md, decision 2).
 *
 * Writes only: an unapproved hostel's own reads are its own empty data, and
 * Home reads across several of these. The phone and the website freeze the
 * same features in their menus; this is what stops a caller who skips them.
 *
 * Kept light — `lib/api-auth.ts` loads it on every request.
 */
export const KYC_REQUIRED_MESSAGE =
  "Please complete your hostel KYC. This opens once our team has approved it.";

const FROZEN = [
  "/api/v1/hostel-admin/attendance",
  "/api/v1/hostel-admin/bookings",
  "/api/v1/hostel-admin/branches",
  "/api/v1/hostel-admin/cook-portal",
  "/api/v1/hostel-admin/cooks",
  "/api/v1/hostel-admin/expenses",
  "/api/v1/hostel-admin/finance",
  "/api/v1/hostel-admin/hostel-referrals",
  "/api/v1/hostel-admin/khata",
  "/api/v1/hostel-admin/move-events",
  "/api/v1/hostel-admin/night-status",
  "/api/v1/hostel-admin/notice-pushes",
  "/api/v1/hostel-admin/notifications",
  "/api/v1/hostel-admin/payments",
  "/api/v1/hostel-admin/referrals",
  "/api/v1/hostel-admin/resident-lookup",
  "/api/v1/hostel-admin/resident-scan",
  "/api/v1/hostel-admin/residents",
  "/api/v1/hostel-admin/stock",
  "/api/v1/hostel-admin/wardens",
  "/api/v1/users/resident-identity",
];

/** Inside a frozen prefix, but part of the KYC itself: rent, payment setup, opening balance. */
const KYC_OWN = [
  "/api/v1/hostel-admin/finance/fee-schedules",
  "/api/v1/hostel-admin/finance/money-rules",
  "/api/v1/hostel-admin/finance/payment-gateways",
  "/api/v1/hostel-admin/finance/payment-profile",
];

const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

export function isKycFrozenRequest(method: string, pathname: string) {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  if (KYC_OWN.some((prefix) => under(pathname, prefix))) return false;

  return FROZEN.some((prefix) => under(pathname, prefix));
}

export type KycRecord =
  | { required?: boolean | null; status?: string | null; trialEndsAt?: Date | string | null }
  | null
  | undefined;

/** Locked until approved — only ever true for a quick sign-up. */
export function isKycLocked(kyc: KycRecord) {
  return Boolean(kyc?.required) && kyc?.status !== "APPROVED";
}

export const TRIAL_ENDED_KYC_MESSAGE =
  "Your free trial has ended. Please complete your KYC — once our team approves it, you can get your plan.";

/**
 * The trial is over and the KYC is still not approved: the portal is blocked
 * except for finishing the KYC, and the plan cannot be bought until it is
 * approved (docs/QUICK_SIGNUP_KYC_TRIAL.md).
 */
export function isTrialOverWithoutKyc(kyc: KycRecord, now = new Date()) {
  return isKycLocked(kyc) && Boolean(kyc?.trialEndsAt) && now.getTime() > new Date(kyc!.trialEndsAt!).getTime();
}

/** What such a hostel may still write: its KYC sections, and its plan. */
const OPEN_AFTER_TRIAL = [
  "/api/v1/hostel-admin/billing",
  "/api/v1/hostel-admin/finance/fee-schedules",
  "/api/v1/hostel-admin/finance/money-rules",
  "/api/v1/hostel-admin/finance/payment-gateways",
  "/api/v1/hostel-admin/finance/payment-profile",
  "/api/v1/hostel-admin/food",
  "/api/v1/hostel-admin/kyc",
  "/api/v1/hostel-admin/payout-account",
  "/api/v1/hostel-admin/profile",
  "/api/v1/hostel-admin/room-types",
  "/api/v1/hostel-admin/rooms",
  "/api/v1/hostel-admin/settings",
  "/api/v1/hostel-admin/subscription",
];

export function isBlockedAfterTrial(method: string, pathname: string) {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  if (!under(pathname, "/api/v1/hostel-admin")) return false;

  return !OPEN_AFTER_TRIAL.some((prefix) => under(pathname, prefix));
}

/**
 * The KYC and trial an account's hostel is on, for `/auth/me` — the frozen
 * menus, the KYC screen's status line and the congratulations sheet all read
 * it. `null` for every hostel that did not come through the quick sign-up.
 */
export async function kycForAccount(hostelIds: string[]) {
  const ids = hostelIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));

  if (ids.length === 0) return null;

  await connectToDatabase();

  const hostel = await HostelModel.findOne({ _id: { $in: ids }, isDeleted: { $ne: true }, "kyc.required": true })
    .select("kyc name")
    .lean<{
      _id: Types.ObjectId;
      kyc?: { note?: string | null; required?: boolean; status?: string | null; submittedAt?: Date | null };
      name?: string;
    } | null>();

  if (!hostel?.kyc) return null;

  const subscription = await HostelSubscriptionModel.findOne({ hostelId: hostel._id })
    .select("trialDays trialEndsAt")
    .lean<{ trialDays?: number | null; trialEndsAt?: Date | null } | null>();

  return {
    hostelId: hostel._id.toString(),
    hostelName: hostel.name ?? "",
    locked: isKycLocked(hostel.kyc),
    note: hostel.kyc.status === "REJECTED" ? (hostel.kyc.note ?? null) : null,
    status: (hostel.kyc.status ?? "DRAFT") as "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED",
    submittedAt: hostel.kyc.submittedAt ? hostel.kyc.submittedAt.toISOString() : null,
    trialDays: subscription?.trialDays ?? null,
    trialEndsAt: subscription?.trialEndsAt ? subscription.trialEndsAt.toISOString() : null,
  };
}
