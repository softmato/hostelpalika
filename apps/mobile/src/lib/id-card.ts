/**
 * The ID card as data, and the rules behind its form.
 *
 * Its own module so it can be tested — Vitest here is node-side with no React
 * Native shim.
 *
 * ## The palette is fixed, and that is not an oversight
 *
 * Every other surface in this app takes its colours from the theme. This one does
 * not, because the card is a **document**: the web renders the same values onto a
 * canvas for the on-screen preview, the PNG the holder downloads and the image
 * attached to their approval email, so all three are identical. Quoting the
 * reason from `apps/web/src/lib/platform-id-card.ts`: an ID card that turns dark
 * because the viewer had dark mode on is not an ID card. These are that file's
 * exact hexes — if they change there, change them here.
 */

import type {
  BloodGroup,
  DietaryPreference,
  Gender,
  GovernmentIdType,
  IdCardType,
  Identity,
  IdentityProfile,
  IdentityProfileInput,
  Occupation,
} from "@/lib/identity-api";
import { isSignatureComplete } from "@/lib/signature";

/** `platform-id-card.ts`'s palette, verbatim. */
export const CARD_COLORS = {
  accent: "#48c98a",
  brand: "#0a8a4b",
  hairline: "#d9e5dd",
  ink: "#04301c",
  muted: "#5d6f66",
  paper: "#ffffff",
} as const;

/** `CARD_WIDTH / CARD_HEIGHT` — roughly ID-1 portrait (54 × 86 mm). */
export const CARD_ASPECT = 640 / 1000;

/* -------------------------------------------------------------------------- */
/* The variants                                                               */
/* -------------------------------------------------------------------------- */

type CardVariant = {
  accent: string;
  backBullets: string[];
  /**
   * How far the header's bottom edge bows below its baseline, in the web's
   * 640×1000 card units — `platform-id-card.ts`'s `bulge`, and the one piece of
   * geometry that differs per card type. It is the variant's silhouette: a
   * resident's card sags deeply, an owner's barely, a provider's is flat.
   */
  bulge: { back: number; front: number };
  idLabel: string;
  title: string;
};

/**
 * The per-variant copy, matching `VARIANTS` in `platform-id-card.ts`. A resident
 * approved as an owner or provider keeps their id and is simply re-issued in the
 * matching variant, so the client must render whichever `cardType` says — never
 * assume `RESIDENT`.
 */
const CARD_VARIANTS: Record<IdCardType, CardVariant> = {
  HOSTEL_OWNER: {
    accent: "#2fae72",
    backBullets: [
      "Show this card to confirm you are the registered owner of your hostel on the platform.",
      "No hostel or resident detail is stored in the code itself — it only carries your platform ID.",
      "Report a lost card from your account menu and the ID stops resolving straight away.",
    ],
    bulge: { back: 30, front: 44 },
    idLabel: "OWNER ID",
    title: "HOSTEL OWNER IDENTITY CARD",
  },
  RESIDENT: {
    accent: CARD_COLORS.accent,
    backBullets: [
      "Show the QR code to a hostel and they can fill your registration without asking you to write anything down.",
      "No personal detail is stored in the code itself — it only carries your resident ID.",
      "Turn sharing off from your account menu and the ID stops opening your details straight away.",
    ],
    bulge: { back: 74, front: 105 },
    idLabel: "RESIDENT ID",
    title: "RESIDENT IDENTITY CARD",
  },
  SERVICE_PROVIDER: {
    accent: "#6fdda6",
    backBullets: [
      "Show this card when you arrive for a job so the hostel can confirm you are a verified provider.",
      "No job or resident detail is stored in the code itself — it only carries your platform ID.",
      "Hostels send you jobs in the provider mobile app you signed in to with this ID.",
    ],
    bulge: { back: 0, front: 0 },
    idLabel: "PROVIDER ID",
    title: "SERVICE PROVIDER IDENTITY CARD",
  },
};

const CARD_NOUNS: Record<IdCardType, string> = {
  HOSTEL_OWNER: "hostel owner",
  RESIDENT: "resident",
  SERVICE_PROVIDER: "service provider",
};

export function idCardNoun(cardType: IdCardType = "RESIDENT"): string {
  return CARD_NOUNS[cardType];
}

/**
 * Which variant an account will be issued, decided from `/auth/me` alone.
 *
 * The server is still the authority — `resolvePlatformIdCard` does exactly this
 * against the database, and `GET /users/resident-identity` returns its answer.
 * This mirror exists for the one place that has to name the card **before**
 * fetching anything: the home header's button, which offers to create a card for
 * an account that has none. Calling the endpoint just to word a label would put
 * a network round trip in front of a tap.
 *
 * Keep it in step with `resolvePlatformIdCard`: `HOSTEL_ADMIN` outranks the
 * provider record, an approved provider outranks the default, and everyone else
 * is a resident.
 */
export function idCardTypeForAccount(account: {
  isServiceProvider?: boolean;
  role: string;
}): IdCardType {
  if (account.role === "HOSTEL_ADMIN") {
    return "HOSTEL_OWNER";
  }

  return account.isServiceProvider ? "SERVICE_PROVIDER" : "RESIDENT";
}

export const OCCUPATION_LABELS: Record<Occupation, string> = {
  OTHER: "Resident",
  STUDENT: "Student",
  WORKING_PROFESSIONAL: "Working Professional",
};

/* -------------------------------------------------------------------------- */
/* The card                                                                   */
/* -------------------------------------------------------------------------- */

export type IdCard = {
  accent: string;
  backBullets: string[];
  /** See {@link CardVariant.bulge}. In the web's card units, not pixels. */
  bulge: { back: number; front: number };
  fullName: string;
  idLabel: string;
  /** Preformatted — the renderer does no date maths, matching the web. */
  issuedOn: string;
  residentId: string;
  /** `[label, value]`, in the web's order. Blanks are already `—`. */
  rows: [string, string][];
  /** What is printed under the name, uppercased and letterspaced by the view. */
  role: string;
  /** Stroke data for the back's signature panel, or null before one was drawn. */
  signature: string | null;
  title: string;
};

/** `16 Aug 2026` from a `YYYY-MM-DD` or ISO string. `null` stays null. */
function cardDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  /*
   * UTC getters, not local ones, and no Nepal shift: a date of birth is a plain
   * calendar date the server stored as `YYYY-MM-DD`, so `new Date("2004-03-02")`
   * is midnight UTC and reading it with the *local* getters prints 1 March on
   * every phone west of Greenwich. This is not the same problem
   * `lib/format.ts` solves — that one is about instants.
   */
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * Mirrors `buildIdCardData` in `apps/web/src/components/resident-identity.tsx`,
 * including the two pieces of judgement embedded in it:
 *
 * 1. **`UNKNOWN` is never printed as a blood group.** It is the schema's
 *    placeholder default, and a paramedic reading "UNKNOWN" off a card cannot
 *    tell it from a real answer. It becomes a dash like any other blank.
 * 2. **An approved owner's or provider's `cardRole` outranks the profile's
 *    course or occupation** — it is what the card is now *for*.
 */
export function buildIdCard(
  identity: Identity,
  profile: IdentityProfile | null,
  now: Date = new Date(),
): IdCard {
  const variant = CARD_VARIANTS[identity.cardType] ?? CARD_VARIANTS.RESIDENT;
  const bloodGroup =
    profile?.bloodGroup && profile.bloodGroup !== "UNKNOWN" ? profile.bloodGroup : null;

  return {
    accent: variant.accent,
    backBullets: variant.backBullets,
    bulge: variant.bulge,
    fullName: profile?.fullName ?? identity.accountName,
    idLabel: variant.idLabel,
    issuedOn: cardDate(identity.updatedAt ?? now.toISOString()) ?? "—",
    residentId: identity.residentId ?? "—",
    role:
      identity.cardRole ||
      profile?.courseOrDesignation ||
      profile?.institution ||
      OCCUPATION_LABELS[profile?.occupation ?? "OTHER"] ||
      "Resident",
    rows: [
      ["ID NO", identity.residentId ?? "—"],
      ["DOB", cardDate(profile?.dateOfBirth) ?? "—"],
      ["BLOOD", bloodGroup ?? "—"],
      ["PHONE", profile?.primaryPhone ?? "—"],
      ["E-MAIL", identity.accountEmail ?? profile?.primaryEmail ?? "—"],
    ],
    signature: profile?.signature ?? null,
    title: variant.title,
  };
}

/** There is no card at all until a profile has been saved and an id minted. */
export function hasIdCard(identity: Identity): boolean {
  return identity.hasProfile && Boolean(identity.residentId);
}

/* -------------------------------------------------------------------------- */
/* The profile form                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The form's own shape: every field a string, because that is what a `TextInput`
 * holds. `toProfileInput` converts it to the payload, and the empty-string →
 * omitted step is the important half — see its comment.
 */
export type IdentityDraft = Record<IdentityTextField, string> & {
  bloodGroup: BloodGroup;
  dietaryPreference: DietaryPreference;
  gender: Gender | "";
  governmentIdType: GovernmentIdType | "";
  interests: string[];
  occupation: Occupation;
  /** Stroke data from the pad — `""` until something is drawn. */
  signature: string;
  /**
   * A local `file://` uri of a photographed signature, before it is uploaded.
   *
   * The two signature fields are exclusive: setting one clears the other, so
   * the draft can never describe a card with two signatures on it. The server
   * enforces the same rule from the other side.
   */
  signatureImageUri: string;
};

export type IdentityTextField =
  | "alternatePhone"
  | "backupEmail"
  | "budgetRange"
  | "city"
  | "courseOrDesignation"
  | "dateOfBirth"
  | "emergencyContactName"
  | "emergencyContactPhone"
  | "emergencyContactRelation"
  | "fullName"
  | "governmentIdNumber"
  | "guardianEmail"
  | "guardianName"
  | "guardianPhone"
  | "guardianRelation"
  | "institution"
  | "medicalNotes"
  | "permanentAddress"
  | "primaryEmail"
  | "primaryPhone"
  | "province"
  | "secondGuardianEmail"
  | "secondGuardianName"
  | "secondGuardianPhone"
  | "secondGuardianRelation";

export type IdentityErrors = Partial<Record<keyof IdentityDraft, string>>;

export function emptyIdentityDraft(): IdentityDraft {
  return {
    alternatePhone: "",
    backupEmail: "",
    bloodGroup: "UNKNOWN",
    budgetRange: "",
    city: "",
    courseOrDesignation: "",
    dateOfBirth: "",
    dietaryPreference: "NO_PREFERENCE",
    emergencyContactName: "",
    emergencyContactPhone: "",
    emergencyContactRelation: "",
    fullName: "",
    gender: "",
    governmentIdNumber: "",
    governmentIdType: "",
    guardianEmail: "",
    guardianName: "",
    guardianPhone: "",
    guardianRelation: "",
    institution: "",
    interests: [],
    medicalNotes: "",
    occupation: "STUDENT",
    permanentAddress: "",
    primaryEmail: "",
    primaryPhone: "",
    province: "",
    secondGuardianEmail: "",
    secondGuardianName: "",
    secondGuardianPhone: "",
    secondGuardianRelation: "",
    signature: "",
    signatureImageUri: "",
  };
}

/** Prefills the form from a saved profile so an edit is an edit, not a retype. */
export function draftFromProfile(profile: IdentityProfile | null): IdentityDraft {
  const draft = emptyIdentityDraft();

  if (!profile) {
    return draft;
  }

  const text = (value: string | undefined) => value ?? "";

  return {
    ...draft,
    alternatePhone: text(profile.alternatePhone),
    backupEmail: text(profile.backupEmail),
    bloodGroup: profile.bloodGroup,
    budgetRange: text(profile.budgetRange),
    city: text(profile.city),
    courseOrDesignation: text(profile.courseOrDesignation),
    dateOfBirth: text(profile.dateOfBirth),
    dietaryPreference: profile.dietaryPreference,
    emergencyContactName: text(profile.emergencyContactName),
    emergencyContactPhone: text(profile.emergencyContactPhone),
    emergencyContactRelation: text(profile.emergencyContactRelation),
    fullName: profile.fullName,
    gender: profile.gender,
    governmentIdNumber: text(profile.governmentIdNumber),
    governmentIdType: profile.governmentIdType ?? "",
    guardianEmail: text(profile.guardianEmail),
    guardianName: profile.guardianName,
    guardianPhone: profile.guardianPhone,
    guardianRelation: profile.guardianRelation,
    institution: text(profile.institution),
    interests: profile.interests ?? [],
    medicalNotes: text(profile.medicalNotes),
    occupation: profile.occupation,
    permanentAddress: text(profile.permanentAddress),
    primaryEmail: profile.primaryEmail,
    primaryPhone: profile.primaryPhone,
    province: text(profile.province),
    secondGuardianEmail: text(profile.secondGuardianEmail),
    secondGuardianName: text(profile.secondGuardianName),
    secondGuardianPhone: text(profile.secondGuardianPhone),
    secondGuardianRelation: text(profile.secondGuardianRelation),
    signature: text(profile.signature),
    signatureImageUri: "",
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `phone` on the server: trimmed, 7–24 characters. No pattern beyond length. */
function phoneError(value: string, label: string): string | null {
  const trimmed = value.trim();

  if (trimmed.length < 7) {
    return `${label} needs at least 7 characters.`;
  }

  return trimmed.length > 24 ? `${label} is too long.` : null;
}

/**
 * The server's `isResidentPhone`, for the card's main phone: digits with
 * spaces, dashes, dots or brackets and one leading `+`, 7–15 digits. Not a
 * Nepali-carrier pattern — landlines, `+977` and Indian numbers are real.
 */
export function isResidentPhone(value: string): boolean {
  const digits = value.replace(/\D/g, "");

  return /^\+?[\d\s().-]+$/.test(value.trim()) && digits.length >= 7 && digits.length <= 15;
}

export const RESIDENT_PHONE_MESSAGE =
  "Enter a phone number — digits only, with + and the country code if it isn't Nepali.";

/**
 * Mirrors `residentProfileDataSchema`. Seven fields are required and the rest are
 * validated only when filled, which is exactly what the server's
 * `blankToUndefined` preprocessing does — a blank optional field must never fail
 * the submission.
 */
export function validateIdentity(draft: IdentityDraft): IdentityErrors {
  const errors: IdentityErrors = {};
  const text = (field: IdentityTextField) => draft[field].trim();

  if (text("fullName").length < 2) {
    errors.fullName = "Enter your full name.";
  } else if (text("fullName").length > 120) {
    errors.fullName = "That name is too long.";
  }

  if (!draft.gender) {
    errors.gender = "Pick one.";
  }

  /*
   * Required here, optional at the server: the web form and older saves may
   * still send a profile without an address, but a new card from this app
   * does not get past step 3 without one.
   */
  if (text("permanentAddress").length < 2) {
    errors.permanentAddress = "Enter your permanent address.";
  }

  if (text("city").length < 2) {
    errors.city = "Enter your city.";
  }

  if (!text("province")) {
    errors.province = "Pick your province.";
  }

  const primaryPhone =
    phoneError(draft.primaryPhone, "Your phone number") ??
    (isResidentPhone(draft.primaryPhone) ? null : RESIDENT_PHONE_MESSAGE);

  if (primaryPhone) {
    errors.primaryPhone = primaryPhone;
  }

  if (!EMAIL.test(text("primaryEmail"))) {
    errors.primaryEmail = "Enter a valid email address.";
  }

  if (text("guardianName").length < 2) {
    errors.guardianName = "The hostel needs one reachable adult.";
  }

  if (text("guardianRelation").length < 2) {
    errors.guardianRelation = "How are they related to you?";
  }

  const guardianPhone = phoneError(draft.guardianPhone, "Their phone number");

  if (guardianPhone) {
    errors.guardianPhone = guardianPhone;
  }

  /*
   * Either form will do. A photographed signature has no strokes to measure, so
   * the only thing to check is that a file was chosen — the server re-checks
   * that it is an image the account owns, which is not a claim a client can
   * make for itself.
   */
  if (!isSignatureComplete(draft.signature) && !draft.signatureImageUri.trim()) {
    errors.signature = "Sign your card — draw it, or photograph it on paper.";
  }

  // Required: the card prints the resident's age from it.
  if (!text("dateOfBirth")) {
    errors.dateOfBirth = "Enter your date of birth.";
  } else if (!ISO_DATE.test(text("dateOfBirth"))) {
    errors.dateOfBirth = "Use YYYY-MM-DD.";
  } else if (text("dateOfBirth") > new Date().toISOString().slice(0, 10)) {
    errors.dateOfBirth = "Date of birth can't be in the future.";
  }

  /* Optional-when-filled from here down. */

  if (text("backupEmail")) {
    if (!EMAIL.test(text("backupEmail"))) {
      errors.backupEmail = "Enter a valid email address.";
    } else if (
      text("backupEmail").toLowerCase() === text("primaryEmail").toLowerCase()
    ) {
      // The server's own `.refine`, which fails the whole save rather than one
      // field — worth catching here so the message lands next to the input.
      errors.backupEmail = "Use a different address from your main one.";
    }
  }

  if (text("guardianEmail") && !EMAIL.test(text("guardianEmail"))) {
    errors.guardianEmail = "Enter a valid email address.";
  }

  if (text("secondGuardianEmail") && !EMAIL.test(text("secondGuardianEmail"))) {
    errors.secondGuardianEmail = "Enter a valid email address.";
  }

  for (const field of [
    "alternatePhone",
    "emergencyContactPhone",
    "secondGuardianPhone",
  ] as const) {
    if (draft[field].trim()) {
      const problem = phoneError(draft[field], "That number");

      if (problem) {
        errors[field] = problem;
      }
    }
  }

  if (text("medicalNotes").length > 500) {
    errors.medicalNotes = "Keep this under 500 characters.";
  }

  if (text("permanentAddress").length > 240) {
    errors.permanentAddress = "That address is too long.";
  }

  if (draft.interests.length > 12) {
    errors.interests = "Up to 12.";
  }

  return errors;
}

/**
 * The form as a sequence of screens.
 *
 * ## Why it is a sequence at all
 *
 * The thing being collected here is a KYC pack: name, address, guardian,
 * government ID, a face and a signature. As one page it was a wall — seven
 * cards, thirty-odd fields, a signature pad at the bottom — and the shape of a
 * wall is that you cannot tell from the top whether you are five minutes or
 * twenty from the end. One question-group per screen with a counter above it
 * answers that before the first field is touched, which is the entire reason
 * every bank app these residents use collects exactly this data exactly this
 * way.
 *
 * ## The order is not arbitrary
 *
 * Easy and personal first (name, phone), dull in the middle (address, study),
 * and the two that need the camera last. Somebody who opens the form on a bus
 * can get six steps in and only then be asked to point a camera at their face.
 *
 * ## Every step is a step, including the optional one
 *
 * "Study or work" asks for nothing required, and it still gets its own screen
 * with a Skip. Folding it into a neighbour to save a tap would make one screen
 * two jobs, and a step that can be dismissed in one tap costs less than a
 * screen that has to be read twice.
 */
export type IdentityStep =
  | "about"
  | "contact"
  | "address"
  | "work"
  | "guardian"
  | "preferences"
  | "photo"
  | "signature"
  | "review";

export const IDENTITY_STEPS: readonly {
  key: IdentityStep;
  /** Shown under the counter in the header, and as the screen's own lead line. */
  subtitle: string;
  title: string;
}[] = [
  { key: "about", subtitle: "Your basic details", title: "About you" },
  { key: "contact", subtitle: "How a hostel reaches you", title: "Contact" },
  { key: "address", subtitle: "Where you are from", title: "Address" },
  { key: "work", subtitle: "Optional — skip if neither fits", title: "Study or work" },
  {
    key: "guardian",
    subtitle: "One reachable adult, at least",
    title: "Guardian and emergency",
  },
  {
    key: "preferences",
    subtitle: "Food, safety notes and your ID document",
    title: "Preferences and ID",
  },
  { key: "photo", subtitle: "Goes on the front of your card", title: "Your photo" },
  { key: "signature", subtitle: "Goes on the back of your card", title: "Your signature" },
  { key: "review", subtitle: "Check it, then create your ID", title: "Review" },
];

/**
 * Which draft fields each step owns.
 *
 * The validation rules themselves are **not** duplicated per step —
 * {@link validateIdentity} stays the single statement of what the server will
 * accept, and a step is a filter over its result. Splitting the rules instead
 * would mean two places to change when the server's schema moves, and the one
 * that gets forgotten is always the one a user meets.
 *
 * `photo` owns no draft field: whether there is a photograph is a fact about an
 * upload rather than about the draft, so that step's completeness is decided by
 * the screen — see {@link identityStepComplete}.
 */
export const IDENTITY_STEP_FIELDS: Record<IdentityStep, readonly (keyof IdentityDraft)[]> =
  {
    about: ["fullName", "dateOfBirth", "gender", "bloodGroup"],
    address: ["permanentAddress", "city", "province"],
    contact: ["primaryPhone", "alternatePhone", "primaryEmail", "backupEmail"],
    guardian: [
      "guardianName",
      "guardianRelation",
      "guardianPhone",
      "guardianEmail",
      "secondGuardianName",
      "secondGuardianRelation",
      "secondGuardianPhone",
      "secondGuardianEmail",
      "emergencyContactName",
      "emergencyContactRelation",
      "emergencyContactPhone",
    ],
    photo: [],
    preferences: [
      "dietaryPreference",
      "budgetRange",
      "interests",
      "medicalNotes",
      "governmentIdType",
      "governmentIdNumber",
    ],
    /* Nothing of its own: Review shows every step and edits none of them. */
    review: [],
    signature: ["signature", "signatureImageUri"],
    work: ["occupation", "institution", "courseOrDesignation"],
  };

/** Just this step's problems, so a Continue press cannot flag a later screen. */
export function validateIdentityStep(
  step: IdentityStep,
  draft: IdentityDraft,
): IdentityErrors {
  const all = validateIdentity(draft);
  const errors: IdentityErrors = {};

  for (const field of IDENTITY_STEP_FIELDS[step]) {
    if (all[field]) {
      errors[field] = all[field];
    }
  }

  return errors;
}

/**
 * Whether a step is done, for the tick beside it on Review and for the tracker.
 *
 * `assets` carries the two facts the draft cannot hold: whether a photograph
 * exists (freshly picked, or already on the record from a previous save) and
 * whether the signature is a photograph rather than strokes.
 */
export function identityStepComplete(
  step: IdentityStep,
  draft: IdentityDraft,
  assets: { hasPhoto: boolean; hasSignatureImage: boolean },
): boolean {
  if (step === "photo") {
    return assets.hasPhoto;
  }

  if (step === "signature") {
    /*
     * Three ways to be signed, and the draft holds two of them: strokes drawn
     * just now, a photograph taken just now, or a photograph already on the
     * record from a previous save with nothing re-sent this time.
     */
    return (
      assets.hasSignatureImage ||
      Boolean(draft.signatureImageUri.trim()) ||
      isSignatureComplete(draft.signature)
    );
  }

  return !hasIdentityErrors(validateIdentityStep(step, draft));
}

/**
 * The first step still missing something, or `null` when the form is ready.
 *
 * Used to send somebody straight to what is wrong instead of walking them
 * through nine screens to find it — the Review screen's "Some details need
 * fixing" jumps here.
 */
export function firstIncompleteIdentityStep(
  draft: IdentityDraft,
  assets: { hasPhoto: boolean; hasSignatureImage: boolean },
): IdentityStep | null {
  return (
    IDENTITY_STEPS.map((step) => step.key).find(
      (key) => key !== "review" && !identityStepComplete(key, draft, assets),
    ) ?? null
  );
}

export function hasIdentityErrors(errors: IdentityErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * The draft as the save payload.
 *
 * **A blank optional field is omitted, not sent as `""`.** The server's
 * preprocessing does convert `""` to `undefined` — it was written for an HTML
 * form, where an untouched input arrives as an empty string — but relying on that
 * would put `primaryEmail: ""` through `z.string().email()` for a *required*
 * field and, worse, make the `optionalEnum` fields depend on a coercion the
 * client can see and should not need. Sending only what was filled in is the
 * payload the schema describes.
 */
export function toProfileInput(draft: IdentityDraft): IdentityProfileInput {
  const text = (field: IdentityTextField) => draft[field].trim() || undefined;

  return {
    ...(text("alternatePhone") ? { alternatePhone: text("alternatePhone") } : {}),
    ...(text("backupEmail") ? { backupEmail: text("backupEmail") } : {}),
    ...(text("budgetRange") ? { budgetRange: text("budgetRange") } : {}),
    ...(text("city") ? { city: text("city") } : {}),
    ...(text("courseOrDesignation")
      ? { courseOrDesignation: text("courseOrDesignation") }
      : {}),
    ...(text("dateOfBirth") ? { dateOfBirth: text("dateOfBirth") } : {}),
    ...(text("emergencyContactName")
      ? { emergencyContactName: text("emergencyContactName") }
      : {}),
    ...(text("emergencyContactPhone")
      ? { emergencyContactPhone: text("emergencyContactPhone") }
      : {}),
    ...(text("emergencyContactRelation")
      ? { emergencyContactRelation: text("emergencyContactRelation") }
      : {}),
    ...(text("governmentIdNumber")
      ? { governmentIdNumber: text("governmentIdNumber") }
      : {}),
    ...(draft.governmentIdType ? { governmentIdType: draft.governmentIdType } : {}),
    ...(text("guardianEmail") ? { guardianEmail: text("guardianEmail") } : {}),
    ...(text("institution") ? { institution: text("institution") } : {}),
    ...(text("medicalNotes") ? { medicalNotes: text("medicalNotes") } : {}),
    ...(text("permanentAddress")
      ? { permanentAddress: text("permanentAddress") }
      : {}),
    ...(text("province") ? { province: text("province") } : {}),
    ...(text("secondGuardianEmail")
      ? { secondGuardianEmail: text("secondGuardianEmail") }
      : {}),
    ...(text("secondGuardianName")
      ? { secondGuardianName: text("secondGuardianName") }
      : {}),
    ...(text("secondGuardianPhone")
      ? { secondGuardianPhone: text("secondGuardianPhone") }
      : {}),
    ...(text("secondGuardianRelation")
      ? { secondGuardianRelation: text("secondGuardianRelation") }
      : {}),
    bloodGroup: draft.bloodGroup,
    dietaryPreference: draft.dietaryPreference,
    fullName: draft.fullName.trim(),
    // Validated before this runs; the cast is the one place the form's "nothing
    // picked yet" empty string is discharged.
    gender: draft.gender as Exclude<IdentityDraft["gender"], "">,
    guardianName: draft.guardianName.trim(),
    guardianPhone: draft.guardianPhone.trim(),
    guardianRelation: draft.guardianRelation.trim(),
    // De-duplicated and blank-stripped here as well as on the server, so the
    // chip list a user sees is the list that gets stored.
    interests: Array.from(new Set(draft.interests.map((i) => i.trim()).filter(Boolean))),
    occupation: draft.occupation,
    primaryEmail: draft.primaryEmail.trim().toLowerCase(),
    primaryPhone: draft.primaryPhone.trim(),
    /*
     * Omitted entirely when the signature is a photograph, rather than sent as
     * `""`. The server takes the *absence* of strokes beside a
     * `signatureAssetId` as the instruction to store the image, and an empty
     * string would fail the stroke grammar before it got that far.
     */
    ...(draft.signatureImageUri.trim() ? {} : { signature: draft.signature }),
  };
}
