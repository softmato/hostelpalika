import { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { Role } from "@/lib/roles";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { HostelModel } from "@hostel/db/models/Hostel";

/**
 * A hostel's portal taken away for an unpaid plan: the stage, who it reaches,
 * what stays open, and lifting it.
 *
 * ## Two stages, one field
 *
 * A platform admin starts it from Listings (`hostel-suspension.service.ts`).
 * For {@link SUSPENSION_GRACE_DAYS} days the hostel is in **pre-suspension**:
 * its owner and wardens see a countdown and keep working. Once `graceEndsAt`
 * passes it is **suspended**: the admin, warden, resident, guardian and cook
 * portals stop until the plan is paid.
 *
 * The stage is read off the clock rather than written by a cron, so the block
 * lands at the deadline and there is no job to forget or to fail.
 *
 * ## Kept light on purpose
 *
 * `lib/api-auth.ts` imports this, and every API route imports that. Starting a
 * suspension raises invoices and sends email, so that half lives in the service
 * file and none of it is bundled into every route.
 */

/** Pre-suspension, counted like every other due here: to the end of a Nepal day. */
export const SUSPENSION_GRACE_DAYS = 3;

/** One reason for now. A second one is a new entry here and a new email. */
export const SUSPENSION_REASONS = ["PLAN_PAYMENT"] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

export type SuspensionStage = "PRE_SUSPENSION" | "SUSPENDED";

export type SuspensionRecord = {
  graceEndsAt?: Date | null;
  reason?: string | null;
  startedAt?: Date | null;
  startedBy?: Types.ObjectId | null;
};

/** Every role whose portal is the hostel's. Platform and team accounts are ours. */
export const SUSPENDABLE_ROLES: ReadonlySet<Role> = new Set<Role>([
  Role.HOSTEL_ADMIN,
  Role.WARDEN,
  Role.RESIDENT,
  Role.GUARDIAN,
  Role.COOK,
]);

export const HOSTEL_SUSPENDED_MESSAGE =
  "This hostel's plan has not been paid, so its portal is suspended until it is.";

export function suspensionStage(
  suspension: SuspensionRecord | null | undefined,
  now = new Date(),
): SuspensionStage | null {
  if (!suspension?.startedAt || !suspension.graceEndsAt) {
    return null;
  }

  return now.getTime() < new Date(suspension.graceEndsAt).getTime()
    ? "PRE_SUSPENSION"
    : "SUSPENDED";
}

/** The suspension as the portals read it. `null` when there is none. */
export function serializeSuspension(
  suspension: SuspensionRecord | null | undefined,
  now = new Date(),
) {
  const stage = suspensionStage(suspension, now);

  if (!stage || !suspension?.startedAt || !suspension.graceEndsAt) {
    return null;
  }

  return {
    graceEndsAt: new Date(suspension.graceEndsAt).toISOString(),
    reason: (suspension.reason ?? "PLAN_PAYMENT") as SuspensionReason,
    stage,
    startedAt: new Date(suspension.startedAt).toISOString(),
  };
}

/**
 * What a suspended hostel can still reach: paying for its plan.
 *
 * Paying is the only way out of a suspension, so the plan billing routes stay
 * open — the pay instructions, the proof claim and the invoice documents all
 * live under them — and so does file upload, which carries the proof
 * screenshot. An upload on its own changes nothing; every route that could put
 * one to use is still refused.
 */
const OPEN_WHILE_SUSPENDED = [
  "/api/v1/files",
  "/api/v1/hostel-admin/billing",
  "/api/v1/hostel-admin/subscription",
];

export function isOpenWhileSuspended(pathname: string) {
  return OPEN_WHILE_SUSPENDED.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function objectIds(hostelIds: string[]) {
  return hostelIds
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
}

/**
 * The suspension an account lives under, for `/auth/me`.
 *
 * Only when **every** live hostel on the account is under one. A warden who
 * covers two buildings keeps the portal for the one that paid — the API narrows
 * the other away — and for the one-hostel account that is nearly everyone, this
 * is simply that hostel's state. With several, the latest deadline is the one
 * reported, because the account is not blocked until the last of them lands.
 */
export async function suspensionForAccount(hostelIds: string[], now = new Date()) {
  const ids = objectIds(hostelIds);

  if (ids.length === 0) {
    return null;
  }

  await connectToDatabase();

  const hostels = await HostelModel.find({ _id: { $in: ids }, isDeleted: { $ne: true } })
    .select("name suspension")
    .lean<{ _id: Types.ObjectId; name?: string; suspension?: SuspensionRecord | null }[]>();

  let latest:
    | (NonNullable<ReturnType<typeof serializeSuspension>> & {
        hostelId: string;
        hostelName: string;
      })
    | null = null;

  for (const hostel of hostels) {
    const view = serializeSuspension(hostel.suspension, now);

    if (!view) {
      return null;
    }

    if (!latest || view.graceEndsAt > latest.graceEndsAt) {
      latest = { ...view, hostelId: hostel._id.toString(), hostelName: hostel.name ?? "" };
    }
  }

  return latest;
}

/**
 * Ends a suspension, at either stage. Returns whether there was one to end.
 *
 * `PAID` is the settlement that cleared the plan (`applySettlement`); `LIFTED`
 * is a platform admin undoing it by hand. Conditional on one existing, so two
 * settlements landing together write one audit row between them.
 */
export async function liftHostelSuspension(
  hostelId: string | Types.ObjectId,
  options: { actorId?: string | null; cause: "LIFTED" | "PAID" },
) {
  await connectToDatabase();

  const objectId = typeof hostelId === "string" ? new Types.ObjectId(hostelId) : hostelId;

  // Returns the row as it was, so the audit can say what was lifted.
  const before = await HostelModel.findOneAndUpdate(
    { _id: objectId, "suspension.startedAt": { $ne: null } },
    {
      $set: {
        "suspension.graceEndsAt": null,
        "suspension.reason": null,
        "suspension.startedAt": null,
        "suspension.startedBy": null,
      },
    },
  )
    .select("suspension")
    .lean<{ suspension?: SuspensionRecord | null } | null>();

  if (!before) {
    return false;
  }

  // Branches carry their main hostel's suspension (`startHostelSuspension`).
  await HostelModel.updateMany(
    { parentHostelId: objectId },
    {
      $set: {
        "suspension.graceEndsAt": null,
        "suspension.reason": null,
        "suspension.startedAt": null,
        "suspension.startedBy": null,
      },
    },
  );

  await AuditLogModel.create({
    action: "HOSTEL_SUSPENSION_LIFTED",
    actorId: options.actorId ?? null,
    entityId: objectId.toString(),
    entityType: "Hostel",
    hostelId: objectId,
    metadata: {
      cause: options.cause,
      graceEndsAt: before.suspension?.graceEndsAt ?? null,
      reason: before.suspension?.reason ?? null,
      stage: suspensionStage(before.suspension),
      startedAt: before.suspension?.startedAt ?? null,
    },
  });

  return true;
}
