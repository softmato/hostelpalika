import { z } from "zod";

import { decryptPersonalData, encryptPersonalData } from "@/lib/personal-data-crypto";
import {
  BLOOD_GROUP_VALUES,
  DIETARY_PREFERENCE_VALUES,
  GENDER_VALUES,
  type ResidentProfileData,
  residentSignatureSchema,
} from "@/modules/users/resident-identity.validation";

/**
 * The hostel's application form, as data (the paper "Student Application
 * Form" every Nepali hostel hands out: address by district and ward,
 * citizenship number, college and class time, father, mother, spouse and a
 * local guardian).
 *
 * One shape for every way it arrives — the warden typing it for somebody with
 * no ID card, the person filling the hostel's Form QR themself, and a scanned
 * ID card (`detailsFromCard`) — so the resident's record shows one set of facts
 * whichever door they came in by. Stored on `Resident.detailsData` and
 * `AdmissionForm.detailsData`, encrypted like the ID card itself: a citizenship
 * number is not something a database dump should hand out.
 */

const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const text = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const person = z.object({
  name: z.string().trim().min(2).max(120),
  occupation: text(80),
  phone: text(24),
  relation: z.string().trim().min(2).max(60),
});

export const residentDetailsSchema = z.object({
  dateOfBirth: z.preprocess(
    blankToUndefined,
    z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Write the date of birth as YYYY-MM-DD.").optional(),
  ),
  gender: z.preprocess(blankToUndefined, z.enum(GENDER_VALUES).optional()),
  bloodGroup: z.preprocess(blankToUndefined, z.enum(BLOOD_GROUP_VALUES).optional()),
  food: z.preprocess(blankToUndefined, z.enum(DIETARY_PREFERENCE_VALUES).optional()),
  /** "Mention the disease (if any)". */
  medicalNotes: text(500),

  district: text(60),
  municipality: text(80),
  wardNo: text(10),
  tole: text(160),

  citizenshipNo: text(40),
  citizenshipIssuedOn: text(20),
  citizenshipIssuedAt: text(80),

  institution: text(160),
  levelOfStudy: text(80),
  classTime: text(60),
  /** "Time duration to stay in the hostel" — their words, "1 year", "till exams". */
  stayDuration: text(60),

  /** Father, mother, spouse — or the card's guardians, under their own relation. */
  family: z.array(person).max(6).default([]),
  localGuardian: person.extend({ address: text(160) }).optional(),
  /** Signed on the form; it becomes the back of their ID card (`card-from-form.ts`). */
  signature: residentSignatureSchema,
});

export type ResidentDetails = z.infer<typeof residentDetailsSchema>;

function isEmpty(details: ResidentDetails) {
  return Object.entries(details).every(([, value]) =>
    Array.isArray(value) ? value.length === 0 : value === undefined || value === null,
  );
}

/** The encrypted blob for the record, or null when nothing was filled in. */
export function sealDetails(details: ResidentDetails | undefined | null) {
  return details && !isEmpty(details) ? encryptPersonalData(details) : null;
}

/** Never throws: a blob that will not open reads as "nothing on file". */
export function openDetails(blob: string | null | undefined): ResidentDetails | null {
  if (!blob) return null;

  try {
    return decryptPersonalData<ResidentDetails>(blob);
  } catch {
    return null;
  }
}

/** The same facts off a scanned ID card, so a carded resident's record holds them too. */
export function detailsFromCard(profile: ResidentProfileData): ResidentDetails {
  const family: ResidentDetails["family"] = [
    {
      name: profile.guardianName,
      occupation: profile.guardianOccupation,
      phone: profile.guardianPhone,
      relation: profile.guardianRelation,
    },
  ];

  if (profile.secondGuardianName) {
    family.push({
      name: profile.secondGuardianName,
      occupation: profile.secondGuardianOccupation,
      phone: profile.secondGuardianPhone,
      relation: profile.secondGuardianRelation ?? "Guardian",
    });
  }

  return {
    bloodGroup: profile.bloodGroup === "UNKNOWN" ? undefined : profile.bloodGroup,
    citizenshipIssuedAt: profile.governmentIdIssuedAt,
    citizenshipIssuedOn: profile.governmentIdIssuedOn,
    citizenshipNo: profile.governmentIdNumber,
    classTime: profile.classTime,
    dateOfBirth: profile.dateOfBirth,
    district: profile.district,
    family,
    food: profile.dietaryPreference === "NO_PREFERENCE" ? undefined : profile.dietaryPreference,
    gender: profile.gender,
    institution: profile.institution,
    levelOfStudy: profile.levelOfStudy ?? profile.courseOrDesignation,
    localGuardian: profile.emergencyContactName
      ? {
          address: profile.emergencyContactAddress,
          name: profile.emergencyContactName,
          occupation: profile.emergencyContactOccupation,
          phone: profile.emergencyContactPhone,
          relation: profile.emergencyContactRelation ?? "Local guardian",
        }
      : undefined,
    medicalNotes: profile.medicalNotes,
    municipality: profile.city,
    tole: profile.permanentAddress,
    wardNo: profile.wardNo,
  };
}

/**
 * The other way round: an ID card profile out of the form, for a resident whose
 * card is made from what they wrote (`card-from-form.ts`). Not parsed here —
 * whatever the form left out, the card's own schema says so. The guardian is
 * the first of the family with a phone, because the card cannot print one
 * nobody can ring.
 */
export function cardFromDetails(
  details: ResidentDetails,
  who: { email: string; firstName: string; lastName: string; phone: string; residentType?: string },
) {
  const family = details.family ?? [];
  const guardian = family.find((person) => person.phone) ?? family[0];
  const second = family.find((person) => person !== guardian);
  const local = details.localGuardian;

  return {
    bloodGroup: details.bloodGroup,
    city: details.municipality,
    classTime: details.classTime,
    dateOfBirth: details.dateOfBirth,
    dietaryPreference: details.food,
    district: details.district,
    emergencyContactAddress: local?.address,
    emergencyContactName: local?.name,
    emergencyContactOccupation: local?.occupation,
    emergencyContactPhone: local?.phone,
    emergencyContactRelation: local?.relation,
    fullName: `${who.firstName} ${who.lastName}`.trim(),
    gender: details.gender,
    governmentIdIssuedAt: details.citizenshipIssuedAt,
    governmentIdIssuedOn: details.citizenshipIssuedOn,
    governmentIdNumber: details.citizenshipNo,
    governmentIdType: details.citizenshipNo ? ("CITIZENSHIP" as const) : undefined,
    guardianName: guardian?.name,
    guardianOccupation: guardian?.occupation,
    guardianPhone: guardian?.phone,
    guardianRelation: guardian?.relation,
    institution: details.institution,
    levelOfStudy: details.levelOfStudy,
    medicalNotes: details.medicalNotes,
    occupation: who.residentType,
    permanentAddress: details.tole,
    primaryEmail: who.email,
    primaryPhone: who.phone,
    secondGuardianName: second?.name,
    secondGuardianOccupation: second?.occupation,
    secondGuardianPhone: second?.phone,
    secondGuardianRelation: second?.relation,
    signature: details.signature,
    wardNo: details.wardNo,
  };
}
