import { assertPlanRoom } from "@/modules/billing/plan-limits";
import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { logger } from "@/lib/logger";
import { escapeRegex } from "@/lib/validators";
import { paginationMeta, paginationRange } from "@/lib/pagination";
import { assertHostelAccess } from "@/lib/tenant";
import { Role } from "@/lib/roles";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { EmergencyContactModel } from "@hostel/db/models/EmergencyContact";
import { GuardianModel } from "@hostel/db/models/Guardian";
import { GuardianAccessModel } from "@hostel/db/models/GuardianAccess";
import { HostelModel } from "@hostel/db/models/Hostel";
import { releaseGuardianAccounts } from "@/modules/guardian/guardian-account";
import { ResidentModel } from "@hostel/db/models/Resident";
import { UserModel } from "@hostel/db/models/User";
import { sendEmail } from "@hostel/shared/email/sender";
import { afterResponse } from "@/lib/after-response";
import {
  notifyResidentRoomChanged,
  notifyResidentStatusChanged,
} from "@/modules/residents/resident-changed-notify";
import { notifyResidentRegistered } from "@/modules/residents/resident-registered-notify";
import {
  DEMO_RESIDENT_EMAIL,
  findLiveResidency,
  isDemoResidentEmail,
  liveResidencyMessage,
  releaseResidentAccount,
} from "@/modules/residents/live-residency";
import { wardRegisteredEmail } from "@hostel/shared/email/templates/guardian/ward-registered";
import { residentAccessClearedEmail } from "@hostel/shared/email/templates/resident/resident-access-cleared";
import { residentLinkedEmail } from "@hostel/shared/email/templates/resident/resident-linked";
import {
  assertActiveReferralCode,
  linkReferralOnRegistration,
} from "@/modules/referrals/referral.service";
import { normalizeResidentId } from "@/modules/users/resident-identity.service";
import {
  hasClearance,
  promoteAccountToResident,
  type ResidentPromotionClearance,
} from "@/modules/users/resident-promotion.service";
import { UserServiceError } from "@/modules/users/user.service";
import {
  getIntakeQuote,
  periodOfDate,
  raiseAdmissionInvoice,
} from "@/modules/residents/resident-intake.service";
import { runBillingCycle } from "@/modules/finance/billing.service";
import {
  checkInBooking,
  findHeldBooking,
  returnHeldBed,
  takeHeldBed,
} from "@/modules/bookings/booking-checkin.service";
import { stayEndsAt } from "@/modules/bookings/short-stay";
import { getHostelPayMethods } from "@/modules/finance/pay-instructions.service";
import {
  claimBedForRoomType,
  moveBedBetweenRoomTypes,
  releaseBedForRoomType,
} from "@/modules/hostels/hostel-capacity.service";
import type {
  emergencyContactCreateSchema,
  guardianCreateSchema,
  residentCreateSchema,
  residentListQuerySchema,
  residentStatusSchema,
  residentUpdateSchema,
} from "@/modules/residents/resident.validation";

type ResidentCreateInput = z.infer<typeof residentCreateSchema>;
type ResidentUpdateInput = z.infer<typeof residentUpdateSchema>;
type ResidentListQuery = z.infer<typeof residentListQuerySchema>;
type ResidentStatusInput = z.infer<typeof residentStatusSchema>;
type GuardianCreateInput = z.infer<typeof guardianCreateSchema>;
type EmergencyContactCreateInput = z.infer<typeof emergencyContactCreateSchema>;

type ResidentStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "MOVED_OUT";

export type ResidentRecord = {
  _id: Types.ObjectId;
  admissionFee?: number | null;
  admissionFeeDiscount?: number;
  createdAt?: Date;
  demoDataLabel?: string;
  depositAmount: number;
  email?: string;
  firstName: string;
  hostelId: Types.ObjectId;
  isDemoData?: boolean;
  lastName: string;
  monthlyFee?: number;
  moveInDate: Date;
  phone: string;
  referralCode?: string;
  residentType?: "STUDENT" | "WORKING_PROFESSIONAL" | "OTHER";
  roomType: string;
  status: ResidentStatus;
  updatedAt?: Date;
  userId?: Types.ObjectId;
};

type GuardianRecord = {
  _id: Types.ObjectId;
  createdAt?: Date;
  email?: string;
  firstName: string;
  hostelId: Types.ObjectId;
  isPrimary: boolean;
  lastName: string;
  phone: string;
  relation: string;
  residentId: Types.ObjectId;
  updatedAt?: Date;
};

type EmergencyContactRecord = {
  _id: Types.ObjectId;
  createdAt?: Date;
  hostelId: Types.ObjectId;
  isPrimary: boolean;
  name: string;
  phone: string;
  relation: string;
  residentId: Types.ObjectId;
  updatedAt?: Date;
};

export class ResidentServiceError extends Error {
  constructor(
    message: string,
    public errorCode = "RESIDENT_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

function normalizeObjectId(value: string, label = "id") {
  if (!Types.ObjectId.isValid(value)) {
    throw new ResidentServiceError(`Invalid ${label}.`, "INVALID_OBJECT_ID", 422);
  }

  return new Types.ObjectId(value);
}

function normalizeObjectIds(values: string[]) {
  return values.map((value) => normalizeObjectId(value));
}

function definedUpdate(input: Record<string, unknown>, omittedKeys: string[] = []) {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) => value !== undefined && !omittedKeys.includes(key),
    ),
  );
}

function resolveAdminHostelId(principal: ApiPrincipal, requestedHostelId?: string) {
  if (requestedHostelId) {
    assertHostelAccess(principal, requestedHostelId);
    return normalizeObjectId(requestedHostelId, "hostel id");
  }

  if (principal.hostelIds.length === 1) {
    return normalizeObjectId(principal.hostelIds[0], "hostel id");
  }

  throw new ResidentServiceError(
    "A hostelId is required for this hostel admin action.",
    "HOSTEL_SCOPE_REQUIRED",
    422,
  );
}

function scopedHostelFilter(principal: ApiPrincipal, requestedHostelId?: string) {
  if (requestedHostelId) {
    return { hostelId: resolveAdminHostelId(principal, requestedHostelId) };
  }

  return {
    hostelId: {
      $in: normalizeObjectIds(principal.hostelIds),
    },
  };
}

/** The login behind a resident row, when they have activated one. */
type ResidentAccount = { email: string; image: string | null; name: string };

function serializeResident(resident: ResidentRecord) {
  return {
    /** What was levied at intake. Null — not zero — when none was. */
    admissionFee: resident.admissionFee ?? null,
    admissionFeeDiscount: resident.admissionFeeDiscount ?? 0,
    createdAt: resident.createdAt?.toISOString(),
    demoDataLabel: resident.demoDataLabel ?? "",
    depositAmount: resident.depositAmount,
    email: resident.email ?? "",
    firstName: resident.firstName,
    hostelId: resident.hostelId.toString(),
    id: resident._id.toString(),
    isDemoData: Boolean(resident.isDemoData),
    lastName: resident.lastName,
    monthlyFee: resident.monthlyFee ?? 0,
    moveInDate: resident.moveInDate.toISOString(),
    phone: resident.phone,
    referralCode: resident.referralCode ?? "",
    residentType: resident.residentType ?? "STUDENT",
    roomType: resident.roomType,
    status: resident.status,
    updatedAt: resident.updatedAt?.toISOString(),
    userId: resident.userId?.toString(),
  };
}

function serializeGuardian(guardian: GuardianRecord) {
  return {
    createdAt: guardian.createdAt?.toISOString(),
    email: guardian.email ?? "",
    firstName: guardian.firstName,
    hostelId: guardian.hostelId.toString(),
    id: guardian._id.toString(),
    isPrimary: guardian.isPrimary,
    lastName: guardian.lastName,
    phone: guardian.phone,
    relation: guardian.relation,
    residentId: guardian.residentId.toString(),
    updatedAt: guardian.updatedAt?.toISOString(),
  };
}

function serializeEmergencyContact(contact: EmergencyContactRecord) {
  return {
    createdAt: contact.createdAt?.toISOString(),
    hostelId: contact.hostelId.toString(),
    id: contact._id.toString(),
    isPrimary: contact.isPrimary,
    name: contact.name,
    phone: contact.phone,
    relation: contact.relation,
    residentId: contact.residentId.toString(),
    updatedAt: contact.updatedAt?.toISOString(),
  };
}

export async function auditResidentAction(
  principal: ApiPrincipal,
  hostelId: Types.ObjectId,
  residentId: Types.ObjectId,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await AuditLogModel.create({
    action,
    actorId: principal.userId,
    entityId: residentId.toString(),
    entityType: "Resident",
    hostelId,
    metadata,
  });
}

async function findResidentForPrincipal(
  residentId: string,
  principal: ApiPrincipal,
  requestedHostelId?: string,
) {
  const resident = await ResidentModel.findOne({
    _id: normalizeObjectId(residentId, "resident id"),
    isDeleted: false,
    ...scopedHostelFilter(principal, requestedHostelId),
  }).lean<ResidentRecord | null>();

  if (!resident) {
    throw new ResidentServiceError("Resident was not found.", "RESIDENT_NOT_FOUND", 404);
  }

  return resident;
}

function residentDashboardUrl() {
  const base =
    process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${base}/resident/dashboard`;
}

/**
 * Which account this intake is actually about, and how we know.
 *
 * Two handles, in order of how much they prove. A scanned platform resident ID
 * is the person themselves — the hostel held their card up to a camera and the
 * server resolved it to one row. An email address is a guess that is usually
 * right: `Resident.email` comes off `primaryEmail`, which the resident typed
 * into their profile and may edit independently of the address they sign in
 * with, so it identifies the account only as long as nobody has changed either.
 *
 * The returned `email` is always the **account's own** address, never the one
 * on the intake form: that is the mailbox the welcome mail has to reach, and the
 * two drift apart exactly when it matters.
 */
type IntakeAccount =
  | { email: string; reason?: undefined; userId: Types.ObjectId }
  | { email?: undefined; reason: string; userId?: undefined };

export async function findAccountForIntake(
  /*
   * The address on the intake, not a saved resident. `createResident` resolves
   * the account *before* anything is written — it is how the intake finds out
   * the person already lives in another hostel — and hands the answer to
   * `linkResidentAccount` rather than paying for the lookup twice.
   */
  intakeEmail: string | undefined,
  scannedResidentId?: string,
): Promise<IntakeAccount> {
  const scanned = scannedResidentId ? normalizeResidentId(scannedResidentId) : null;

  if (scanned) {
    const user = await UserModel.findOne({
      isDeleted: { $ne: true },
      userResidentId: scanned,
    })
      .select("_id email")
      .lean<{ _id: Types.ObjectId; email?: string } | null>();

    if (user?.email) {
      return { email: user.email.trim().toLowerCase(), userId: user._id };
    }

    /*
     * The card resolved to a real account that has no address on it. We stop
     * here rather than falling through to the email on the form: that email
     * would find a *different* account, and linking the wrong person to a bed is
     * a worse outcome than an activation code.
     */
    if (user) {
      return { reason: "ACCOUNT_HAS_NO_EMAIL" };
    }

    // A card that matches nobody — a deleted account, a stale printout — is not
    // fatal. The email below is still worth trying.
  }

  const email = intakeEmail?.trim().toLowerCase();

  if (!email) {
    return { reason: "NO_EMAIL" };
  }

  /*
   * Only ever promotes an account the resident already owns. If they have none,
   * creating one would mean mailing them a temporary password — and residents
   * are never sent credentials — so QR activation takes over instead.
   *
   * **All of them, and the promotable one wins.** An address is not unique in
   * the users collection and in practice is not unique in the field either: an
   * `INVITED` warden row the person never signed in to, sitting beside the
   * `PUBLIC` account they actually use, is the ordinary case. `findOne` returned
   * whichever Mongo reached first, and when that was the staff row the intake
   * refused the upgrade and the real account stayed public. A PUBLIC account is
   * the one this is allowed to raise; a RESIDENT one is already right.
   */
  const accounts = await UserModel.find({
    email,
    isDeleted: { $ne: true },
  })
    .select("_id email role")
    .lean<{ _id: Types.ObjectId; email?: string; role?: string }[]>();

  /*
   * Preference, not exclusion. A RESIDENT row is already right and a PUBLIC one
   * is the account the person actually uses day to day, so either wins over a
   * staff row on the same address. But when the staff row is the *only* one,
   * that is still them — and residency has no blocker, so it is promoted and
   * whatever it held is cleared (`promoteAccountToResident`). Refusing there is
   * what left a registered resident on a public login.
   */
  const promotable =
    accounts.find((account) => account.role === Role.RESIDENT) ??
    accounts.find((account) => account.role === Role.PUBLIC) ??
    accounts[0];

  if (!promotable) {
    return { reason: "NO_ACCOUNT" };
  }

  return {
    email: promotable.email?.trim().toLowerCase() ?? email,
    userId: promotable._id,
  };
}

export type ResidentAccountLink = {
  /** Why the account was not linked, when it was not. */
  reason?: string;
  /**
   * What becoming a resident took away, when it took anything.
   *
   * Returned rather than only emailed so the intake screen can say it out loud
   * too — an admin who has just closed somebody's warden access from a resident
   * form is entitled to know that is what the button did.
   */
  cleared?: ResidentPromotionClearance;
  emailed: boolean;
  linked: boolean;
  /**
   * The account this resident now signs in with, when one was linked.
   *
   * Returned rather than re-derived because the caller's next act is to notify
   * them, and re-finding the account from the resident's email is the exact
   * mistake `findAccountForIntake` documents: `Resident.email` is a field the
   * resident types into their profile, and it is not necessarily the address on
   * the account they sign in with.
   */
  userId?: string;
};

/**
 * Turns the resident's email into a working login the moment they are
 * registered — the same account upgrade a hostel owner gets when the platform
 * approves their hostel (ARCHITECTURE.md §3.2). A PUBLIC account keeps its
 * password and is simply promoted to RESIDENT, so the resident signs in the way
 * they always did and lands on /resident/dashboard.
 *
 * Which account that is comes from {@link findAccountForIntake}: the card the
 * hostel scanned when there was one, the email on the intake otherwise.
 *
 * QR activation stays as the manual fallback: residents registered without an
 * email and no card, or whose email already belongs to a staff account, still
 * redeem a code. Nothing here may fail the registration itself — the resident
 * record and their bed are already committed by the time this runs.
 */
export async function linkResidentAccount(
  resident: ResidentRecord,
  hostelId: Types.ObjectId,
  principal: ApiPrincipal,
  scannedResidentId?: string,
  /*
   * Whether to send the "you can sign in now" mail from here.
   *
   * A registration sends its own, richer confirmation instead
   * (`residentRegisteredEmail`), which covers the room, the rent and the first
   * invoice as well as the login — and which goes to residents who could not be
   * linked at all, who this mail by definition never reached. Two emails about
   * the same event, one of them a strict subset of the other, is worse than
   * either. The status-change path keeps it: marking somebody ACTIVE months
   * later is not a registration and has no confirmation of its own.
   */
  sendWelcome = true,
  /*
   * The account `createResident` already resolved before writing anything. It
   * has to know who the person is up front — that is how it refuses somebody
   * who lives in another hostel — so it passes the answer on rather than having
   * this look the same person up a second time.
   */
  resolvedAccount?: IntakeAccount,
): Promise<ResidentAccountLink> {
  /*
   * The scanned card wins, and it is tried first.
   *
   * A hostel that scanned somebody has *already* had the server resolve them to
   * an exact account — that is what `lookupResidentProfile` did to produce the
   * prefill on the screen. Re-deriving the same person from an email string
   * afterwards was the whole defect: the address on the intake is
   * `primaryEmail`, a field the resident types into their profile and can
   * change, while sign-in uses `User.email`. When the two differed the lookup
   * found nothing, the intake reported `NO_ACCOUNT`, and a resident the hostel
   * had physically scanned was left with a public account and no portal.
   *
   * Email stays as the fallback, because the manual path has no card to read.
   */
  const account =
    resolvedAccount ?? (await findAccountForIntake(resident.email, scannedResidentId));

  if (!account.userId) {
    return { emailed: false, linked: false, reason: account.reason };
  }

  const email = account.email;
  const userId = account.userId;

  try {
    const hostel = await HostelModel.findById(hostelId)
      .select("name")
      .lean<{ name?: string } | null>();

    /*
     * Same guard the QR flow enforces: one live resident profile per account,
     * so a returning resident cannot end up occupying two beds at once.
     *
     * **Asked before anything is written.** It used to run after the promotion
     * below, so a refusal returned `ACCOUNT_ALREADY_LINKED` over an account that
     * had already been handed this hostel. On 2026-09-11 a second hostel scanned
     * somebody who lived elsewhere; the link was refused and their login kept
     * both hostels for good — two `hostelIds` on every token, and everything that
     * resolves "the" hostel as the only one on the token treated them as
     * belonging to none. `createResident` now refuses that intake earlier, but
     * `updateResidentStatus` links through here with no such check, and two
     * hostels racing on one person get past it.
     */
    const conflicting = await ResidentModel.findOne({
      _id: { $ne: resident._id },
      isDeleted: false,
      status: { $in: ["ACTIVE", "PENDING"] },
      userId,
    }).lean<ResidentRecord | null>();

    if (conflicting) {
      return { emailed: false, linked: false, reason: "ACCOUNT_ALREADY_LINKED" };
    }

    /*
     * The row first, then the account.
     *
     * So a hostel only ever lands on a login whose resident row already points
     * back at it — which is what lets `deleteResident`'s `$pull`, keyed off
     * `resident.userId`, always take it off again.
     *
     * The account, and **only** the account.
     *
     * This used to `$set: { status: "ACTIVE" }` as well, and that write ran
     * after `raiseFirstMonthInvoice` had already decided not to bill. So a
     * warden who registered a pre-booking — the mobile intake's "not yet
     * arrived" toggle, which sends `PENDING` — got a resident who was silently
     * flipped to ACTIVE by the account link with **no rent invoice at all**:
     * the intake skipped them for being `PENDING` (`findBillableResidents`
     * bills the admitted only) and `updateResidentStatus` could never bill them
     * afterwards, because its `resident.status !== "ACTIVE"` guard was already
     * false. A resident living in the building, on the roll, owing nothing for
     * their move-in month, for ever.
     *
     * Linking a login is not admitting somebody. Both callers already own the
     * status: `createResident` writes what the form asked for, and
     * `updateResidentStatus` has just written ACTIVE itself — and *that* path
     * bills the move-in month on the way through, which is the whole point of
     * keeping the two acts separate.
     */
    await ResidentModel.updateOne(
      { _id: resident._id, isDeleted: false },
      {
        $set: {
          updatedBy: principal.userId,
          userId,
        },
      },
    );

    /*
     * The account, not the address, and residency wins.
     *
     * `registerOrUpgradeUserByEmail` used to do this, and it did two things
     * wrong for an intake. It re-derived the account from the email string —
     * throwing away the exact row `findAccountForIntake` had already resolved,
     * and matching a second row on the same mailbox instead — and it refused to
     * change the role of anything that was not already PUBLIC. Between them,
     * somebody with an unaccepted warden invitation on their address was
     * registered, invoiced and welcomed, and then left signed in as a public
     * user with no portal. `promoteAccountToResident` takes the id and clears
     * whatever stood in the way, reporting what it cleared so the resident can
     * be told.
     *
     * A refusal — an administrator account on the address — unlinks the row
     * again rather than leaving it pointing at a login that is not a resident.
     * That is the whole rollback: the promotion refuses before it writes, and
     * once its one write has landed it does not throw.
     */
    const upgrade = await promoteAccountToResident({
      hostelId,
      name: `${resident.firstName} ${resident.lastName}`.trim(),
      performedBy: principal.userId,
      phone: resident.phone,
      userId,
    }).catch(async (error: unknown) => {
      await ResidentModel.updateOne(
        { _id: resident._id, userId },
        { $set: { updatedBy: principal.userId }, $unset: { userId: "" } },
      );

      throw error;
    });

    await auditResidentAction(
      principal,
      hostelId,
      resident._id,
      "RESIDENT_ACCOUNT_LINKED",
      {
        clearedMemberships: upgrade.cleared.clearedMemberships.length,
        clearedRole: upgrade.cleared.clearedRole,
        email,
        upgraded: upgrade.upgraded,
      },
    );

    // Never blocks the link: a bounced welcome mail must not leave the resident
    // unable to reach a portal they can already sign in to.
    let emailed = false;

    if (sendWelcome) {
      try {
        await sendEmail({
          to: email,
          ...residentLinkedEmail({
            dashboardUrl: residentDashboardUrl(),
            hostelName: hostel?.name ?? "your hostel",
            residentName: resident.firstName,
          }),
        });
        emailed = true;
      } catch {
        emailed = false;
      }
    }

    /*
     * And, separately, what becoming a resident took away.
     *
     * Sent whether or not the welcome mail was — a registration sends its own
     * richer confirmation instead of the welcome, and somebody whose warden
     * access has just been closed still has to be told. Not sent when nothing
     * was cleared, which is the ordinary case: a second mail listing an empty
     * set is noise.
     *
     * Never blocks the link, for the same reason the welcome does not.
     */
    if (hasClearance(upgrade.cleared)) {
      try {
        await sendEmail({
          to: email,
          ...residentAccessClearedEmail({
            clearedMemberships: upgrade.cleared.clearedMemberships,
            clearedRole: upgrade.cleared.clearedRole,
            hostelName: hostel?.name ?? "your hostel",
            reactivatedInvite: upgrade.cleared.activatedInvite,
            residentName: resident.firstName,
          }),
        });
      } catch {
        // The access is already cleared; a bounced notice must not undo it.
      }
    }

    return {
      cleared: upgrade.cleared,
      emailed,
      linked: true,
      userId: userId.toString(),
    };
  } catch (error) {
    // An administrator account on the same address, a database that would not
    // take the write — the resident is registered either way and can still be
    // activated by QR code.
    return {
      emailed: false,
      linked: false,
      reason: error instanceof UserServiceError ? error.errorCode : "ACCOUNT_LINK_FAILED",
    };
  }
}

/** True for a MongoServerError raised by a unique-index violation. */
function isDuplicateKeyError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 11000
  );
}

/**
 * Which field a duplicate-key error was actually about.
 *
 * There are two unique indexes on a resident now, so mapping every E11000 to
 * "phone taken" would tell an admin to change a number that was never the
 * problem. Mongo names the offending index in `keyPattern`; when the driver
 * gives us neither that nor `keyValue` we fall back to the phone, which is the
 * older and far more common collision.
 */
function duplicateKeyField(error: unknown): "email" | "phone" {
  const key = (error as { keyPattern?: Record<string, unknown> })?.keyPattern;

  return key && "email" in key ? "email" : "phone";
}

/**
 * The email as it is stored — `Resident.email` carries `lowercase: true`, so a
 * query built from raw form input would miss `Asha@Gmail.com` against the
 * `asha@gmail.com` already on the roll. Empty string and whitespace collapse to
 * `undefined`: "no email" is not a value two residents can collide on.
 */
function normalizedEmail(email: string | undefined): string | undefined {
  return email?.trim().toLowerCase() || undefined;
}

/**
 * The move-in month's rent, raised as the resident is admitted.
 *
 * ## Why this exists at all
 *
 * Nothing used to bill a new resident until the monthly cron ran on the 1st, and
 * the cron bills the month it wakes up in. So somebody admitted on 20 August was
 * first invoiced for **September** and the twelve days of August they actually
 * lived there were never charged to anybody — silently, on every intake, in a
 * product whose whole subject is rent.
 *
 * ## It is `runBillingCycle`, not a second billing path
 *
 * `billing.service` documents at length why there is exactly one way an
 * obligation comes into existence, and that three paths disagreeing about
 * proration is what it replaced. A shortcut here — "create an invoice for the
 * quoted first month" — would be the fourth. Restricting the run to one resident
 * and one period gets the same proration, the same reference code, the same
 * credit application and the same audit entry, and it is idempotent: the unique
 * `(hostelId, residentId, period, kind)` index makes a second call a no-op, so
 * the activation path below can call it again without double-billing.
 *
 * ## Nothing here may fail the registration
 *
 * Same rule as the admission invoice, and for the same reason: the resident
 * exists and their bed is spent by the time this runs. A hostel with no rate
 * card gets `billed: []` and a reason on the response — which is a real and
 * expected outcome, not an error (`finance` §7.3) — rather than an intake that
 * reports failure after succeeding.
 */
async function raiseFirstMonthInvoice(input: {
  hostelId: Types.ObjectId | string;
  moveInDate: Date;
  principal: ApiPrincipal;
  residentId: Types.ObjectId;
}): Promise<FirstMonthInvoiceResult> {
  const period = periodOfDate(input.moveInDate);

  try {
    const result = await runBillingCycle(
      {
        hostelId: input.hostelId,
        period,
        residentIds: [input.residentId],
      },
      input.principal,
    );

    const invoice = result.billed[0];

    if (invoice) {
      return {
        amount: invoice.amount,
        invoiceId: invoice.invoiceId,
        period,
        raised: true,
        referenceCode: invoice.referenceCode,
      };
    }

    /*
     * Not billed, and the run says why. The three that actually happen are a
     * `PENDING` resident (`findBillableResidents` bills only the admitted —
     * they are billed when somebody marks them active), an already-billed
     * month, and a hostel with no rate card.
     */
    return {
      period,
      raised: false,
      reason:
        result.skipped[0]?.reason ?? result.failures[0]?.errorCode ?? "NOT_BILLABLE_YET",
    };
  } catch (error) {
    return {
      period,
      raised: false,
      reason: error instanceof Error ? error.message : "FIRST_MONTH_INVOICE_FAILED",
    };
  }
}

export type FirstMonthInvoiceResult =
  | { period: string; raised: false; reason: string }
  | {
      amount: number;
      invoiceId: string;
      period: string;
      raised: true;
      referenceCode: string;
    };

/**
 * Runs work that must not be able to fail the write it follows.
 *
 * Returns `null` instead of throwing. Every caller here is past the point where
 * the resident record is committed, so the only question left is what the screen
 * is told — and "registration failed" over a resident who is registered is the
 * worst available answer.
 */
async function nonFatal<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    logger.error("Post-registration step failed; the resident is registered.", {
      error: error instanceof Error ? error.message : String(error),
    });

    return null;
  }
}

/**
 * Takes the demo resident off every roll it is on — this hostel's included —
 * so the intake that follows registers it fresh. Soft-deleted like
 * `deleteResident`: its bed goes back and the account loses that hostel. The
 * account keeps its RESIDENT role; the new row is about to take it.
 */
async function removeDemoResident(principal: ApiPrincipal) {
  const rows = await ResidentModel.find({ email: DEMO_RESIDENT_EMAIL, isDeleted: { $ne: true } })
    .select("_id hostelId roomType status userId")
    .lean<Pick<ResidentRecord, "_id" | "hostelId" | "roomType" | "status" | "userId">[]>();

  for (const row of rows) {
    await ResidentModel.updateOne(
      { _id: row._id },
      {
        $set: {
          deletedAt: new Date(),
          deletedBy: principal.userId,
          isDeleted: true,
          updatedBy: principal.userId,
        },
      },
    );

    if (row.status !== "MOVED_OUT") {
      await releaseBedForRoomType(row.hostelId, row.roomType);
    }

    if (row.userId) {
      await UserModel.updateOne({ _id: row.userId }, { $pull: { hostelIds: row.hostelId } });
    }
  }
}

export async function createResident(
  input: ResidentCreateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const hostelId = resolveAdminHostelId(principal, input.hostelId);

  const email = normalizedEmail(input.email);

  if (isDemoResidentEmail(email)) {
    await removeDemoResident(principal);
  }

  /*
   * Checked before the bed is claimed so a duplicate never spends and refunds a
   * unit of vacancy. Soft-deleted residents are excluded on purpose: removing
   * someone has to free their phone number for a later re-registration.
   *
   * **Email is checked here too, and it was not before.** An admin who hit the
   * phone conflict, changed the number and submitted again registered the same
   * person twice — same mailbox, two resident records, and `linkResidentAccount`
   * then refusing the second one with `ACCOUNT_ALREADY_LINKED` because one
   * account cannot hold two live resident profiles. The number was the only
   * thing the hostel was ever asked to keep unique; the mailbox is what actually
   * identifies the person to the product, because it is what they sign in with.
   *
   * One query, not two: this runs on the slowest path in the portal and a second
   * round trip for the second field would be paid on every intake.
   */
  const existing = await ResidentModel.findOne({
    hostelId,
    /*
     * `$ne: true`, not `false`. A resident registered before `isDeleted` existed
     * has no such field, and `isDeleted: false` does not match a missing key —
     * so the oldest residents on a roll, the ones most likely to have collected
     * a duplicate already, were invisible to this check. The rest of the
     * codebase (`getInvoiceMatrix`, `findBillableResidents`) already tests it
     * this way; this was the one that did not.
     *
     * Deliberately wider than the unique index's own filter, which cannot use
     * `$ne`. Being stricter here than the index costs a refused intake that the
     * database would have allowed, and that refusal is the correct answer.
     */
    isDeleted: { $ne: true },
    ...(email ? { $or: [{ phone: input.phone }, { email }] } : { phone: input.phone }),
  }).lean<ResidentRecord>();

  if (existing) {
    const onPhone = existing.phone === input.phone;

    throw new ResidentServiceError(
      onPhone
        ? `${existing.firstName} ${existing.lastName} is already registered here with the phone ${input.phone}.`
        : `${existing.firstName} ${existing.lastName} is already registered here with the email ${email}. Use a different address, or edit the resident that already exists.`,
      onPhone ? "RESIDENT_PHONE_TAKEN" : "RESIDENT_EMAIL_TAKEN",
      409,
    );
  }

  /*
   * One person, one home — held here, before anything is written.
   *
   * The rule used to live only in `linkResidentAccount`, which runs after the
   * row, the bed and the invoices are committed and answers a conflict with
   * `linked: false`. So a resident of one hostel could be scanned and admitted
   * at a second: two rows, two beds, two bills, one login that silently did not
   * link. Asked on the account the card resolves to and on every address we
   * hold for them, in any hostel — the same-hostel check above only ever saw
   * this hostel's phone and email.
   */
  const account = await findAccountForIntake(email, input.userResidentId);
  const residency = await findLiveResidency(
    { emails: [email, account.email], userIds: [account.userId] },
    hostelId,
  );

  if (residency) {
    throw new ResidentServiceError(
      liveResidencyMessage(`${input.firstName} ${input.lastName}`, residency),
      residency.sameHostel ? "RESIDENT_ALREADY_HERE" : "RESIDENT_LIVES_ELSEWHERE",
      409,
    );
  }

  // A mistyped referral code fails here, before any bed is spent — the admin
  // clears the field and retries rather than losing the whole intake.
  if (input.referralCode) {
    await assertActiveReferralCode(input.referralCode, hostelId);
  }

  /*
   * The price is resolved here, not received. The screen showed the same figures
   * before the warden pressed the button, but quoting again at the moment of
   * writing is what makes them true: a rate card can be replaced between opening
   * the form and submitting it, and the number that goes on the invoice has to
   * be the one in force now rather than the one on somebody's screen.
   */
  const quote = await getIntakeQuote(hostelId, {
    moveInDate: input.moveInDate,
    referralCode: input.referralCode,
    roomType: input.roomType,
  });

  /*
   * A card whose account holds a confirmed booking here already has a bed: it
   * becomes theirs (moved across if the room type changed) instead of a second
   * one being claimed. Personal — only the scanned card's own account counts.
   */
  const heldBooking =
    input.userResidentId && account.userId ? await findHeldBooking(hostelId, account.userId) : null;

  await assertPlanRoom(hostelId, "residents");

  // Claim the bed before creating the resident: if the room type is full this
  // throws and no half-registered resident is left behind.
  // A short stay's guest: nights paid through the booking, no joining or monthly invoice.
  const shortStay = heldBooking?.stay ?? null;

  if (heldBooking) {
    await takeHeldBed(heldBooking, input.roomType);
  } else {
    await claimBedForRoomType(hostelId, input.roomType);
  }

  let resident;

  try {
    resident = await ResidentModel.create({
      // `userResidentId` is how the intake identifies the *account*; it is not
      // a field of the resident record and must not be written onto one.
      ...definedUpdate(input, ["depositAmount", "referralCode", "userResidentId"]),
      admissionFee: quote.admissionFee > 0 ? quote.admissionFee : null,
      admissionFeeDiscount: quote.referral.discount,
      createdBy: principal.userId,
      // What was actually collected when it was said, the rate card's figure
      // otherwise. Not `?? 0`: a schedule that names a deposit is the answer to
      // a form that left the box alone.
      depositAmount: input.depositAmount ?? quote.depositAmount,
      hostelId,
      isDeleted: false,
      referralCode: quote.referral.code ?? undefined,
      ...(shortStay ? { admissionFee: null, depositAmount: 0, stayEndsAt: stayEndsAt(shortStay) } : {}),
      updatedBy: principal.userId,
    });
  } catch (error) {
    // Duplicate phone, validation failure — give the bed back rather than
    // leaking a unit of vacancy on every failed intake.
    if (heldBooking) {
      await returnHeldBed(heldBooking, input.roomType);
    } else {
      await releaseBedForRoomType(hostelId, input.roomType);
    }

    // Two intakes racing on the same number or mailbox land here; the check
    // above only narrows the window, the index is what actually closes it.
    if (isDuplicateKeyError(error)) {
      const field = duplicateKeyField(error);

      throw new ResidentServiceError(
        field === "email"
          ? `Someone is already registered here with the email ${email}.`
          : `Someone is already registered here with the phone ${input.phone}.`,
        field === "email" ? "RESIDENT_EMAIL_TAKEN" : "RESIDENT_PHONE_TAKEN",
        409,
      );
    }

    throw error;
  }

  /*
   * Everything from here down is bookkeeping *about* a resident who already
   * exists, and none of it may fail the registration.
   *
   * This is the defect an admin actually sees: the row is written, the bed is
   * spent, the confirmation email goes out — and the screen says the intake
   * failed, because something after the write threw. The admin then registers
   * them again and collects a duplicate-phone 409 over a resident who is sitting
   * in the list behind the dialog. An audit row that would not save, or a
   * referral link that could not be made, are both real and both worth knowing
   * about; neither is worth telling a hostel their resident was not admitted.
   */
  await nonFatal(() =>
    auditResidentAction(principal, hostelId, resident._id, "RESIDENT_CREATED", {
      roomType: input.roomType,
    }),
  );

  // The booking closes as moved in: no cancelling from here, the hostel's share falls due.
  if (heldBooking) {
    await nonFatal(() =>
      checkInBooking(heldBooking, { principal, residentId: resident._id, roomType: input.roomType }),
    );
  }

  const referral = input.referralCode
    ? await nonFatal(() =>
        linkReferralOnRegistration({
          code: input.referralCode as string,
          hostelId,
          joinedResidentId: resident._id,
          name: `${input.firstName} ${input.lastName}`.trim(),
          phone: input.phone,
          principal,
        }),
      )
    : null;

  // Last, and never fatally: the resident is registered by this point, so an
  // admission fee that cannot be invoiced is a reason returned to the screen,
  // not an error that tells the hostel their intake failed when it did not.
  const admission = shortStay
    ? { raised: false as const, reason: "A short stay is paid through its booking." }
    : await raiseAdmissionInvoice({
        dueDate: input.moveInDate,
        hostelId,
        principal,
        quote,
        residentId: resident._id,
      });

  /*
   * And the rent for the month they are moving into — prorated from the move-in
   * day, so a 20 August intake owes twelve days rather than a whole month or,
   * as before this, nothing at all. Every month after this one is the cron's.
   */
  const firstMonth = shortStay
    ? { raised: false as const, reason: "A short stay is paid through its booking." }
    : await raiseFirstMonthInvoice({
        hostelId,
        moveInDate: input.moveInDate,
        principal,
        residentId: resident._id,
      });

  const accountLink = await linkResidentAccount(
    resident as ResidentRecord,
    hostelId,
    principal,
    input.userResidentId,
    // The registration confirmation below replaces the linked-account mail.
    false,
    account,
  );

  /*
   * Last of all, and after the account link: the notification has to know
   * whether this resident has a login before it can tell them how to sign in,
   * and it pushes to that account's devices.
   *
   * **Off the response's critical path, and still guaranteed to run.** This is
   * four notifications, an Expo round trip and up to two emails — a second or
   * more of work that a warden standing at a desk with a resident in front of
   * them should not be made to watch, on the slowest write in the portal. But
   * it cannot simply be dropped on the floor either: an un-awaited promise on a
   * serverless platform dies with the invocation. `after()` is the one answer
   * that is both (`lib/after-response.ts`).
   */
  afterResponse(() =>
    notifyResidentRegistered({
      admissionFee: quote.admissionPayable > 0 ? quote.admissionPayable : null,
      depositAmount: resident.depositAmount ?? null,
      firstMonth: firstMonth.raised
        ? {
            amount: firstMonth.amount,
            invoiceId: firstMonth.invoiceId,
            period: firstMonth.period,
            prorated: quote.firstMonth?.prorated ?? false,
            referenceCode: firstMonth.referenceCode,
          }
        : null,
      hostelId,
      monthlyRent: quote.monthlyRent,
      resident: {
        _id: resident._id,
        email: resident.email,
        firstName: resident.firstName,
        lastName: resident.lastName,
        moveInDate: input.moveInDate,
        roomNumber: resident.roomNumber ?? null,
        roomType: input.roomType,
        userId: resident.userId,
      },
      residentUserId: accountLink.userId ?? null,
    }),
  );

  /*
   * And how the hostel takes money, returned with the intake rather than looked
   * up afterwards.
   *
   * The two invoices above are the whole reason: they carry reference codes, and
   * a reference code is only worth allocating if the resident actually quotes it
   * on the transfer. The desk is the one moment where that can be guaranteed —
   * the resident is standing there. Sending them away to find the hostel's eSewa
   * id somewhere else is how a transfer arrives with no reference and lands in
   * the owner's review queue as an unidentifiable payment.
   *
   * Priced on what was actually raised, so the Fonepay personal-wallet cap is
   * judged against the sum the resident is being asked for today.
   *
   * Non-fatal like everything else past the write: a hostel that has not set up
   * a payment profile still registered a resident.
   */
  const howToPay = await nonFatal(() =>
    getHostelPayMethods(
      hostelId,
      (admission.raised ? admission.amount : 0) +
        (firstMonth.raised ? firstMonth.amount : 0),
    ),
  );

  return {
    accountLink,
    admission,
    firstMonth,
    howToPay,
    quote,
    referral,
    resident: serializeResident(
      (accountLink.linked
        ? await ResidentModel.findById(resident._id).lean<ResidentRecord>()
        : resident) as ResidentRecord,
    ),
  };
}

/**
 * The login each resident on this page actually signs in with.
 *
 * `Resident.email` cannot answer this. It is what the hostel wrote down, and on
 * a scanned intake it is `primaryEmail` off the resident's profile form — which
 * is not necessarily the address on their account. A screen that printed it as
 * "their login" would be confidently wrong in exactly the case an admin needs it
 * to be right, so the account is read from the account.
 *
 * One query for the whole page, not one per row: this runs behind the resident
 * list, which is the most-opened screen in the portal.
 */
async function findResidentAccounts(residents: ResidentRecord[]) {
  const userIds = residents
    .map((resident) => resident.userId)
    .filter((userId): userId is Types.ObjectId => Boolean(userId));

  if (userIds.length === 0) {
    return new Map<string, ResidentAccount>();
  }

  const users = await UserModel.find({
    _id: { $in: userIds },
    isDeleted: { $ne: true },
  })
    .select("_id email image name")
    .lean<{ _id: Types.ObjectId; email?: string; image?: string; name?: string }[]>();

  return new Map(
    users.map((user) => [
      user._id.toString(),
      {
        email: user.email ?? "",
        /*
         * Their face. It is a URL, not bytes — `/api/v1/users/<id>/avatar` for
         * the photo they put on their ID card, or whatever their sign-in
         * provider stored. The card photo is the picture this product shows for
         * a person everywhere, so a roster row and their own header draw the
         * same one.
         */
        image: user.image ?? null,
        name: user.name ?? "",
      },
    ]),
  );
}

export async function listResidents(query: ResidentListQuery, principal: ApiPrincipal) {
  await connectToDatabase();

  const filter: Record<string, unknown> = {
    isDeleted: false,
    ...scopedHostelFilter(principal, query.hostelId),
  };

  if (query.status) {
    filter.status = query.status;
  }

  if (query.residentType) {
    filter.residentType = query.residentType;
  }

  if (query.q) {
    // Escaped — the search box feeds this straight into a Mongo pattern.
    const pattern = new RegExp(escapeRegex(query.q), "i");
    filter.$or = [
      { firstName: pattern },
      { lastName: pattern },
      { phone: pattern },
      { email: pattern },
    ];
  }

  const { limit, skip } = paginationRange(query);

  const [residents, total] = await Promise.all([
    ResidentModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<ResidentRecord[]>(),
    ResidentModel.countDocuments(filter),
  ]);

  const accounts = await findResidentAccounts(residents);

  return {
    pagination: paginationMeta(query, total),
    residents: residents.map((resident) => ({
      ...serializeResident(resident),
      /*
       * `null` means no login — either nobody linked one, or the account behind
       * `userId` is gone. Both end the same way for the hostel: this person
       * cannot sign in, and needs an activation code.
       */
      account: resident.userId
        ? (accounts.get(resident.userId.toString()) ?? null)
        : null,
    })),
  };
}

export async function getResidentById(
  residentId: string,
  query: { hostelId?: string },
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const resident = await findResidentForPrincipal(residentId, principal, query.hostelId);
  /*
   * The same join the list does, for one row. The dossier is where a warden
   * checks a record against a person, so it needs the same two things the list
   * needs: the address they actually sign in with, and their photograph.
   */
  const accounts = await findResidentAccounts([resident]);

  return {
    resident: {
      ...serializeResident(resident),
      account: resident.userId
        ? (accounts.get(resident.userId.toString()) ?? null)
        : null,
    },
  };
}

export async function updateResident(
  residentId: string,
  input: ResidentUpdateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const resident = await findResidentForPrincipal(residentId, principal, input.hostelId);
  const residentUpdate = definedUpdate(input, ["hostelId"]);

  // Editing a phone onto one that is already on the roll would otherwise
  // surface as a raw duplicate-key 500.
  if (input.phone && input.phone !== resident.phone) {
    const phoneTaken = await ResidentModel.exists({
      _id: { $ne: resident._id },
      hostelId: resident.hostelId,
      isDeleted: false,
      phone: input.phone,
    });

    if (phoneTaken) {
      throw new ResidentServiceError(
        `Someone is already registered here with the phone ${input.phone}.`,
        "RESIDENT_PHONE_TAKEN",
        409,
      );
    }
  }

  // Same rule as intake, and for the same reason: the edit form is the other
  // door onto the roll, and a uniqueness rule that only one door enforces is
  // not a rule.
  const nextEmail = normalizedEmail(input.email);

  if (nextEmail && nextEmail !== normalizedEmail(resident.email)) {
    const emailTaken = await ResidentModel.exists({
      _id: { $ne: resident._id },
      email: nextEmail,
      hostelId: resident.hostelId,
      isDeleted: false,
    });

    if (emailTaken) {
      throw new ResidentServiceError(
        `Someone is already registered here with the email ${nextEmail}.`,
        "RESIDENT_EMAIL_TAKEN",
        409,
      );
    }
  }

  // Switching room type moves a unit of vacancy from one type to the other.
  // Done before the write so a full destination type aborts the whole update.
  if (input.roomType && input.roomType !== resident.roomType) {
    await moveBedBetweenRoomTypes(resident.hostelId, resident.roomType, input.roomType);
  }

  const updatedResident = await ResidentModel.findOneAndUpdate(
    { _id: resident._id, isDeleted: false },
    {
      $set: {
        ...residentUpdate,
        // A corrected email is a new question: whoever owns the new address has
        // not said "this is not me" yet (`residency-invite.service.ts`).
        ...(nextEmail && nextEmail !== normalizedEmail(resident.email)
          ? { accountLinkDeclinedAt: null, accountLinkDeclinedBy: null }
          : {}),
        updatedBy: principal.userId,
      },
    },
    { new: true },
  ).lean<ResidentRecord | null>();

  if (!updatedResident) {
    throw new ResidentServiceError("Resident was not found.", "RESIDENT_NOT_FOUND", 404);
  }

  await auditResidentAction(
    principal,
    resident.hostelId,
    resident._id,
    "RESIDENT_UPDATED",
  );

  /*
   * And the resident, if this moved them. Reads the record as it was before the
   * write, so a bed swap within one room type is told apart from a change of
   * room type — see `notifyResidentRoomChanged`, which stays quiet when neither
   * actually moved.
   */
  await notifyResidentRoomChanged({
    hostelId: resident.hostelId,
    previous: { roomType: resident.roomType },
    resident: updatedResident,
  });

  return {
    resident: serializeResident(updatedResident),
  };
}

export async function updateResidentStatus(
  residentId: string,
  input: ResidentStatusInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const resident = await findResidentForPrincipal(residentId, principal, input.hostelId);
  const updatedResident = await ResidentModel.findOneAndUpdate(
    { _id: resident._id, isDeleted: false },
    {
      $set: {
        status: input.status,
        updatedBy: principal.userId,
      },
    },
    { new: true },
  ).lean<ResidentRecord | null>();

  if (!updatedResident) {
    throw new ResidentServiceError("Resident was not found.", "RESIDENT_NOT_FOUND", 404);
  }

  // Moving out frees their bed. Guarded on the previous status so re-saving an
  // already MOVED_OUT resident does not hand back a second bed.
  if (input.status === "MOVED_OUT" && resident.status !== "MOVED_OUT") {
    await releaseBedForRoomType(resident.hostelId, resident.roomType);
    await releaseResidentAccount(resident.userId, resident.hostelId);
  }

  /*
   * Admitting somebody who was registered as `PENDING` bills their move-in
   * month, which the intake could not: `findBillableResidents` bills the
   * admitted only, so a pending intake correctly raised no rent invoice and this
   * is where it becomes owed.
   *
   * **Only for a month that has not ended.** A resident pending since June and
   * admitted in September would otherwise be handed a retroactive June invoice
   * by a status change nobody connected to billing — a surprise charge produced
   * by a dropdown. From the month they are actually admitted onward, the cron
   * has them.
   *
   * Idempotent, so a resident who was already billed at intake and is toggled
   * ACTIVE → SUSPENDED → ACTIVE is not billed twice; the run reports
   * `ALREADY_BILLED` and nothing is written.
   */
  const firstMonth =
    input.status === "ACTIVE" &&
    resident.status !== "ACTIVE" &&
    updatedResident.moveInDate &&
    periodOfDate(updatedResident.moveInDate) >= periodOfDate(new Date())
      ? await raiseFirstMonthInvoice({
          hostelId: resident.hostelId,
          moveInDate: updatedResident.moveInDate,
          principal,
          residentId: resident._id,
        })
      : null;

  // Marking someone active by hand has to give them a working login too,
  // otherwise the status says ACTIVE while their account is still PUBLIC and
  // signing in drops them on the public home page. Residents created before
  // auto-linking existed reach their portal through exactly this path.
  // A move-out handed their login back to public; coming back takes it again.
  const returning =
    input.status === "ACTIVE" && resident.status === "MOVED_OUT" && resident.userId
      ? await UserModel.findOne({ _id: resident.userId, isDeleted: { $ne: true } })
          .select("_id email")
          .lean<{ _id: Types.ObjectId; email?: string } | null>()
      : null;
  const accountLink =
    input.status === "ACTIVE" && (!resident.userId || returning?.email)
      ? await linkResidentAccount(
          updatedResident,
          resident.hostelId,
          principal,
          undefined,
          true,
          returning?.email
            ? { email: returning.email.trim().toLowerCase(), userId: returning._id }
            : undefined,
        )
      : { emailed: false, linked: Boolean(resident.userId) };

  await auditResidentAction(
    principal,
    resident.hostelId,
    resident._id,
    "RESIDENT_STATUS_UPDATED",
    { status: input.status },
  );

  /*
   * Hoisted out of the return so the notification below can use it too.
   *
   * It matters which copy: `linkResidentAccount` may have just given this
   * resident their first `userId`, and that write does not land on
   * `updatedResident`. Notifying from the stale copy would silently skip the one
   * case where somebody is being admitted *and* handed their login in the same
   * action — which is the most useful moment in this whole function to reach
   * them.
   */
  const finalResident =
    accountLink.linked && !resident.userId
      ? ((await ResidentModel.findById(resident._id).lean<ResidentRecord>()) ??
        updatedResident)
      : updatedResident;

  await notifyResidentStatusChanged({
    hostelId: resident.hostelId,
    previousStatus: resident.status,
    resident: finalResident,
    status: input.status,
  });

  return {
    accountLink,
    firstMonth,
    resident: serializeResident(finalResident),
  };
}

/**
 * Guardian + emergency records already on file for a resident. When the intake
 * form was filled from a resident ID these exist from the moment the resident
 * is created, so the admin panel can show them instead of a blank form.
 */
export async function listResidentContacts(
  residentId: string,
  query: { hostelId?: string },
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const resident = await findResidentForPrincipal(residentId, principal, query.hostelId);
  const [guardians, emergencyContacts] = await Promise.all([
    GuardianModel.find({ residentId: resident._id })
      .sort({ isPrimary: -1, createdAt: 1 })
      .lean<GuardianRecord[]>(),
    EmergencyContactModel.find({ residentId: resident._id })
      .sort({ isPrimary: -1, createdAt: 1 })
      .lean<EmergencyContactRecord[]>(),
  ]);

  return {
    emergencyContacts: emergencyContacts.map(serializeEmergencyContact),
    guardians: guardians.map(serializeGuardian),
  };
}

/**
 * Soft-deletes a resident and hands their bed back. Soft because payments,
 * complaints and audit rows still reference the id; every read path already
 * filters on `isDeleted: false`.
 */
export async function deleteResident(
  residentId: string,
  query: { hostelId?: string },
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const resident = await findResidentForPrincipal(residentId, principal, query.hostelId);

  await ResidentModel.updateOne(
    { _id: resident._id, isDeleted: false },
    {
      $set: {
        deletedAt: new Date(),
        deletedBy: principal.userId,
        isDeleted: true,
        updatedBy: principal.userId,
      },
    },
  );

  // A resident who already moved out gave their bed back then; releasing again
  // would invent a unit of vacancy.
  if (resident.status !== "MOVED_OUT") {
    await releaseBedForRoomType(resident.hostelId, resident.roomType);
  }

  // A guardian's view of this resident goes with the profile. Left ACTIVE or
  // USED, the row keeps matching the guardian's login and their dashboard 404s
  // on a ward who is no longer here. A guardian left with no ward is handed back
  // the account they had before, the same as the resident's own below.
  const liveGuardianAccess = {
    hostelId: resident.hostelId,
    residentId: resident._id,
    status: { $in: ["ACTIVE", "USED"] },
  };
  const guardianUserIds = await GuardianAccessModel.distinct("userId", liveGuardianAccess);

  await GuardianAccessModel.updateMany(liveGuardianAccess, {
    $set: { status: "REVOKED" },
    $unset: { invitationToken: "" },
  });
  await releaseGuardianAccounts(guardianUserIds, resident.hostelId);

  // The account outlives the resident profile: losing your room does not lose
  // you your login, only this hostel — and the RESIDENT role once they live
  // nowhere.
  await releaseResidentAccount(resident.userId, resident.hostelId);

  await auditResidentAction(
    principal,
    resident.hostelId,
    resident._id,
    "RESIDENT_DELETED",
    {
      roomType: resident.roomType,
      status: resident.status,
    },
  );

  return {
    residentId: resident._id.toString(),
  };
}

export async function addGuardian(
  residentId: string,
  input: GuardianCreateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const resident = await findResidentForPrincipal(residentId, principal);
  const guardian = await GuardianModel.create({
    ...input,
    hostelId: resident.hostelId,
    residentId: resident._id,
  });

  await notifyGuardianOfRegistration(resident, input);

  return {
    guardian: serializeGuardian(guardian as GuardianRecord),
    resident: serializeResident(resident),
  };
}

/**
 * Tells a newly attached guardian that their ward lives at this hostel.
 *
 * **Hooked here rather than to the registration**, and that is the whole
 * design. A scanned intake writes the resident first and their guardian records
 * afterwards (`attachContacts` in the mobile intake), so at the moment of
 * registration there is no guardian to write to — a registration-time send would
 * have reached nobody in the case it was built for. Attaching the guardian is
 * the first moment the address exists, and it fires once per guardian whether
 * they arrived with the intake or a fortnight later.
 *
 * Silent for a guardian with no email, and for a resident who has already moved
 * out — adding a historical contact to a closed record is not news.
 *
 * Never throws: the guardian record is already written, and a bounced mail must
 * not report failure over a contact the hostel can see on the screen.
 */
async function notifyGuardianOfRegistration(
  resident: ResidentRecord,
  guardian: GuardianCreateInput,
) {
  if (!guardian.email || resident.status === "MOVED_OUT") {
    return;
  }

  try {
    const hostel = await HostelModel.findById(resident.hostelId)
      .select("contact name")
      .lean<{ contact?: { phone?: string }; name?: string } | null>();

    const email = wardRegisteredEmail({
      guardianName: `${guardian.firstName} ${guardian.lastName}`.trim(),
      hostelName: hostel?.name ?? "the hostel",
      hostelPhone: hostel?.contact?.phone ?? null,
      moveInDate: resident.moveInDate ?? null,
      relation: guardian.relation,
      residentName: `${resident.firstName} ${resident.lastName}`.trim(),
      roomType: resident.roomType ?? null,
    });

    await sendEmail({ to: guardian.email, ...email });
  } catch (error) {
    console.warn(
      JSON.stringify({
        action: "guardian_registration_email_failed",
        level: "warn",
        message: error instanceof Error ? error.message : "Unknown email error",
        residentId: resident._id.toString(),
      }),
    );
  }
}

export async function addEmergencyContact(
  residentId: string,
  input: EmergencyContactCreateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const resident = await findResidentForPrincipal(residentId, principal);
  const emergencyContact = await EmergencyContactModel.create({
    ...input,
    hostelId: resident.hostelId,
    residentId: resident._id,
  });

  return {
    emergencyContact: serializeEmergencyContact(
      emergencyContact as EmergencyContactRecord,
    ),
    resident: serializeResident(resident),
  };
}
