import { isSignatureComplete } from "@/lib/signature";
import {
  isResidentPhone,
  RESIDENT_PHONE_MESSAGE,
} from "@/modules/users/resident-identity.validation";

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
  iconName: string;
  key: IdentityStep;
  subtitle: string;
  title: string;
}[] = [
  { iconName: "User", key: "about", subtitle: "As written on your official ID", title: "About you" },
  { iconName: "Phone", key: "contact", subtitle: "How a hostel reaches you", title: "Contact" },
  { iconName: "MapPin", key: "address", subtitle: "Where you are permanently from", title: "Address" },
  { iconName: "Briefcase", key: "work", subtitle: "Optional — college or company details", title: "Study or work" },
  {
    iconName: "Shield",
    key: "guardian",
    subtitle: "Reachable adult contact for emergencies",
    title: "Guardian and emergency",
  },
  {
    iconName: "Sliders",
    key: "preferences",
    subtitle: "Food preference, budget and government ID",
    title: "Preferences and ID",
  },
  { iconName: "Camera", key: "photo", subtitle: "Passport photo for your Resident ID card", title: "Your photo" },
  { iconName: "PenTool", key: "signature", subtitle: "Draw or photograph your card signature", title: "Your signature" },
  { iconName: "ShieldCheck", key: "review", subtitle: "Verify your details before issuing card", title: "Review" },
];

export type IdentityDraft = {
  alternatePhone: string;
  backupEmail: string;
  bloodGroup: string;
  budgetRange: string;
  city: string;
  courseOrDesignation: string;
  dateOfBirth: string;
  dietaryPreference: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  emergencyContactRelation: string;
  fullName: string;
  gender: string;
  governmentIdNumber: string;
  governmentIdType: string;
  guardianEmail: string;
  guardianName: string;
  guardianPhone: string;
  guardianRelation: string;
  institution: string;
  interests: string[];
  medicalNotes: string;
  occupation: string;
  permanentAddress: string;
  primaryEmail: string;
  primaryPhone: string;
  province: string;
  secondGuardianEmail: string;
  secondGuardianName: string;
  secondGuardianPhone: string;
  secondGuardianRelation: string;
  signature: string;
  signatureImageUri: string;
};

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

export function draftFromProfile(
  profile: Partial<Omit<IdentityDraft, "signatureImageUri">> | null | undefined,
): IdentityDraft {
  const empty = emptyIdentityDraft();
  if (!profile) return empty;
  return {
    ...empty,
    alternatePhone: profile.alternatePhone ?? "",
    backupEmail: profile.backupEmail ?? "",
    bloodGroup: profile.bloodGroup ?? "UNKNOWN",
    budgetRange: profile.budgetRange ?? "",
    city: profile.city ?? "",
    courseOrDesignation: profile.courseOrDesignation ?? "",
    dateOfBirth: profile.dateOfBirth ?? "",
    dietaryPreference: profile.dietaryPreference ?? "NO_PREFERENCE",
    emergencyContactName: profile.emergencyContactName ?? "",
    emergencyContactPhone: profile.emergencyContactPhone ?? "",
    emergencyContactRelation: profile.emergencyContactRelation ?? "",
    fullName: profile.fullName ?? "",
    gender: profile.gender ?? "",
    governmentIdNumber: profile.governmentIdNumber ?? "",
    governmentIdType: profile.governmentIdType ?? "",
    guardianEmail: profile.guardianEmail ?? "",
    guardianName: profile.guardianName ?? "",
    guardianPhone: profile.guardianPhone ?? "",
    guardianRelation: profile.guardianRelation ?? "",
    institution: profile.institution ?? "",
    interests: Array.isArray(profile.interests) ? profile.interests : [],
    medicalNotes: profile.medicalNotes ?? "",
    occupation: profile.occupation ?? "STUDENT",
    permanentAddress: profile.permanentAddress ?? "",
    primaryEmail: profile.primaryEmail ?? "",
    primaryPhone: profile.primaryPhone ?? "",
    province: profile.province ?? "",
    secondGuardianEmail: profile.secondGuardianEmail ?? "",
    secondGuardianName: profile.secondGuardianName ?? "",
    secondGuardianPhone: profile.secondGuardianPhone ?? "",
    secondGuardianRelation: profile.secondGuardianRelation ?? "",
    signature: profile.signature ?? "",
    signatureImageUri: "",
  };
}

export type IdentityErrors = Partial<Record<keyof IdentityDraft, string>>;

export const IDENTITY_STEP_FIELDS: Record<IdentityStep, readonly (keyof IdentityDraft)[]> = {
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
  review: [],
  signature: ["signature", "signatureImageUri"],
  work: ["occupation", "institution", "courseOrDesignation"],
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function phoneError(value: string, label: string): string | null {
  const trimmed = value.trim();

  if (trimmed.length < 7) {
    return `${label} needs at least 7 characters.`;
  }

  return trimmed.length > 24 ? `${label} is too long.` : null;
}

export function validateIdentity(draft: IdentityDraft): IdentityErrors {
  const errors: IdentityErrors = {};
  const text = (field: keyof IdentityDraft) =>
    typeof draft[field] === "string" ? (draft[field] as string).trim() : "";

  if (text("fullName").length < 2) {
    errors.fullName = "Enter your full name.";
  } else if (text("fullName").length > 120) {
    errors.fullName = "That name is too long.";
  }

  if (!draft.gender) {
    errors.gender = "Pick one.";
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

  if (!isSignatureComplete(draft.signature) && !draft.signatureImageUri.trim()) {
    errors.signature = "Sign your card — draw it, or photograph it on paper.";
  }

  if (!text("dateOfBirth")) {
    errors.dateOfBirth = "Enter your date of birth.";
  } else if (!ISO_DATE.test(text("dateOfBirth"))) {
    errors.dateOfBirth = "Use YYYY-MM-DD.";
  } else if (text("dateOfBirth") > new Date().toISOString().slice(0, 10)) {
    errors.dateOfBirth = "Date of birth can't be in the future.";
  }

  if (text("backupEmail")) {
    if (!EMAIL.test(text("backupEmail"))) {
      errors.backupEmail = "Enter a valid email address.";
    } else if (text("backupEmail").toLowerCase() === text("primaryEmail").toLowerCase()) {
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

export function identityStepComplete(
  step: IdentityStep,
  draft: IdentityDraft,
  assets: { hasPhoto: boolean; hasSignatureImage: boolean },
): boolean {
  if (step === "photo") {
    return assets.hasPhoto;
  }

  if (step === "signature") {
    return (
      assets.hasSignatureImage ||
      Boolean(draft.signatureImageUri.trim()) ||
      isSignatureComplete(draft.signature)
    );
  }

  return Object.keys(validateIdentityStep(step, draft)).length === 0;
}

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
