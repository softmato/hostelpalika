/**
 * The platform ID card — `/users/resident-identity`, `/qr`, `/photo`.
 *
 * Typed off `resident-identity.service.ts` and `resident-identity.validation.ts`.
 * Note the route is `requireApiPrincipal`, **not** `requireResidentPrincipal`:
 * the card belongs to the *account*, and a `PUBLIC_USER` with no hostel can hold
 * one. That is the point of it — the QR is how somebody walks into a hostel and
 * has their registration filled in without writing anything down.
 *
 * ## The photo is the one private image that needs no redirect
 *
 * `GET /users/resident-identity/photo` **streams the bytes through our origin**
 * rather than 302-ing to R2 (the web needed that so its canvas would not be
 * tainted). Two consequences for the phone, both good: the bearer token is all
 * that is required, and it cannot run into R2 rejecting an `Authorization`
 * header the way `privateAssetSource` has to work around — there is no redirect
 * hop to strip it on. There is also no id in the path, so this endpoint can only
 * ever return the caller's own face.
 *
 * ## The QR arrives as a `data:` URL, and may be null
 *
 * The server renders it with `qrcode` and returns `qrDataUrl`. That import is
 * wrapped in a `try`, so a failure yields **`null` with a 200** — the typed id
 * beside it is the manual-entry path and has to stay visible.
 */

import { API_BASE_URL, api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";

export const GENDERS = ["MALE", "FEMALE", "OTHER", "PREFER_NOT_TO_SAY"] as const;

export const BLOOD_GROUPS = [
  "A+",
  "A-",
  "B+",
  "B-",
  "AB+",
  "AB-",
  "O+",
  "O-",
  "UNKNOWN",
] as const;

export const DIETARY_PREFERENCES = [
  "NO_PREFERENCE",
  "VEG",
  "NON_VEG",
  "EGGETARIAN",
  "VEGAN",
] as const;

export const OCCUPATIONS = ["STUDENT", "WORKING_PROFESSIONAL", "OTHER"] as const;

export const GOVERNMENT_ID_TYPES = [
  "CITIZENSHIP",
  "PASSPORT",
  "DRIVING_LICENSE",
  "STUDENT_ID",
  "NATIONAL_ID",
  "OTHER",
] as const;

export type Gender = (typeof GENDERS)[number];
export type BloodGroup = (typeof BLOOD_GROUPS)[number];
export type DietaryPreference = (typeof DIETARY_PREFERENCES)[number];
export type Occupation = (typeof OCCUPATIONS)[number];
export type GovernmentIdType = (typeof GOVERNMENT_ID_TYPES)[number];

/** Which of the three variants this account holds. Derived server-side, never stored. */
export type IdCardType = "HOSTEL_OWNER" | "RESIDENT" | "SERVICE_PROVIDER";

/**
 * `residentProfileDataSchema`. Seven fields are required — `fullName`, `gender`,
 * `primaryPhone`, `primaryEmail`, `guardianName`, `guardianRelation`,
 * `guardianPhone` — and three carry server defaults (`bloodGroup`,
 * `occupation`, `dietaryPreference`). Everything else is genuinely optional.
 */
export type IdentityProfile = {
  alternatePhone?: string;
  /** Derived server-side from `dateOfBirth`; not part of the save payload. */
  age?: number | null;
  backupEmail?: string;
  bloodGroup: BloodGroup;
  budgetRange?: string;
  city?: string;
  courseOrDesignation?: string;
  /** `YYYY-MM-DD`. The server rejects any other shape. */
  dateOfBirth?: string;
  dietaryPreference: DietaryPreference;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  emergencyContactRelation?: string;
  fullName: string;
  gender: Gender;
  governmentIdNumber?: string;
  governmentIdType?: GovernmentIdType;
  guardianEmail?: string;
  guardianName: string;
  guardianPhone: string;
  guardianRelation: string;
  institution?: string;
  interests: string[];
  medicalNotes?: string;
  occupation: Occupation;
  permanentAddress?: string;
  primaryEmail: string;
  primaryPhone: string;
  province?: string;
  secondGuardianEmail?: string;
  secondGuardianName?: string;
  secondGuardianPhone?: string;
  secondGuardianRelation?: string;
  /**
   * Stroke data (`lib/signature.ts`) — the drawn signature.
   *
   * Optional because it is one of *two* ways to sign: the other is a photograph
   * of a signature on paper, which is not in the profile at all but an asset
   * handle, surfaced as `identity.hasSignatureImage`. The server insists on
   * exactly one and clears whichever was not chosen.
   */
  signature?: string;
};

/** What the save endpoint accepts — `age` is derived and must not be sent back. */
export type IdentityProfileInput = Omit<IdentityProfile, "age">;

export type Identity = {
  accountEmail: string | null;
  accountName: string;
  /**
   * The line under the holder's name for an owner or provider. `null` for a
   * resident, whose role comes from their own profile — see `cardRole` in
   * `resolvePlatformIdCard`.
   */
  cardRole: string | null;
  cardType: IdCardType;
  hasPhoto: boolean;
  /** False until the first successful save. Without it there is no card and no id. */
  hasProfile: boolean;
  /**
   * True when the back of the card is signed with a photograph rather than with
   * `profile.signature`. The bytes come from
   * `/users/resident-identity/signature` — see `identitySignatureSource`.
   */
  hasSignatureImage: boolean;
  lastSharedAt: string | null;
  /** Cache-buster for the photo URL — bump it and the phone refetches. */
  photoUpdatedAt: string | null;
  residentId: string | null;
  shareCount: number;
  shareUrl: string | null;
  sharingEnabled: boolean;
  /** Cache-buster for the signature URL, exactly as `photoUpdatedAt` is. */
  signatureUpdatedAt: string | null;
  updatedAt: string | null;
};

export type IdentityResponse = {
  identity: Identity;
  profile: IdentityProfile | null;
};

export type IdentityQr = {
  /** `data:image/png;base64,…`, or **null** when the server's renderer failed. */
  qrDataUrl: string | null;
  residentId: string;
  shareUrl: string;
};

export async function getIdentity() {
  const response = await api.get<ApiEnvelope<IdentityResponse>>(
    "/users/resident-identity",
  );

  return unwrap(response);
}

/**
 * **404s with `RESIDENT_PROFILE_MISSING`** until a profile has been saved, since
 * the QR encodes the share URL and there is no resident id to put in it. Call it
 * only when `identity.hasProfile && identity.residentId`.
 */
export async function getIdentityQr() {
  const response = await api.get<ApiEnvelope<IdentityQr>>(
    "/users/resident-identity/qr",
  );

  return unwrap(response);
}

/**
 * PUT, not POST — one profile per account, upserted. Returns the whole identity.
 *
 * `photoAssetId` attaches an already-uploaded photo in the same write; the
 * first save is refused without one. The server also overwrites
 * `primaryEmail` with the sign-in email whenever the account has one, and
 * answers 409 `RESIDENT_EMAIL_TAKEN` when a typed one belongs to someone else.
 */
export async function saveIdentity(input: {
  photoAssetId?: string;
  profile: IdentityProfileInput;
  /**
   * A photographed signature, uploaded through `uploadAsset` first. Sending
   * this *and* `profile.signature` is refused — the card has one signature
   * line, so the server will not be handed two candidates for it.
   */
  signatureAssetId?: string;
  sharingEnabled: boolean;
}) {
  const response = await api.put<ApiEnvelope<IdentityResponse>>(
    "/users/resident-identity",
    input,
  );

  return unwrap(response);
}

export type EmailCheckStatus = "AVAILABLE" | "TAKEN" | "YOURS";

/** The form's live check. Rate limited server-side; the save re-checks anyway. */
export async function checkIdentityEmail(email: string) {
  const response = await api.get<ApiEnvelope<{ email: string; status: EmailCheckStatus }>>(
    `/users/resident-identity/email-check?email=${encodeURIComponent(email)}`,
  );

  return unwrap(response);
}

/** The same live check for the card's main phone (`phone-check`). */
export async function checkIdentityPhone(phone: string) {
  const response = await api.get<ApiEnvelope<{ phone: string; status: EmailCheckStatus }>>(
    `/users/resident-identity/phone-check?phone=${encodeURIComponent(phone)}`,
  );

  return unwrap(response);
}

/**
 * Turning sharing off makes the id stop resolving for anyone who scans it. It
 * **404s with `RESIDENT_PROFILE_MISSING`** if no profile exists yet.
 */
export async function setIdentitySharing(sharingEnabled: boolean) {
  const response = await api.patch<ApiEnvelope<IdentityResponse>>(
    "/users/resident-identity",
    { sharingEnabled },
  );

  return unwrap(response);
}

/** The bytes went to R2 through `uploadAsset` already; this stores the handle. */
export async function setIdentityPhoto(photoAssetId: string) {
  const response = await api.put<ApiEnvelope<IdentityResponse>>(
    "/users/resident-identity/photo",
    { photoAssetId },
  );

  return unwrap(response);
}

export async function clearIdentityPhoto() {
  const response = await api.delete<ApiEnvelope<IdentityResponse>>(
    "/users/resident-identity/photo",
  );

  return unwrap(response);
}

/**
 * An `<Image source>` for the holder's card photo.
 *
 * Deliberately *not* `privateAssetSource`: this endpoint streams rather than
 * redirecting, so the header has nowhere to leak to and no presigned URL to
 * conflict with. The `v=` query is what makes a replaced photo bypass the image
 * cache — `expo-image` keys its disk cache on the URL, so without it a new
 * portrait shows the old one until the app is reinstalled.
 */
export function identityPhotoSource(
  identity: Pick<Identity, "hasPhoto" | "photoUpdatedAt">,
  token: string | null | undefined,
) {
  if (!identity.hasPhoto) {
    return null;
  }

  const version = encodeURIComponent(identity.photoUpdatedAt ?? "1");

  return {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    uri: `${API_BASE_URL}/api/v1/users/resident-identity/photo?v=${version}`,
  };
}

/**
 * An `<Image source>` for a photographed signature.
 *
 * Same arrangement and the same reasoning as {@link identityPhotoSource}: the
 * endpoint streams rather than redirecting, so the bearer header has nowhere to
 * leak to, and the `v=` query is what stops `expo-image`'s disk cache from
 * showing the signature this one replaced.
 */
export function identitySignatureSource(
  identity: Pick<Identity, "hasSignatureImage" | "signatureUpdatedAt">,
  token: string | null | undefined,
) {
  if (!identity.hasSignatureImage) {
    return null;
  }

  const version = encodeURIComponent(identity.signatureUpdatedAt ?? "1");

  return {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    uri: `${API_BASE_URL}/api/v1/users/resident-identity/signature?v=${version}`,
  };
}
