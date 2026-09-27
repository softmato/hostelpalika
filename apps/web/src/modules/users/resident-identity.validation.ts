import { z } from "zod";

import {
  SIGNATURE_HEIGHT,
  SIGNATURE_WIDTH,
  signatureStrokes,
} from "@/lib/signature";

/**
 * The "fill it once, reuse it everywhere" personal profile. Every field here is
 * encrypted at rest — see lib/personal-data-crypto.ts.
 *
 * The field list is deliberately not open-ended: each one feeds something that
 * already exists in this product, so a hostel really can skip the paperwork.
 *
 *   fullName / phone / email / occupation  → Resident
 *   guardian* / secondGuardian*            → Guardian (name, phone, email, relation)
 *   emergencyContact*                      → EmergencyContact
 *   governmentId*                          → MoveInChecklist.documentsCollected
 *   bloodGroup / medicalNotes              → SOSAlert + safety handling
 *   dietaryPreference                      → Hostel.food (veg / non-veg service)
 *   gender / budgetRange                   → Inquiry, and BOYS/GIRLS hostel matching
 *   institution / courseOrDesignation      → the "educationInfo" in PHASES.md §2
 *
 * Anything hostel-specific (room, bed, deposit, move-in date) is intentionally
 * absent — that is the warden's call, not a portable fact about the person.
 */

export const GENDER_VALUES = ["MALE", "FEMALE", "OTHER", "PREFER_NOT_TO_SAY"] as const;

export const BLOOD_GROUP_VALUES = [
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

export const DIETARY_PREFERENCE_VALUES = [
  "NO_PREFERENCE",
  "VEG",
  "NON_VEG",
  "EGGETARIAN",
  "VEGAN",
] as const;

export const OCCUPATION_VALUES = ["STUDENT", "WORKING_PROFESSIONAL", "OTHER"] as const;

export const GOVERNMENT_ID_TYPE_VALUES = [
  "CITIZENSHIP",
  "PASSPORT",
  "DRIVING_LICENSE",
  "STUDENT_ID",
  "NATIONAL_ID",
  "OTHER",
] as const;

/*
 * This schema is fed straight from an HTML form, where "the user left it alone"
 * arrives as `""`, not as a missing key — a `<select>` placeholder, a cleared
 * date input, an untouched text box. Every optional field therefore treats a
 * blank string as "not provided" rather than rejecting it, so an untouched
 * field can never fail the whole submission.
 */
const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const phone = z.string().trim().min(7).max(24);
const optionalPhone = z.preprocess(blankToUndefined, phone.optional());

/**
 * The card's main phone: digits with the separators people type — spaces,
 * dashes, dots, brackets — and one leading `+`, 7 to 15 digits in all (the
 * international maximum). Deliberately not a Nepali-carrier pattern: landlines,
 * `+977` and Indian numbers are all real customers. It is also the number
 * checked for another account using it, so letters cannot slip past as one.
 */
export const RESIDENT_PHONE_MESSAGE =
  "Enter a phone number — digits only, with + and the country code if it isn't Nepali.";

export function isResidentPhone(value: string) {
  const digits = value.replace(/\D/g, "");

  return /^\+?[\d\s().-]+$/.test(value.trim()) && digits.length >= 7 && digits.length <= 15;
}

/**
 * One key per number however it was typed: digits only, with Nepal's `977`
 * dropped from a 13-digit number, so `+977 98-1234-5678` and `9812345678` are
 * the same phone. Other country codes are kept — an Indian `98…` is not a
 * Nepali one.
 */
export function residentPhoneKey(value: string) {
  const digits = value.replace(/\D/g, "");

  return digits.length === 13 && digits.startsWith("977") ? digits.slice(3) : digits;
}

const primaryPhone = phone.refine(isResidentPhone, RESIDENT_PHONE_MESSAGE);

const optionalEmail = z.preprocess(
  blankToUndefined,
  z.string().trim().toLowerCase().email().optional(),
);

/*
 * The cardholder signature — format in lib/signature.ts. Nothing but `M`/`L`
 * and integers is accepted: it is drawn into `<canvas>` and native views, never
 * parsed as markup, but a grammar this small leaves nothing to inject even if
 * it one day were.
 */
const SIGNATURE_PATTERN = /^(?:[ML]\d{1,3} \d{1,3})+$/;
const SIGNATURE_MIN_POINTS = 8;

const signature = z
  .string({ error: "Sign in the box before saving." })
  .max(16_000, "That signature is too detailed. Clear it and sign again.")
  .refine(
    (value) => value.startsWith("M") && SIGNATURE_PATTERN.test(value),
    "That signature could not be read. Clear it and sign again.",
  )
  .refine((value) => {
    const points = signatureStrokes(value).flat();

    return (
      points.length >= SIGNATURE_MIN_POINTS &&
      points.every(([x, y]) => x <= SIGNATURE_WIDTH && y <= SIGNATURE_HEIGHT)
    );
  }, "Sign in the box before saving.");

/**
 * Optional *here* and required by the service.
 *
 * A signature can now arrive two ways — drawn on the screen as the strokes
 * above, or photographed off paper and uploaded as an image, which comes in on
 * the envelope as `signatureAssetId` rather than inside the profile. Neither
 * field can see the other from where it is declared, and neither knows what is
 * already on the record, so "there has to be a signature" is decided in
 * `saveResidentIdentity` — exactly as the card photo already is.
 */
const optionalSignature = z.preprocess(blankToUndefined, signature.optional());

/** A `<select>` whose placeholder option carries `value=""`. */
const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(blankToUndefined, z.enum(values).optional());

/** Same, but a blank falls back to the documented default. */
const enumWithDefault = <T extends readonly [string, ...string[]]>(
  values: T,
  fallback: T[number],
) => z.preprocess(blankToUndefined, z.enum(values).default(fallback));

export const residentProfileDataSchema = z
  .object({
    /* Identity */
    fullName: z.string().trim().min(2).max(120),
    // Required: the card prints the resident's age from it.
    dateOfBirth: z.preprocess(
      blankToUndefined,
      z
        .string({ message: "Enter your date of birth." })
        .trim()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD format.")
        .refine(
          (value) => value <= new Date().toISOString().slice(0, 10),
          "Date of birth can't be in the future.",
        ),
    ),
    gender: z.enum(GENDER_VALUES),
    bloodGroup: enumWithDefault(BLOOD_GROUP_VALUES, "UNKNOWN"),

    /* Contact — at most two emails: the account email plus one backup. */
    primaryPhone,
    alternatePhone: optionalPhone,
    primaryEmail: z.string().trim().email().toLowerCase(),
    backupEmail: optionalEmail,

    /* Where they are from */
    permanentAddress: optionalText(240),
    city: optionalText(80),
    province: optionalText(80),

    /* What they do — maps straight onto Resident.residentType */
    occupation: enumWithDefault(OCCUPATION_VALUES, "STUDENT"),
    institution: optionalText(160),
    /** Course for a student, job title for a working professional. */
    courseOrDesignation: optionalText(120),

    /*
     * Guardians — the hostel needs at least one reachable adult. Email matters
     * as much as phone here: it is how the guardian portal invite is sent.
     */
    guardianName: z.string().trim().min(2).max(120),
    guardianRelation: z.string().trim().min(2).max(60),
    guardianPhone: phone,
    guardianEmail: optionalEmail,
    secondGuardianName: optionalText(120),
    secondGuardianRelation: optionalText(60),
    secondGuardianPhone: optionalPhone,
    secondGuardianEmail: optionalEmail,

    /* Emergency contact, when it is someone other than the guardian. */
    emergencyContactName: optionalText(120),
    emergencyContactRelation: optionalText(60),
    emergencyContactPhone: optionalPhone,

    /* Living preferences and safety notes */
    dietaryPreference: enumWithDefault(DIETARY_PREFERENCE_VALUES, "NO_PREFERENCE"),
    /** Free text (e.g. "8000-12000") so inquiry forms can autofill it too. */
    budgetRange: optionalText(40),
    medicalNotes: optionalText(500),
    interests: z
      .array(z.string().trim().min(1).max(40))
      .max(12)
      .default([])
      .transform((values) => Array.from(new Set(values.filter(Boolean)))),

    /* Government ID — hostels are legally required to record one. */
    governmentIdType: optionalEnum(GOVERNMENT_ID_TYPE_VALUES),
    governmentIdNumber: optionalText(40),

    /*
     * Printed on the back of the card. Personal, so it lives in the blob —
     * unlike a photographed signature, which is bytes in R2 behind a handle.
     */
    signature: optionalSignature,
  })
  .refine((value) => !value.backupEmail || value.backupEmail !== value.primaryEmail, {
    message: "The backup email must be different from your account email.",
    path: ["backupEmail"],
  });

export type ResidentProfileData = z.infer<typeof residentProfileDataSchema>;

const assetId = z.string().regex(/^[a-f\d]{24}$/i, "That is not a valid upload id.");

export const residentIdentitySaveSchema = z
  .object({
    /**
     * The card photo, attached in the same write as the details. Required by the
     * service on the first save unless one is already on the record; ownership of
     * the asset is re-checked there, never trusted from here.
     */
    photoAssetId: assetId.optional(),
    profile: residentProfileDataSchema,
    /**
     * A photographed signature, uploaded through the same pipeline as the photo.
     * The drawn alternative is `profile.signature`.
     */
    signatureAssetId: assetId.optional(),
    sharingEnabled: z.boolean().default(true),
  })
  .refine((value) => !(value.profile.signature && value.signatureAssetId), {
    message: "Send either a drawn signature or a photographed one, not both.",
    path: ["signatureAssetId"],
  });

export const residentEmailCheckSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

export const residentPhoneCheckSchema = z.object({ phone: primaryPhone });

export const residentIdentitySharingSchema = z.object({
  sharingEnabled: z.boolean(),
});

/**
 * The ID-card photo is set by handle, never by upload: the bytes already went to
 * R2 through the universal uploader, so all this endpoint accepts is the
 * FileAsset id it minted. Ownership of that asset is re-checked server-side.
 */
export const residentIdentityPhotoSchema = z.object({
  photoAssetId: assetId,
});

/**
 * Accepts anything the warden might realistically paste: `HH-4K7M-9XQ2`,
 * `hh4k7m9xq2`, or the full scan URL. normalizeResidentId() in the service does
 * the actual parsing and rejects what is not an ID.
 */
export const residentIdLookupSchema = z.object({
  hostelId: z
    .string()
    .regex(/^[a-f\d]{24}$/i)
    .optional(),
  residentId: z.string().trim().min(8).max(300),
});
