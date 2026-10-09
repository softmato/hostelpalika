import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import type { PlatformIdCardType } from "@/lib/platform-id-card";
import { getPresignedReadUrl } from "@/lib/r2";
import { getResidentLedger } from "@/modules/finance/resident-ledger.service";
import {
  ageFromDateOfBirth,
  normalizeResidentId,
  readProfile,
  ResidentIdentityError,
  resolvePlatformIdCard,
} from "@/modules/users/resident-identity.service";
import type { ResidentProfileData } from "@/modules/users/resident-identity.validation";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { ComplaintModel } from "@hostel/db/models/Complaint";
import { EmergencyContactModel } from "@hostel/db/models/EmergencyContact";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { GuardianModel } from "@hostel/db/models/Guardian";
import { HostelModel } from "@hostel/db/models/Hostel";
import { NightStatusModel } from "@hostel/db/models/NightStatus";
import { ResidentModel } from "@hostel/db/models/Resident";
import { UserModel } from "@hostel/db/models/User";
import { UserResidentProfileModel } from "@hostel/db/models/UserResidentProfile";
import { PLATFORM_NAME } from "@hostel/shared/brand/brand";

/**
 * Reading somebody's ID card in the corridor.
 *
 * ## Why this is not `lookupResidentProfile` with more fields hung off it
 *
 * That function answers exactly one question — *fill this registration form in
 * for me* — and every refusal it carries exists to serve it. A service
 * provider's card is rejected because you cannot admit an electrician as a
 * tenant. An unfinished profile is a 404 because there is nothing to prefill.
 * Sharing switched off is a 403 because the form would come back empty. All
 * three are the right answer to *that* question and the wrong answer to this
 * one.
 *
 * Scanning a card at the door asks something else: **who is this, and what does
 * my hostel already know about them.** Nothing here is fatal. A provider card,
 * a profile that was never completed, sharing turned off — each degrades to a
 * sentence on the screen, and every other part of the record still comes back.
 * The one thing that is still a hard error is an id that matches no account,
 * because there is then nobody to describe.
 *
 * ## Two halves, owned by two different people
 *
 * `profile` is the holder's own portable profile. It is theirs, it is disclosed
 * under their sharing switch, and every read is audited and announced to them.
 *
 * `membership` is the hostel's tenancy record for that person — the row the
 * hostel typed in itself, the money it has billed, the complaints it has been
 * sent. It is deliberately **not** gated on the sharing switch: a toggle on
 * somebody's platform profile cannot take a hostel's own roster away from it.
 *
 * Both halves are independently nullable and the screen is told which one it is
 * missing and why, rather than being handed an empty object to guess about.
 */
export type ResidentScanResult = {
  account: {
    cardRole: string | null;
    /** `HOSTEL_OWNER` or `SERVICE_PROVIDER` means this is not a resident's card. */
    cardType: PlatformIdCardType;
    email: string | null;
    hasPhoto: boolean;
    name: string;
    photoUpdatedAt: string | null;
  };
  membership: ResidentScanMembership | null;
  /** Why `membership` is null. Null itself when there is a membership. */
  membershipNotice: string | null;
  profile: (ResidentProfileData & { age: number | null }) | null;
  /** Why `profile` is null. Null itself when the profile is present. */
  profileNotice: string | null;
  residentId: string;
  scannedAt: string;
};

export type ResidentScanMembership = {
  complaints: {
    open: number;
    recent: {
      category: string;
      createdAt: string | null;
      id: string;
      status: string;
      title: string;
    }[];
    total: number;
  };
  contacts: {
    emergencyContacts: {
      id: string;
      isPrimary: boolean;
      name: string;
      phone: string;
      relation: string;
    }[];
    guardians: {
      email: string;
      firstName: string;
      id: string;
      isPrimary: boolean;
      lastName: string;
      phone: string;
      relation: string;
    }[];
  };
  hostel: { id: string; name: string };
  /**
   * Their whole payment history, month by month. Null when the caller has no
   * `viewPayments` grant — a warden may be trusted with the door and not with
   * the money, and that refusal must not take the rest of the screen with it.
   */
  ledger: Awaited<ReturnType<typeof getResidentLedger>>;
  ledgerDenied: boolean;
  /**
   * How the tenancy was found.
   *
   * `ACCOUNT` is the reliable one: the resident row points at this exact user.
   * `PHONE` and `EMAIL` mean the row was matched on a detail from the scanned
   * profile because that person has never redeemed an activation code — which
   * is the normal case for a hostel that registers people at the desk. The
   * screen prints which it was, because "this is them" and "this is probably
   * them" are different claims.
   */
  matchedBy: "ACCOUNT" | "EMAIL" | "PHONE";
  nightStatus: {
    checkedAt: string | null;
    note: string | null;
    source: string;
    status: string;
  } | null;
  resident: {
    createdAt: string | null;
    depositAmount: number;
    email: string | null;
    firstName: string;
    id: string;
    lastName: string;
    /** Null is "no override" — the hostel's fee schedule governs. Zero is free. */
    monthlyFee: number | null;
    moveInDate: string;
    phone: string;
    residentType: string;
    roomType: string;
    status: string;
    userId: string | null;
  };
};

type UserRecord = {
  _id: Types.ObjectId;
  email?: string | null;
  name: string;
  userResidentId?: string | null;
};

type ProfileRecord = {
  _id: Types.ObjectId;
  completedAt?: Date;
  encryptedData: string;
  lastSharedAt?: Date | null;
  lastSharedWithHostelId?: Types.ObjectId | null;
  photoAssetId?: Types.ObjectId | null;
  photoUpdatedAt?: Date | null;
  sharingEnabled?: boolean;
};

/**
 * How long one scan stays "the same scan" for notification purposes.
 *
 * The **audit log is never suppressed** — every disclosure is a row, because
 * that is the record somebody would go looking for months later. What this
 * quiets is the notification, and the case it exists for is ordinary use: a
 * warden reads the card, taps into a complaint, comes back, pulls to refresh
 * because the ledger looked stale. That is one look at one person, and telling
 * them about it four times is how a notification that matters gets swiped away
 * unread.
 *
 * Scoped to the same hostel as well as the same window — a *second* hostel
 * reading the same card is a different event and always says so.
 */
const SCAN_NOTICE_QUIET_MS = 10 * 60 * 1000;

type PhotoAssetRecord = {
  /** Off the asset, not the environment — rows predate the public/private split. */
  bucket: string;
  key: string;
  mimeType: string;
};

type ResidentRecord = {
  _id: Types.ObjectId;
  createdAt?: Date;
  depositAmount?: number;
  email?: string | null;
  firstName: string;
  hostelId: Types.ObjectId;
  lastName: string;
  monthlyFee?: number | null;
  moveInDate: Date;
  phone: string;
  residentType?: string;
  roomType: string;
  status: string;
  userId?: Types.ObjectId | null;
};

/** The hostels this caller may read. Empty means no scope at all. */
function scanScope(principal: ApiPrincipal, hostelId?: string) {
  const ids = hostelId ? [hostelId] : principal.hostelIds;

  return ids
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
}

/**
 * Resolves a scanned string to the account holding that card.
 *
 * Shared by {@link scanResidentForHostel} and {@link readScannedResidentPhoto}
 * so the photo endpoint cannot be pointed at somebody the dossier would have
 * withheld: both run the same normalise-and-find, and both stop at the same
 * sharing switch.
 */
async function findScannedAccount(residentIdInput: string) {
  await connectToDatabase();

  const residentId = normalizeResidentId(residentIdInput);

  if (!residentId) {
    throw new ResidentIdentityError(
      "That does not look like a resident ID. It should read like HH-4K7M-9XQ2.",
      "RESIDENT_ID_INVALID",
      422,
    );
  }

  const user = await UserModel.findOne({
    isDeleted: { $ne: true },
    userResidentId: residentId,
  })
    .select("email name userResidentId")
    .lean<UserRecord | null>();

  if (!user) {
    throw new ResidentIdentityError(
      `No ${PLATFORM_NAME} account carries that ID card.`,
      "RESIDENT_PROFILE_NOT_FOUND",
      404,
    );
  }

  const record = await UserResidentProfileModel.findOne({
    isDeleted: { $ne: true },
    userId: user._id,
  })
    .select(
      "completedAt encryptedData lastSharedAt lastSharedWithHostelId photoAssetId photoUpdatedAt sharingEnabled",
    )
    .lean<ProfileRecord | null>();

  /*
   * One switch decides both the written profile and the face. Someone who has
   * turned sharing off has not agreed to a stranger reading their blood group
   * *or* looking at their photograph, and splitting the two would have made the
   * photo endpoint the way around the switch.
   */
  const disclosable = Boolean(record?.completedAt) && record?.sharingEnabled !== false;

  return { disclosable, record, residentId, user };
}

/**
 * Everything a hostel admin may know about the person whose card they scanned.
 *
 * `canViewPayments` is decided by the route, which runs the `viewPayments` gate
 * separately from the one that let the caller in — see the route for why that
 * is two checks rather than one.
 */
export async function scanResidentForHostel(
  residentIdInput: string,
  principal: ApiPrincipal,
  options: { canViewPayments?: boolean; hostelId?: string } = {},
): Promise<ResidentScanResult> {
  const { disclosable, record, residentId, user } =
    await findScannedAccount(residentIdInput);

  const { cardRole, cardType } = await resolvePlatformIdCard(user._id.toString());

  const profile = disclosable && record ? readProfile(record) : null;

  const profileNotice = profile
    ? null
    : record?.completedAt
      ? "They have turned profile sharing off. They can switch it back on from their ID card screen."
      : `They have not filled in their ${PLATFORM_NAME} profile, so the card carries nothing but the number.`;

  const scope = scanScope(principal, options.hostelId);

  const membership = scope.length
    ? await loadMembership({
        canViewPayments: Boolean(options.canViewPayments),
        profile,
        scope,
        user,
      })
    : null;

  const membershipNotice = membership
    ? null
    : "They are not on your roll. Register them and the form fills itself in from this card.";

  /*
   * Audited and announced only when the *portable* profile actually changed
   * hands. A scan that found nothing but the hostel's own tenancy record read
   * nothing of theirs, and a notification saying otherwise would teach people
   * to ignore the ones that matter.
   */
  if (profile && record) {
    const hostelId = membership
      ? new Types.ObjectId(membership.hostel.id)
      : (scope[0] ?? undefined);

    /*
     * Read from the row as it was *before* the update below bumps it — which is
     * why this line sits here and not after.
     */
    const repeat =
      Boolean(record.lastSharedAt) &&
      Date.now() - (record.lastSharedAt as Date).getTime() < SCAN_NOTICE_QUIET_MS &&
      String(record.lastSharedWithHostelId ?? "") === String(hostelId ?? "");

    await UserResidentProfileModel.updateOne(
      { _id: record._id },
      {
        $inc: { shareCount: 1 },
        $set: {
          lastSharedAt: new Date(),
          ...(hostelId ? { lastSharedWithHostelId: hostelId } : {}),
        },
      },
    );

    await AuditLogModel.create({
      action: "RESIDENT_PROFILE_SCANNED",
      actorId: principal.userId,
      entityId: residentId,
      entityType: "UserResidentProfile",
      ...(hostelId ? { hostelId } : {}),
      metadata: { residentId, subjectUserId: user._id.toString() },
    });

    if (!repeat) {
      await createInAppNotification({
        body: "A hostel scanned your ID card and read your profile. If that was not you, turn sharing off from your ID card screen.",
        category: "ACCOUNT",
        data: { residentId },
        ...(hostelId ? { hostelId: hostelId.toString() } : {}),
        title: "Your ID card was scanned",
        userId: user._id.toString(),
      }).catch(() => null);
    }
  }

  return {
    account: {
      cardRole,
      cardType,
      email: user.email ?? null,
      hasPhoto: disclosable && Boolean(record?.photoAssetId),
      name: user.name,
      photoUpdatedAt: record?.photoUpdatedAt?.toISOString() ?? null,
    },
    membership,
    membershipNotice,
    profile: profile
      ? { ...profile, age: ageFromDateOfBirth(profile.dateOfBirth) }
      : null,
    profileNotice,
    residentId,
    scannedAt: new Date().toISOString(),
  };
}

/**
 * The hostel's own half of the dossier.
 *
 * ## The account link is the good match, and it is usually missing
 *
 * A resident registered at the desk has no `userId` until the day they redeem
 * an activation code, which for most people is never. Falling back to the phone
 * number and then the email off their platform profile is what makes this work
 * against the roll a hostel actually has. `matchedBy` travels with the result so
 * the screen can be honest about which of the three it used.
 *
 * ## Scoped in the query, never filtered afterwards
 *
 * Every read here is bounded by `scope` — the hostels this principal was
 * narrowed to — or by the resident id that scope already produced. A tenancy in
 * another tenant has to read as "not on your roll", not as a row we then
 * remember to hide.
 */
async function loadMembership({
  canViewPayments,
  profile,
  scope,
  user,
}: {
  canViewPayments: boolean;
  profile: ResidentProfileData | null;
  scope: Types.ObjectId[];
  user: UserRecord;
}): Promise<ResidentScanMembership | null> {
  const base = { hostelId: { $in: scope }, isDeleted: { $ne: true } };

  // Newest tenancy first: somebody who left and came back has two rows, and the
  // current one is the person standing at the door.
  const newestFirst = { createdAt: -1 } as const;

  let matchedBy: ResidentScanMembership["matchedBy"] = "ACCOUNT";

  let resident = await ResidentModel.findOne({ ...base, userId: user._id })
    .sort(newestFirst)
    .lean<ResidentRecord | null>();

  const phone = profile?.primaryPhone?.trim();
  const email = (profile?.primaryEmail ?? user.email ?? "").trim().toLowerCase();

  if (!resident && phone) {
    resident = await ResidentModel.findOne({ ...base, phone })
      .sort(newestFirst)
      .lean<ResidentRecord | null>();

    if (resident) {
      matchedBy = "PHONE";
    }
  }

  if (!resident && email) {
    resident = await ResidentModel.findOne({ ...base, email })
      .sort(newestFirst)
      .lean<ResidentRecord | null>();

    if (resident) {
      matchedBy = "EMAIL";
    }
  }

  if (!resident) {
    return null;
  }

  const residentId = resident._id;
  const { hostelId } = resident;

  const [
    hostel,
    guardians,
    emergencyContacts,
    nightStatus,
    recentComplaints,
    openComplaints,
    totalComplaints,
    ledger,
  ] = await Promise.all([
    HostelModel.findById(hostelId).select("name").lean<{ name?: string } | null>(),
    GuardianModel.find({ residentId })
      .sort({ isPrimary: -1 })
      .lean<
        {
          _id: Types.ObjectId;
          email?: string | null;
          firstName: string;
          isPrimary?: boolean;
          lastName: string;
          phone: string;
          relation: string;
        }[]
      >(),
    EmergencyContactModel.find({ residentId })
      .sort({ isPrimary: -1 })
      .lean<
        {
          _id: Types.ObjectId;
          isPrimary?: boolean;
          name: string;
          phone: string;
          relation: string;
        }[]
      >(),
    NightStatusModel.findOne({ residentId }).lean<{
      checkedAt?: Date;
      note?: string | null;
      source?: string;
      status: string;
    } | null>(),
    ComplaintModel.find({ residentId })
      .sort({ createdAt: -1 })
      .limit(5)
      .select("category createdAt status title")
      .lean<
        {
          _id: Types.ObjectId;
          category?: string;
          createdAt?: Date;
          status: string;
          title: string;
        }[]
      >(),
    ComplaintModel.countDocuments({
      residentId,
      status: { $in: ["PENDING", "IN_PROGRESS"] },
    }),
    ComplaintModel.countDocuments({ residentId }),
    /*
     * Caught rather than awaited bare. This is the one read here that touches
     * finance, and a screen that exists to identify somebody at the door must
     * not go blank because the ledger had a bad moment.
     */
    canViewPayments
      ? getResidentLedger(hostelId, residentId.toString()).catch(() => null)
      : Promise.resolve(null),
  ]);

  return {
    complaints: {
      open: openComplaints,
      recent: recentComplaints.map((complaint) => ({
        category: complaint.category ?? "OTHER",
        createdAt: complaint.createdAt?.toISOString() ?? null,
        id: complaint._id.toString(),
        status: complaint.status,
        title: complaint.title,
      })),
      total: totalComplaints,
    },
    contacts: {
      emergencyContacts: emergencyContacts.map((contact) => ({
        id: contact._id.toString(),
        isPrimary: Boolean(contact.isPrimary),
        name: contact.name,
        phone: contact.phone,
        relation: contact.relation,
      })),
      guardians: guardians.map((guardian) => ({
        email: guardian.email ?? "",
        firstName: guardian.firstName,
        id: guardian._id.toString(),
        isPrimary: Boolean(guardian.isPrimary),
        lastName: guardian.lastName,
        phone: guardian.phone,
        relation: guardian.relation,
      })),
    },
    hostel: { id: hostelId.toString(), name: hostel?.name ?? "This hostel" },
    ledger,
    ledgerDenied: !canViewPayments,
    matchedBy,
    nightStatus: nightStatus
      ? {
          checkedAt: nightStatus.checkedAt?.toISOString() ?? null,
          note: nightStatus.note ?? null,
          source: nightStatus.source ?? "RESIDENT",
          status: nightStatus.status,
        }
      : null,
    resident: {
      createdAt: resident.createdAt?.toISOString() ?? null,
      depositAmount: resident.depositAmount ?? 0,
      email: resident.email ?? null,
      firstName: resident.firstName,
      id: residentId.toString(),
      lastName: resident.lastName,
      monthlyFee: resident.monthlyFee ?? null,
      moveInDate: resident.moveInDate.toISOString(),
      phone: resident.phone,
      residentType: resident.residentType ?? "STUDENT",
      roomType: resident.roomType,
      status: resident.status,
      userId: resident.userId?.toString() ?? null,
    },
  };
}

/**
 * The scanned holder's card photo, streamed through our own origin.
 *
 * Same construction as `readResidentIdentityPhoto` for a different reason: there
 * the proxy kept a `<canvas>` untainted, here it keeps the bearer token
 * attached. A 302 to a presigned R2 URL loses the `Authorization` header on the
 * hop, which is the trap the phone's `identity-api.ts` documents.
 *
 * Gated on the same switch as the profile — a holder who has stopped sharing is
 * not disclosing their face either.
 */
export async function readScannedResidentPhoto(residentIdInput: string) {
  const { disclosable, record } = await findScannedAccount(residentIdInput);

  if (!disclosable || !record?.photoAssetId) {
    throw new ResidentIdentityError(
      "That card has no photo to show.",
      "PHOTO_MISSING",
      404,
    );
  }

  const asset = await FileAssetModel.findOne({
    _id: record.photoAssetId,
    isDeleted: { $ne: true },
    status: "ACTIVE",
  })
    .select("bucket key mimeType")
    .lean<PhotoAssetRecord | null>();

  if (!asset) {
    throw new ResidentIdentityError(
      "That card has no photo to show.",
      "PHOTO_MISSING",
      404,
    );
  }

  try {
    const response = await fetch(await getPresignedReadUrl(asset.bucket, asset.key));

    if (!response.ok || !response.body) {
      throw new Error(`Storage answered ${response.status}`);
    }

    return {
      body: response.body,
      contentType: asset.mimeType || "application/octet-stream",
    };
  } catch {
    throw new ResidentIdentityError(
      "Could not load that photo right now.",
      "PHOTO_UNAVAILABLE",
      502,
    );
  }
}
