import { z } from "zod";

import {
  BLOOD_GROUP_VALUES,
  DIETARY_PREFERENCE_VALUES,
  GENDER_VALUES,
  type ResidentProfileData,
  residentSignatureSchema,
} from "@/lib/users/resident-identity.validation";

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
