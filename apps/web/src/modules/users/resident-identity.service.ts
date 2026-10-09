import { randomInt } from "node:crypto";

import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import {
  decryptPersonalData,
  encryptPersonalData,
  personalLookupHash,
} from "@/lib/personal-data-crypto";
import { getPresignedReadUrl } from "@/lib/r2";
import { siteUrl } from "@/lib/site";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { HostelPageViewModel } from "@hostel/db/models/HostelPageView";
import { InquiryModel } from "@hostel/db/models/Inquiry";
import { ServiceProviderModel } from "@hostel/db/models/ServiceProvider";
import { UserModel } from "@hostel/db/models/User";
import { Role } from "@hostel/shared/types/roles";
import type { PlatformIdCardType } from "@/lib/platform-id-card";
import { UserResidentProfileModel } from "@hostel/db/models/UserResidentProfile";
import { findLiveResidency } from "@/modules/residents/live-residency";
import {
  type ResidentProfileData,
  type residentIdentitySaveSchema,
  residentPhoneKey,
} from "@/modules/users/resident-identity.validation";
import type { z } from "zod";

type ResidentIdentitySaveInput = z.infer<typeof residentIdentitySaveSchema>;

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
  lastSharedAt?: Date;
  photoAssetId?: Types.ObjectId | null;
  photoUpdatedAt?: Date | null;
  shareCount?: number;
  signatureAssetId?: Types.ObjectId | null;
  signatureUpdatedAt?: Date | null;
  sharingEnabled?: boolean;
  updatedAt?: Date;
  userId: Types.ObjectId;
};

export class ResidentIdentityError extends Error {
  constructor(
    message: string,
    public errorCode = "RESIDENT_IDENTITY_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

/**
 * How many hostel detail pages someone browses before we consider them a
 * genuine room-hunter and offer the one-time profile form.
 */
export const PROFILE_PROMPT_VIEW_THRESHOLD = 3;

/*
 * Crockford-style alphabet: no I, L, O, U, 0 or 1, because this id gets read
 * off a phone screen and typed into a warden's laptop by hand.
 */
const ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_BLOCK_LENGTH = 4;

function randomIdBlock() {
  let block = "";

  for (let index = 0; index < ID_BLOCK_LENGTH; index += 1) {
    block += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  }

  return block;
}

function generateResidentId() {
  return `HH-${randomIdBlock()}-${randomIdBlock()}`;
}

/** Strips formatting so `hh 4k7m-9xq2` and a scanned URL both resolve. */
export function normalizeResidentId(value: string) {
  // Drop any query/hash first — otherwise `/resident-id/HH-…?utm=qr` would
  // resolve to the tracking parameter instead of the id.
  const path = value.trim().split(/[?#]/)[0] ?? "";
  const tail = path.split("/").filter(Boolean).pop() ?? path;
  const compact = tail.toUpperCase().replace(/[^A-Z0-9]/g, "");

  if (!/^HH[A-Z0-9]{8}$/.test(compact)) {
    return null;
  }

  return `HH-${compact.slice(2, 6)}-${compact.slice(6, 10)}`;
}

export function residentIdShareUrl(residentId: string) {
  return `${siteUrl()}/resident-id/${encodeURIComponent(residentId)}`;
}

async function mintResidentId(userId: string) {
  // Collisions are vanishingly unlikely (30^8) but the unique index is the real
  // guard; retry a few times rather than failing the user's first save.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate = generateResidentId();
    const taken = await UserModel.exists({ userResidentId: candidate });

    if (taken) {
      continue;
    }

    const updated = await UserModel.findOneAndUpdate(
      { _id: userId, userResidentId: { $in: [null, ""] } },
      { $set: { userResidentId: candidate } },
      { new: true },
    ).lean<UserRecord | null>();

    // Another concurrent save won the race and already set one — use theirs.
    if (updated?.userResidentId) {
      return updated.userResidentId;
    }

    const current = await UserModel.findById(userId)
      .select("userResidentId")
      .lean<UserRecord | null>();

    if (current?.userResidentId) {
      return current.userResidentId;
    }
  }

  throw new ResidentIdentityError(
    "Could not allocate a resident ID. Please try again.",
    "RESIDENT_ID_ALLOCATION_FAILED",
    500,
  );
}

export function ageFromDateOfBirth(dateOfBirth?: string) {
  if (!dateOfBirth) {
    return null;
  }

  const born = new Date(dateOfBirth);

  if (Number.isNaN(born.getTime())) {
    return null;
  }

  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const monthDelta = now.getMonth() - born.getMonth();

  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < born.getDate())) {
    age -= 1;
  }

  return age >= 0 && age < 130 ? age : null;
}

/**
 * The stored blob, decrypted.
 *
 * Exported for `resident-scan.service.ts`, which reads the same profile under a
 * different question and must not grow a second copy of the crypto call.
 */
export function readProfile(record: {
  encryptedData: string;
}) {
  return decryptPersonalData<ResidentProfileData>(record.encryptedData);
}

async function renderQrDataUrl(text: string) {
  try {
    const { toDataURL } = await import("qrcode");

    return await toDataURL(text, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 420,
    });
  } catch {
    // The modal still shows the typed id, which is the manual-entry path.
    return null;
  }
}

/**
 * Which variant of the platform ID card this account holds.
 *
 * Derived, never stored: the card follows whatever the platform has already
 * approved the person for, so an owner approval or a provider approval converts
 * the card by itself and there is no second copy of that fact to fall out of
 * step. Hostel admin wins over provider — running a hostel is the stronger
 * identity to be carrying at the door.
 */
export async function resolvePlatformIdCard(userId: string): Promise<{
  cardType: PlatformIdCardType;
  /**
   * The line printed under the holder's name. `null` for a resident, whose
   * role comes from their own profile (course, institution or occupation) and
   * is better known to the client that already has it.
   */
  cardRole: string | null;
}> {
  const objectId = normalizeUserId(userId);

  const user = await UserModel.findById(objectId).select("role").lean<{
    role?: string;
  } | null>();

  if (user?.role === Role.HOSTEL_ADMIN) {
    return { cardRole: "Hostel Owner", cardType: "HOSTEL_OWNER" };
  }

  const provider = await ServiceProviderModel.findOne({
    isDeleted: false,
    status: "APPROVED",
    userId: objectId,
  })
    .select("category")
    .lean<{ category?: string } | null>();

  if (!provider) {
    return { cardRole: null, cardType: "RESIDENT" };
  }

  // Their trade is what a hostel actually wants to read off the card —
  // "Electrician", not the generic "Service Provider".
  return {
    cardRole: provider.category ? titleCaseCategory(provider.category) : "Service Provider",
    cardType: "SERVICE_PROVIDER",
  };
}

/** `SERVICE_PROVIDER`-style constants into something printable. */
function titleCaseCategory(category: string) {
  return category
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export async function getResidentIdentity(userId: string) {
  await connectToDatabase();

  const user = await UserModel.findOne({ _id: userId, isDeleted: { $ne: true } })
    .select("email name userResidentId")
    .lean<UserRecord | null>();

  if (!user) {
    throw new ResidentIdentityError("User was not found.", "USER_NOT_FOUND", 404);
  }

  const record = await UserResidentProfileModel.findOne({
    isDeleted: { $ne: true },
    userId: user._id,
  }).lean<ProfileRecord | null>();

  const profile = record ? readProfile(record) : null;

  return {
    identity: {
      accountEmail: user.email ?? null,
      accountName: user.name,
      ...(await resolvePlatformIdCard(userId)),
      hasPhoto: Boolean(record?.photoAssetId),
      hasProfile: Boolean(record?.completedAt),
      lastSharedAt: record?.lastSharedAt?.toISOString() ?? null,
      // The ID card reads this straight into the photo URL's query string, so a
      // freshly uploaded photo is never served from the browser's cache.
      photoUpdatedAt: record?.photoUpdatedAt?.toISOString() ?? null,
      residentId: user.userResidentId ?? null,
      shareCount: record?.shareCount ?? 0,
      shareUrl: user.userResidentId ? residentIdShareUrl(user.userResidentId) : null,
      sharingEnabled: record?.sharingEnabled ?? true,
      /*
       * Whether the back of the card is signed with a photograph rather than
       * with the strokes in `profile.signature`. The bytes are not here: they
       * are streamed by `/users/resident-identity/signature`, same-origin, for
       * the same reason the photo is — a canvas that draws a cross-origin image
       * is tainted and cannot be exported. The timestamp is the cache key, so
       * re-signing never shows the previous signature.
       */
      hasSignatureImage: Boolean(record?.signatureAssetId),
      signatureUpdatedAt: record?.signatureUpdatedAt?.toISOString() ?? null,
      updatedAt: record?.updatedAt?.toISOString() ?? null,
    },
    profile: profile
      ? { ...profile, age: ageFromDateOfBirth(profile.dateOfBirth) }
      : null,
  };
}

export async function getResidentIdentityQr(userId: string) {
  const { identity } = await getResidentIdentity(userId);

  if (!identity.residentId || !identity.shareUrl) {
    throw new ResidentIdentityError(
      "Save your resident profile first to get a QR code.",
      "RESIDENT_PROFILE_MISSING",
      404,
    );
  }

  return {
    qrDataUrl: await renderQrDataUrl(identity.shareUrl),
    residentId: identity.residentId,
    shareUrl: identity.shareUrl,
  };
}

export type ResidentEmailStatus = "AVAILABLE" | "TAKEN" | "YOURS";
export type ResidentPhoneStatus = ResidentEmailStatus;

/**
 * Whether an address is free to go on this account's card.
 *
 * TAKEN when it is another account's sign-in email, or another card's primary
 * email — the second found through the blind index, since the profile itself
 * is encrypted and cannot be searched.
 */
async function residentEmailStatus(
  userId: Types.ObjectId,
  email: string,
): Promise<ResidentEmailStatus> {
  const normalized = email.trim().toLowerCase();
  const [account, card] = await Promise.all([
    UserModel.findOne({ email: normalized, isDeleted: { $ne: true } })
      .select("_id")
      .lean<{ _id: Types.ObjectId } | null>(),
    UserResidentProfileModel.exists({
      isDeleted: { $ne: true },
      primaryEmailHash: personalLookupHash(normalized),
      userId: { $ne: userId },
    }),
  ]);

  if (account && !account._id.equals(userId)) {
    return "TAKEN";
  }

  if (card) {
    return "TAKEN";
  }

  return account ? "YOURS" : "AVAILABLE";
}

export async function checkResidentEmail(userId: string, email: string) {
  await connectToDatabase();

  return { email, status: await residentEmailStatus(normalizeUserId(userId), email) };
}

/** The card's blind index for a main phone. Namespaced so it can never equal an email's. */
function residentPhoneHash(phone: string) {
  return personalLookupHash(`phone:${residentPhoneKey(phone)}`);
}

/**
 * The ways `User.phone` holds one number: bare, and with Nepal's code in the
 * forms people type it. Exact matches keep the lookup on the phone index.
 * ponytail: a spelling not listed here (dots, brackets) is missed until the
 * account phones are stored normalised.
 */
function accountPhoneSpellings(phone: string) {
  const key = residentPhoneKey(phone);

  return [
    ...new Set([
      phone.trim(),
      key,
      `+${key}`,
      `+977${key}`,
      `977${key}`,
      `+977 ${key}`,
      `+977-${key}`,
    ]),
  ];
}

/**
 * Whether a number is free to be this card's main phone — the email rule, for
 * phones. TAKEN when another account signs in with it or another card lists it
 * (by blind index, since the profile is encrypted); YOURS when it is this
 * account's own phone.
 */
async function residentPhoneStatus(
  userId: Types.ObjectId,
  phone: string,
): Promise<ResidentPhoneStatus> {
  const [accounts, card] = await Promise.all([
    UserModel.find({ isDeleted: { $ne: true }, phone: { $in: accountPhoneSpellings(phone) } })
      .select("_id")
      .limit(2)
      .lean<{ _id: Types.ObjectId }[]>(),
    UserResidentProfileModel.exists({
      isDeleted: { $ne: true },
      primaryPhoneHash: residentPhoneHash(phone),
      userId: { $ne: userId },
    }),
  ]);

  if (card || accounts.some((account) => !account._id.equals(userId))) {
    return "TAKEN";
  }

  return accounts.length > 0 ? "YOURS" : "AVAILABLE";
}

export async function checkResidentPhone(userId: string, phone: string) {
  await connectToDatabase();

  return { phone, status: await residentPhoneStatus(normalizeUserId(userId), phone) };
}

export async function saveResidentIdentity(
  userId: string,
  input: ResidentIdentitySaveInput,
) {
  await connectToDatabase();

  const user = await UserModel.findOne({ _id: userId, isDeleted: { $ne: true } })
    .select("email name userResidentId")
    .lean<UserRecord | null>();

  if (!user) {
    throw new ResidentIdentityError("User was not found.", "USER_NOT_FOUND", 404);
  }

  /*
   * The card's email is the sign-in email whenever the account has one. The
   * clients show it read-only, but that was only ever a client promise — a
   * direct PUT could put somebody else's address on a card. Now the server
   * decides, and only an account with no email of its own may type one, which
   * then has to be free.
   */
  const profile: ResidentProfileData = user.email
    ? { ...input.profile, primaryEmail: user.email.toLowerCase() }
    : input.profile;

  if (
    profile.backupEmail &&
    profile.backupEmail.toLowerCase() === profile.primaryEmail.toLowerCase()
  ) {
    throw new ResidentIdentityError(
      "The backup email must be different from your account email.",
      "RESIDENT_BACKUP_EMAIL_SAME",
      422,
    );
  }

  if (
    !user.email &&
    (await residentEmailStatus(user._id, profile.primaryEmail)) === "TAKEN"
  ) {
    throw new ResidentIdentityError(
      "That email is already used by another account. Use a different one.",
      "RESIDENT_EMAIL_TAKEN",
      409,
    );
  }

  // Only the *first* completed save mints a card; later edits are just edits and
  // must not re-send the card email every time someone fixes a typo.
  const existing = await UserResidentProfileModel.findOne({
    isDeleted: { $ne: true },
    userId: user._id,
  })
    .select("completedAt photoAssetId primaryPhoneHash signatureAssetId")
    .lean<{
      completedAt?: Date;
      photoAssetId?: Types.ObjectId | null;
      primaryPhoneHash?: string | null;
      signatureAssetId?: Types.ObjectId | null;
    } | null>();
  const isFirstCard = !existing?.completedAt;
  const phoneHash = residentPhoneHash(profile.primaryPhone);

  /*
   * The phone gets the email's rule, checked when it is set or changed: a card
   * already saved with a number stays editable even if someone else has since
   * used it, rather than being refused over a field its holder did not touch.
   */
  if (
    existing?.primaryPhoneHash !== phoneHash &&
    (await residentPhoneStatus(user._id, profile.primaryPhone)) === "TAKEN"
  ) {
    throw new ResidentIdentityError(
      "That phone number is already used by another account. Use your own number.",
      "RESIDENT_PHONE_TAKEN",
      409,
    );
  }

  // Checked before the id is minted, so a refused save leaves no half-card.
  const photo = input.photoAssetId
    ? await loadOwnedImageAsset(user._id, input.photoAssetId, "photo")
    : null;

  if (!photo && !existing?.photoAssetId) {
    throw new ResidentIdentityError(
      "Add a photo of yourself — it goes on the front of your card.",
      "PHOTO_REQUIRED",
      422,
    );
  }

  const signatureImage = input.signatureAssetId
    ? await loadOwnedImageAsset(user._id, input.signatureAssetId, "signature")
    : null;

  /*
   * A signature can be drawn on the screen or photographed off paper, and the
   * card has room for exactly one. The rule cannot live in the schema: the
   * strokes ride inside the encrypted profile, the photograph is a handle on
   * the envelope, and whether the *record* already carries one is a third fact
   * neither of them can see. So all three are weighed here.
   */
  const hasNewSignature = Boolean(profile.signature || signatureImage);

  /*
   * Only the photographed one has a "still there from last time" state. Drawn
   * strokes live inside `encryptedData`, which every save rewrites whole, so a
   * client that edits a profile and omits them is asking for them to be gone —
   * the edit screen resends what it was given for exactly this reason.
   */
  if (!hasNewSignature && !existing?.signatureAssetId) {
    throw new ResidentIdentityError(
      "Sign your card — draw it on the screen or photograph your signature on paper.",
      "SIGNATURE_REQUIRED",
      422,
    );
  }

  const residentId = user.userResidentId || (await mintResidentId(userId));
  const photoUpdatedAt = new Date();

  await UserResidentProfileModel.findOneAndUpdate(
    { userId: user._id },
    {
      $set: {
        completedAt: new Date(),
        encryptedData: encryptPersonalData(profile),
        isDeleted: false,
        payloadVersion: 1,
        primaryEmailHash: personalLookupHash(profile.primaryEmail),
        primaryPhoneHash: phoneHash,
        sharingEnabled: input.sharingEnabled,
        updatedBy: user._id,
        ...(photo ? { photoAssetId: photo._id, photoUpdatedAt } : {}),
        ...(signatureImage
          ? { signatureAssetId: signatureImage._id, signatureUpdatedAt: photoUpdatedAt }
          : {}),
      },
      /*
       * Switching from a photographed signature back to a drawn one has to
       * *remove* the handle, not merely stop writing it. Left in place, the
       * card painter would find both and the back of the card would show
       * whichever the drawing order happened to favour — a signature the holder
       * had already replaced.
       */
      ...(profile.signature
        ? { $unset: { signatureAssetId: "", signatureUpdatedAt: "" } }
        : {}),
      $setOnInsert: { createdBy: user._id },
    },
    { new: true, upsert: true },
  );

  if (photo) {
    await syncAvatarWithCardPhoto(user._id, { version: photoUpdatedAt });
  }

  await AuditLogModel.create({
    action: "RESIDENT_PROFILE_SAVED",
    actorId: user._id,
    entityId: residentId,
    entityType: "UserResidentProfile",
    metadata: { sharingEnabled: input.sharingEnabled },
  });

  if (isFirstCard) {
    // Imported here rather than at module scope: the delivery service reads
    // this one back to build the card, and a static import would be a cycle.
    const { sendIdCardEmail } = await import("@/modules/users/id-card-delivery.service");

    await sendIdCardEmail(userId, "RESIDENT");
  }

  return getResidentIdentity(userId);
}

export async function setResidentIdentitySharing(userId: string, enabled: boolean) {
  await connectToDatabase();

  const updated = await UserResidentProfileModel.findOneAndUpdate(
    { isDeleted: { $ne: true }, userId: normalizeUserId(userId) },
    { $set: { sharingEnabled: enabled } },
    { new: true },
  ).lean<ProfileRecord | null>();

  if (!updated) {
    throw new ResidentIdentityError(
      "You have not saved a resident profile yet.",
      "RESIDENT_PROFILE_MISSING",
      404,
    );
  }

  return getResidentIdentity(userId);
}

function normalizeUserId(value: string) {
  if (!Types.ObjectId.isValid(value)) {
    throw new ResidentIdentityError("Invalid user id.", "INVALID_OBJECT_ID", 422);
  }

  return new Types.ObjectId(value);
}

/* ── ID-card photo ── */

type PhotoAssetRecord = {
  _id: Types.ObjectId;
  /** Which bucket the object is in — rows predate the public/private split. */
  bucket: string;
  key: string;
  mimeType: string;
  ownerId?: Types.ObjectId | null;
};

/**
 * The avatar URL is **per user**, not per session.
 *
 * `User.image` is read by everybody: the account's own header, and every screen
 * that draws somebody else — a resident row, a community post, a roster. The
 * first version of this pointed at `/users/resident-identity/photo`, which
 * serves *the caller's own* face and carries no id, so a reader looking at a
 * list of ten residents was served their own photograph ten times, or a 404 if
 * they had none. One id in the path is what makes an avatar somebody's.
 *
 * The legacy path is still recognised so a row written by that version is still
 * understood to be *ours* — the sync below must stay free to replace it, and
 * `scripts/backfill-card-avatars.ts` rewrites the stored value.
 */
const LEGACY_SELF_PHOTO_PATH = "/api/v1/users/resident-identity/photo";
const ACCOUNT_AVATAR_PATH = /^\/api\/v1\/users\/[0-9a-fA-F]{24}\/avatar(?:\?|$)/;

/** The version query is what makes a replaced photo bypass the browser cache. */
export function cardPhotoImageUrl(userId: Types.ObjectId | string, version: Date) {
  return `/api/v1/users/${userId.toString()}/avatar?v=${version.getTime()}`;
}

/** Whether an avatar is one we set from a card photo, rather than the user's own. */
export function isCardPhotoImage(value?: string | null) {
  return (
    typeof value === "string" &&
    (value.startsWith(LEGACY_SELF_PHOTO_PATH) || ACCOUNT_AVATAR_PATH.test(value))
  );
}

/**
 * Keeps the account avatar in step with the card photo.
 *
 * Only fills an empty avatar, or replaces one this same feature set earlier — a
 * picture that came from somewhere else (a Google sign-in, say) is the user's
 * and is not ours to overwrite.
 */
async function syncAvatarWithCardPhoto(
  userId: Types.ObjectId,
  photo: { version: Date } | null,
) {
  const current = await UserModel.findById(userId)
    .select("image")
    .lean<{ image?: string | null } | null>();

  if (current?.image && !isCardPhotoImage(current.image)) {
    return;
  }

  await UserModel.updateOne(
    { _id: userId },
    { $set: { image: photo ? cardPhotoImageUrl(userId, photo.version) : null } },
  );
}

/**
 * Attaches an already-uploaded image to the resident's ID card.
 *
 * The asset id arrives from the browser, so ownership is re-checked here rather
 * than taken on trust — otherwise anyone could point their card at somebody
 * else's private upload and then read it back through the photo proxy below.
 */
/**
 * The three questions worth asking about any image handed in by id: does it
 * exist, does it belong to the caller, and is it actually an image.
 *
 * Written once and parameterised by `kind` because the card now takes two
 * uploads — the holder's face, and a signature photographed off paper — and
 * both are attached the same way: bytes go to R2 through the universal
 * uploader, and only the FileAsset id reaches this service. An id from a
 * request is a claim about ownership, never proof of it, so the check has to
 * happen server-side on every path that accepts one. Duplicating it per field
 * is how one of them eventually ends up missing a clause.
 *
 * Error codes stay per-kind so a client can tell the user which upload went
 * wrong rather than saying "an image" and leaving them to guess.
 */
const ASSET_KINDS = {
  photo: {
    forbidden: "PHOTO_FORBIDDEN",
    notAnImage: "PHOTO_NOT_AN_IMAGE",
    notFound: "PHOTO_NOT_FOUND",
    notFoundMessage: "That upload could not be found. Please pick the photo again.",
    notImageMessage: "Your ID card photo has to be an image.",
  },
  signature: {
    forbidden: "SIGNATURE_FORBIDDEN",
    notAnImage: "SIGNATURE_NOT_AN_IMAGE",
    notFound: "SIGNATURE_NOT_FOUND",
    notFoundMessage:
      "That signature upload could not be found. Photograph your signature again.",
    notImageMessage: "Your signature has to be a photo.",
  },
} as const;

async function loadOwnedImageAsset(
  owner: Types.ObjectId,
  assetId: string,
  kind: keyof typeof ASSET_KINDS,
) {
  const messages = ASSET_KINDS[kind];
  const asset = await FileAssetModel.findOne({
    _id: assetId,
    isDeleted: { $ne: true },
    status: "ACTIVE",
  })
    .select("bucket key mimeType ownerId")
    .lean<PhotoAssetRecord | null>();

  if (!asset) {
    throw new ResidentIdentityError(messages.notFoundMessage, messages.notFound, 404);
  }

  if (!asset.ownerId || asset.ownerId.toString() !== owner.toString()) {
    throw new ResidentIdentityError(
      "That upload does not belong to you.",
      messages.forbidden,
      403,
    );
  }

  if (!asset.mimeType?.startsWith("image/")) {
    throw new ResidentIdentityError(messages.notImageMessage, messages.notAnImage, 422);
  }

  return asset;
}

export async function setResidentIdentityPhoto(userId: string, photoAssetId: string) {
  await connectToDatabase();

  const owner = normalizeUserId(userId);
  const asset = await loadOwnedImageAsset(owner, photoAssetId, "photo");
  const photoUpdatedAt = new Date();
  const updated = await UserResidentProfileModel.findOneAndUpdate(
    { isDeleted: { $ne: true }, userId: owner },
    { $set: { photoAssetId: asset._id, photoUpdatedAt } },
    { new: true },
  ).lean<ProfileRecord | null>();

  if (!updated) {
    throw new ResidentIdentityError(
      "Save your resident details first, then add a photo.",
      "RESIDENT_PROFILE_MISSING",
      404,
    );
  }

  /*
   * Mongoose keeps a compiled schema per process, so a `$set` of a field the
   * running model does not know about is dropped in silence. That produced a
   * photo that uploaded fine and then never appeared — fail loudly instead.
   */
  if (!updated.photoAssetId) {
    throw new ResidentIdentityError(
      "The photo could not be saved. Restart the server so the profile schema reloads.",
      "PHOTO_NOT_PERSISTED",
      500,
    );
  }

  await syncAvatarWithCardPhoto(owner, { version: photoUpdatedAt });

  return getResidentIdentity(userId);
}

export async function clearResidentIdentityPhoto(userId: string) {
  await connectToDatabase();

  const owner = normalizeUserId(userId);
  const updated = await UserResidentProfileModel.findOneAndUpdate(
    { isDeleted: { $ne: true }, userId: owner },
    { $unset: { photoAssetId: "", photoUpdatedAt: "" } },
    { new: true },
  ).lean<ProfileRecord | null>();

  if (updated) {
    await syncAvatarWithCardPhoto(owner, null);
  }

  if (!updated) {
    throw new ResidentIdentityError(
      "You have not saved a resident profile yet.",
      "RESIDENT_PROFILE_MISSING",
      404,
    );
  }

  return getResidentIdentity(userId);
}

/**
 * The stored object behind a profile's `photoAssetId`, as bytes.
 *
 * The messages are the callers' only disagreement: one is showing you your own
 * face, the other somebody else's, and "please upload it again" is nonsense
 * advice to give a warden.
 */
async function streamCardPhoto(
  photoAssetId: Types.ObjectId,
  messages: { missing: string; unavailable: string },
) {
  const asset = await FileAssetModel.findOne({
    _id: photoAssetId,
    isDeleted: { $ne: true },
    status: "ACTIVE",
  })
    .select("bucket key mimeType")
    .lean<PhotoAssetRecord | null>();

  if (!asset) {
    throw new ResidentIdentityError(messages.missing, "PHOTO_MISSING", 404);
  }

  // Covers both "R2 is not configured" and "R2 is having a bad day": either way
  // the card falls back to initials rather than failing to render at all.
  try {
    // The bucket comes off the asset, not the environment: rows written before
    // the public/private split still name the bucket they were stored in.
    const response = await fetch(await getPresignedReadUrl(asset.bucket, asset.key));

    if (!response.ok || !response.body) {
      throw new Error(`Storage answered ${response.status}`);
    }

    return {
      body: response.body,
      contentType: asset.mimeType || "application/octet-stream",
    };
  } catch {
    throw new ResidentIdentityError(messages.unavailable, "PHOTO_UNAVAILABLE", 502);
  }
}

/**
 * Streams the owner's own card photo back through our origin.
 *
 * Redirecting to a presigned R2 URL would be cheaper, but the ID card is drawn
 * on a `<canvas>` the user then downloads, and a cross-origin image taints that
 * canvas so `toBlob()` throws. Proxying keeps the image same-origin while the
 * bucket itself stays private.
 */
export async function readResidentIdentityPhoto(userId: string) {
  await connectToDatabase();

  const record = await UserResidentProfileModel.findOne({
    isDeleted: { $ne: true },
    userId: normalizeUserId(userId),
  })
    .select("photoAssetId")
    .lean<ProfileRecord | null>();

  if (!record?.photoAssetId) {
    throw new ResidentIdentityError(
      "You have not added a photo yet.",
      "PHOTO_MISSING",
      404,
    );
  }

  return streamCardPhoto(record.photoAssetId, {
    missing: "Your photo is no longer available. Please upload it again.",
    unavailable: "Could not load your photo right now.",
  });
}

/**
 * The photographed signature, for the holder themselves.
 *
 * Same shape and the same reasoning as {@link readResidentIdentityPhoto}: no id
 * in the path, so it can only ever answer with the caller's own, and the bytes
 * come back through our origin rather than as a redirect to R2 so the card
 * canvas can draw them and still be exported.
 *
 * This is the one asset on the card that a hostel is never shown. The scan
 * endpoints hand over a face and a set of details so a warden can fill a
 * registration form; a signature is the part of the document that authorises
 * things, and there is no registration step that needs it.
 */
export async function readResidentIdentitySignature(userId: string) {
  await connectToDatabase();

  const record = await UserResidentProfileModel.findOne({
    isDeleted: { $ne: true },
    userId: normalizeUserId(userId),
  })
    .select("signatureAssetId")
    .lean<ProfileRecord | null>();

  if (!record?.signatureAssetId) {
    throw new ResidentIdentityError(
      "You have not photographed a signature.",
      "SIGNATURE_MISSING",
      404,
    );
  }

  return streamCardPhoto(record.signatureAssetId, {
    missing: "Your signature is no longer available. Photograph it again.",
    unavailable: "Could not load your signature right now.",
  });
}

/**
 * One account's avatar, for anybody signed in who is looking at them.
 *
 * ## What this may serve, and what decides it
 *
 * Only the photo an account is **presenting as its avatar**: `User.image` has
 * to be one of ours, written by {@link syncAvatarWithCardPhoto} when the owner
 * put that photo on their card. Somebody who has replaced their avatar since,
 * or whose card photo is gone, is not served here. So the answer to "may I see
 * this face" is that account's own `image` field — the same field every avatar
 * in the product already reads, which is what keeps the two from disagreeing.
 *
 * ## Why it is not gated the way the corridor scan is
 *
 * `readScannedResidentPhoto` is stricter: it stops at the profile sharing
 * switch, because that route answers *disclose this stranger's dossier to a
 * hostel*, and the face is part of that dossier. This one answers what the
 * product has always answered — draw the profile picture of somebody whose name
 * is already on the screen. Turning ID sharing off withdraws your details from
 * hostels that scan you; it does not blank your picture in the app you are
 * signed in to. Neither route takes an asset id, so neither can be walked
 * across the bucket.
 */
export async function readAccountAvatarPhoto(userIdInput: string) {
  await connectToDatabase();

  const userId = normalizeUserId(userIdInput);
  const user = await UserModel.findOne({ _id: userId, isDeleted: { $ne: true } })
    .select("image")
    .lean<{ image?: string | null } | null>();

  if (!user || !isCardPhotoImage(user.image)) {
    throw new ResidentIdentityError("That account has no photo.", "PHOTO_MISSING", 404);
  }

  const record = await UserResidentProfileModel.findOne({
    isDeleted: { $ne: true },
    userId,
  })
    .select("photoAssetId")
    .lean<ProfileRecord | null>();

  if (!record?.photoAssetId) {
    throw new ResidentIdentityError("That account has no photo.", "PHOTO_MISSING", 404);
  }

  return streamCardPhoto(record.photoAssetId, {
    missing: "That photo is no longer available.",
    unavailable: "Could not load that photo right now.",
  });
}

/** Guardian is stored as one name but persisted as first + last. */
function splitName(value: string) {
  const parts = value.split(/\s+/).filter(Boolean);

  return {
    firstName: parts[0] ?? value,
    lastName: parts.slice(1).join(" ") || parts[0] || value,
  };
}

/**
 * Turns a saved profile into exactly the fields the hostel-admin "Register New
 * Resident" form needs, so the warden reviews prefilled inputs instead of
 * transcribing them.
 */
function toResidentPrefill(profile: ResidentProfileData) {
  const [firstName, ...restName] = profile.fullName.split(/\s+/).filter(Boolean);
  const guardians = [
    {
      email: profile.guardianEmail,
      ...splitName(profile.guardianName),
      isPrimary: true,
      phone: profile.guardianPhone,
      relation: profile.guardianRelation,
    },
  ];

  if (profile.secondGuardianName && profile.secondGuardianPhone) {
    guardians.push({
      email: profile.secondGuardianEmail,
      ...splitName(profile.secondGuardianName),
      isPrimary: false,
      phone: profile.secondGuardianPhone,
      relation: profile.secondGuardianRelation ?? "Guardian",
    });
  }

  const emergencyContact =
    profile.emergencyContactName && profile.emergencyContactPhone
      ? {
          isPrimary: true,
          name: profile.emergencyContactName,
          phone: profile.emergencyContactPhone,
          relation: profile.emergencyContactRelation ?? "Emergency contact",
        }
      : {
          isPrimary: true,
          name: profile.guardianName,
          phone: profile.guardianPhone,
          relation: profile.guardianRelation,
        };

  return {
    emergencyContact,
    guardians,
    resident: {
      email: profile.primaryEmail,
      firstName: firstName ?? profile.fullName,
      lastName: restName.join(" ") || firstName || profile.fullName,
      phone: profile.primaryPhone,
      residentType: profile.occupation,
    },
    details: {
      age: ageFromDateOfBirth(profile.dateOfBirth),
      alternatePhone: profile.alternatePhone ?? null,
      backupEmail: profile.backupEmail ?? null,
      bloodGroup: profile.bloodGroup,
      budgetRange: profile.budgetRange ?? null,
      city: profile.city ?? null,
      courseOrDesignation: profile.courseOrDesignation ?? null,
      dateOfBirth: profile.dateOfBirth ?? null,
      dietaryPreference: profile.dietaryPreference,
      gender: profile.gender,
      governmentIdNumber: profile.governmentIdNumber ?? null,
      governmentIdType: profile.governmentIdType ?? null,
      institution: profile.institution ?? null,
      interests: profile.interests,
      medicalNotes: profile.medicalNotes ?? null,
      permanentAddress: profile.permanentAddress ?? null,
      province: profile.province ?? null,
    },
  };
}

/**
 * Staff-only. Every successful read is audited and the owner is notified in-app,
 * because handing a hostel someone's guardian numbers and blood group should
 * never be silent.
 */
export async function lookupResidentProfile(
  residentIdInput: string,
  principal: ApiPrincipal,
  hostelId?: string,
) {
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
      "No resident profile matches that ID.",
      "RESIDENT_PROFILE_NOT_FOUND",
      404,
    );
  }

  /*
   * The ID is the same string whatever card the holder carries — approval
   * re-skins the card, it does not mint a new number. So the card *type* is the
   * only thing standing between a provider's card and being registered as a
   * resident of the hostel they came to fix a tap in. Checked here because this
   * is the one path both the QR scan and manual entry go through.
   */
  const { cardType } = await resolvePlatformIdCard(user._id.toString());

  if (cardType !== "RESIDENT") {
    throw new ResidentIdentityError(
      cardType === "SERVICE_PROVIDER"
        ? "That is a service provider ID card, not a resident one. It cannot be used to register a resident."
        : "That is a hostel owner ID card, not a resident one. It cannot be used to register a resident.",
      "ID_CARD_NOT_A_RESIDENT",
      409,
    );
  }

  const record = await UserResidentProfileModel.findOne({
    isDeleted: { $ne: true },
    userId: user._id,
  }).lean<ProfileRecord | null>();

  if (!record?.completedAt) {
    throw new ResidentIdentityError(
      "That resident has not finished their profile yet.",
      "RESIDENT_PROFILE_INCOMPLETE",
      404,
    );
  }

  if (record.sharingEnabled === false) {
    throw new ResidentIdentityError(
      "That resident has turned off profile sharing.",
      "RESIDENT_PROFILE_SHARING_DISABLED",
      403,
    );
  }

  const scopedHostelId =
    hostelId && Types.ObjectId.isValid(hostelId)
      ? new Types.ObjectId(hostelId)
      : principal.hostelIds.find((id) => Types.ObjectId.isValid(id))
        ? new Types.ObjectId(principal.hostelIds[0])
        : undefined;

  await UserResidentProfileModel.updateOne(
    { _id: record._id },
    {
      $inc: { shareCount: 1 },
      $set: {
        lastSharedAt: new Date(),
        ...(scopedHostelId ? { lastSharedWithHostelId: scopedHostelId } : {}),
      },
    },
  );

  await AuditLogModel.create({
    action: "RESIDENT_PROFILE_SHARED",
    actorId: principal.userId,
    entityId: residentId,
    entityType: "UserResidentProfile",
    ...(scopedHostelId ? { hostelId: scopedHostelId } : {}),
    metadata: { residentId, subjectUserId: user._id.toString() },
  });

  await createInAppNotification({
    body: "A hostel used your resident ID to fill in your details. If this was not you, turn off sharing from your profile menu.",
    category: "ACCOUNT",
    data: { residentId },
    ...(scopedHostelId ? { hostelId: scopedHostelId.toString() } : {}),
    title: "Your resident profile was shared",
    userId: user._id.toString(),
  }).catch(() => null);

  const profile = readProfile(record);

  /*
   * Whether they already live somewhere — this hostel or any other — asked
   * now, while the warden is still looking at who they scanned, rather than
   * after they have picked a bed. Both the sign-in address and the profile's
   * own address are tried: a hostel that registered them by hand holds the
   * second, with no account on the row at all.
   *
   * Returned, not thrown. The details still load, because the warden is
   * entitled to see who is standing in front of them; `createResident` is what
   * actually refuses.
   */
  const occupancy = await findLiveResidency(
    { emails: [user.email, profile.primaryEmail], userIds: [user._id] },
    scopedHostelId,
  );

  return {
    occupancy,
    /*
     * Not the photo, and not a URL to it: the bytes are streamed by
     * `/hostel-admin/resident-scan/photo`, which takes the same resident ID and
     * the same `registerResidents` grant. All the caller is missing is whether
     * there is a face to ask for and which version of it — without those a
     * registration screen either draws a broken image for the majority who
     * never uploaded one, or shows a replaced portrait's predecessor out of a
     * disk cache keyed on the URL.
     */
    photo: {
      hasPhoto: Boolean(record.photoAssetId),
      updatedAt: record.photoUpdatedAt?.toISOString() ?? null,
    },
    prefill: toResidentPrefill(profile),
    residentId,
    sharedAt: new Date().toISOString(),
  };
}

/**
 * Decides whether to interrupt a visitor with the one-time profile form. We ask
 * after they commit (an inquiry) or after they have clearly been shopping
 * around ({@link PROFILE_PROMPT_VIEW_THRESHOLD} hostel pages) — never on a first
 * visit, and never once a profile exists.
 */
export async function evaluateProfilePrompt(options: {
  userId?: string;
  visitorKey: string;
}) {
  await connectToDatabase();

  if (options.userId) {
    const existing = await UserResidentProfileModel.findOne({
      completedAt: { $ne: null },
      isDeleted: { $ne: true },
      userId: normalizeUserId(options.userId),
    })
      .select("_id")
      .lean<{ _id: Types.ObjectId } | null>();

    if (existing) {
      return { reason: null, shouldCollectProfile: false, viewedHostels: 0, views: 0 };
    }
  }

  const viewFilter = options.userId
    ? { userId: normalizeUserId(options.userId) }
    : { visitorKey: options.visitorKey };

  // Total visits, not distinct hostels: coming back to the same hostel three
  // times is as strong a buying signal as looking at three different ones, and
  // a small catalogue would otherwise never reach the threshold. The rows are
  // already de-duplicated per 30-minute window, so these are real return trips.
  const [totalViews, distinctHostels] = await Promise.all([
    HostelPageViewModel.countDocuments(viewFilter),
    HostelPageViewModel.distinct("hostelId", viewFilter),
  ]);

  if (totalViews >= PROFILE_PROMPT_VIEW_THRESHOLD) {
    return {
      reason: "BROWSING" as const,
      shouldCollectProfile: true,
      viewedHostels: distinctHostels.length,
      views: totalViews,
    };
  }

  return {
    reason: null,
    shouldCollectProfile: false,
    viewedHostels: distinctHostels.length,
    views: totalViews,
  };
}

/** Same question, asked right after someone submits an inquiry. */
export async function shouldPromptAfterInquiry(userId?: string, email?: string) {
  await connectToDatabase();

  if (userId) {
    const existing = await UserResidentProfileModel.findOne({
      completedAt: { $ne: null },
      isDeleted: { $ne: true },
      userId: normalizeUserId(userId),
    })
      .select("_id")
      .lean<{ _id: Types.ObjectId } | null>();

    return !existing;
  }

  if (!email) {
    return true;
  }

  // Signed-out enquirers get asked too — a repeat enquirer benefits most.
  const priorInquiries = await InquiryModel.countDocuments({
    email: email.toLowerCase(),
    isDeleted: false,
  });

  return priorInquiries >= 1;
}
