/**
 * The hostel's application form — the paper "Student Application Form" — as
 * data. Mirrors `apps/web/src/modules/residents/resident-details.ts`; read
 * that, not this file, when the two disagree.
 *
 * One shape whichever way it arrives: typed by the warden for somebody with no
 * ID card, filled by the person through the hostel's Form QR, or read off a
 * scanned ID card. It is stored on the resident and shown on their record.
 */

export type DetailsPerson = {
  name: string;
  occupation?: string;
  phone?: string;
  relation: string;
};

export type ResidentDetails = {
  bloodGroup?: string;
  citizenshipIssuedAt?: string;
  citizenshipIssuedOn?: string;
  citizenshipNo?: string;
  classTime?: string;
  dateOfBirth?: string;
  district?: string;
  family?: DetailsPerson[];
  food?: string;
  gender?: string;
  institution?: string;
  levelOfStudy?: string;
  localGuardian?: DetailsPerson & { address?: string };
  medicalNotes?: string;
  municipality?: string;
  /** Signed on the form; it becomes the back of their ID card. Strokes, see `lib/signature`. */
  signature?: string;
  stayDuration?: string;
  tole?: string;
  wardNo?: string;
};

/**
 * The face on the form: the local picture, plus the upload's id and claim token
 * once it is up. No `fileAssetId` yet means it is still uploading.
 */
export type ApplicantPhoto = { claimToken?: string; fileAssetId?: string; uri: string };

/** Citizenship or ID scans on the form. Mirrors the server's `ADMISSION_DOCUMENT_KINDS`. */
export const DOCUMENT_KINDS = ["APPLICANT_ID", "GUARDIAN_ID"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export type ApplicantDocuments = Partial<Record<DocumentKind, ApplicantPhoto>>;

export const DOCUMENT_LABELS: Record<DocumentKind, string> = {
  APPLICANT_ID: "Citizenship or ID",
  GUARDIAN_ID: "Guardian's citizenship or ID",
};

/**
 * What stops the form on its documents: the applicant's own ID always, the
 * guardian's when the hostel requires it (Settings → Form details), and any
 * scan still uploading.
 */
export function documentsProblem(documents: ApplicantDocuments, guardianRequired: boolean): string | null {
  if (Object.values(documents).some((document) => document && !document.fileAssetId)) {
    return "A document is still uploading.";
  }
  if (!documents.APPLICANT_ID) return "Add a photo of the citizenship or ID.";
  if (guardianRequired && !documents.GUARDIAN_ID) return "This hostel needs the guardian's citizenship or ID too.";

  return null;
}

export function documentsPayload(documents: ApplicantDocuments) {
  return DOCUMENT_KINDS.flatMap((kind) => {
    const ready = photoPayload(documents[kind] ?? null);

    return ready ? [{ ...ready, kind }] : [];
  });
}

/** What the server takes for the photo, or nothing while there is none ready. */
export function photoPayload(photo: ApplicantPhoto | null) {
  return photo?.fileAssetId && photo.claimToken
    ? { claimToken: photo.claimToken, fileAssetId: photo.fileAssetId }
    : undefined;
}

/** Every box on the form, as the string a `TextInput` holds. */
export const APPLICANT_FIELDS = [
  "firstName",
  "lastName",
  "phone",
  "email",
  "dateOfBirth",
  "gender",
  "bloodGroup",
  "food",
  "medicalNotes",
  "district",
  "municipality",
  "wardNo",
  "tole",
  "citizenshipNo",
  "citizenshipIssuedOn",
  "citizenshipIssuedAt",
  "institution",
  "levelOfStudy",
  "classTime",
  "stayDuration",
  "fatherName",
  "fatherPhone",
  "fatherOccupation",
  "motherName",
  "motherPhone",
  "motherOccupation",
  "spouseName",
  "spousePhone",
  "spouseOccupation",
  "localName",
  "localRelation",
  "localPhone",
  "localOccupation",
  "localAddress",
  "signature",
] as const;

export type ApplicantField = (typeof APPLICANT_FIELDS)[number];
export type ApplicantDraft = Record<ApplicantField, string>;

export function emptyApplicantDraft(): ApplicantDraft {
  return Object.fromEntries(APPLICANT_FIELDS.map((field) => [field, ""])) as ApplicantDraft;
}

export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] as const;

export const GENDER_OPTIONS = [
  { label: "Male", value: "MALE" },
  { label: "Female", value: "FEMALE" },
  { label: "Other", value: "OTHER" },
] as const;

const GENDER_LABELS: Record<string, string> = { FEMALE: "Female", MALE: "Male", OTHER: "Other" };

export const FOOD_OPTIONS = [
  { label: "Vegetarian", value: "VEG" },
  { label: "Only egg", value: "EGGETARIAN" },
  { label: "Non-veg", value: "NON_VEG" },
] as const;

const FOOD_LABELS: Record<string, string> = {
  EGGETARIAN: "Only egg",
  NON_VEG: "Non-vegetarian",
  VEG: "Vegetarian",
  VEGAN: "Vegan",
};

const FAMILY = [
  { key: "father", relation: "Father" },
  { key: "mother", relation: "Mother" },
  { key: "spouse", relation: "Spouse" },
] as const;

/** What stops the form going: only the name and a number are required. */
export function applicantProblem(draft: ApplicantDraft): string | null {
  if (!draft.firstName.trim() || !draft.lastName.trim()) return "Write the first and last name.";
  if (draft.phone.replace(/\D/g, "").length < 7) return "Write the contact number.";
  if (draft.dateOfBirth.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(draft.dateOfBirth.trim())) {
    return "Write the date of birth as YYYY-MM-DD.";
  }

  return null;
}

/**
 * The person's own form asks for the rest of what their ID card prints — the
 * card is made from it when the hostel registers them. Mirrors the server's
 * `cardGap`; the email is their login.
 */
export function cardProblem(draft: ApplicantDraft): string | null {
  if (!/^\S+@\S+\.\S+$/.test(draft.email.trim())) return "Write your email — you log in with it.";
  if (!draft.dateOfBirth.trim()) return "Write your date of birth.";
  if (!draft.gender) return "Choose your gender.";
  if (
    ![draft.fatherPhone, draft.motherPhone, draft.spousePhone].some(
      (phone) => phone.replace(/\D/g, "").length >= 7,
    )
  ) {
    return "Write your father's or mother's contact number.";
  }
  if (!draft.signature) return "Sign the form.";

  return null;
}

/** The draft as the server's `residentDetailsSchema` reads it; blank boxes are left out. */
export function detailsFromDraft(draft: ApplicantDraft): ResidentDetails {
  const v = (field: ApplicantField) => draft[field].trim() || undefined;
  const family = FAMILY.filter(({ key }) => (v(`${key}Name`) ?? "").length >= 2).map(({ key, relation }) => ({
    name: v(`${key}Name`)!,
    occupation: v(`${key}Occupation`),
    phone: v(`${key}Phone`),
    relation,
  }));
  const local = v("localName");

  return {
    bloodGroup: v("bloodGroup"),
    citizenshipIssuedAt: v("citizenshipIssuedAt"),
    citizenshipIssuedOn: v("citizenshipIssuedOn"),
    citizenshipNo: v("citizenshipNo"),
    classTime: v("classTime"),
    dateOfBirth: v("dateOfBirth"),
    district: v("district"),
    family,
    food: v("food"),
    gender: v("gender"),
    institution: v("institution"),
    levelOfStudy: v("levelOfStudy"),
    localGuardian:
      local && local.length >= 2
        ? {
            address: v("localAddress"),
            name: local,
            occupation: v("localOccupation"),
            phone: v("localPhone"),
            relation: (v("localRelation") ?? "").length >= 2 ? v("localRelation")! : "Local guardian",
          }
        : undefined,
    medicalNotes: v("medicalNotes"),
    municipality: v("municipality"),
    signature: v("signature"),
    stayDuration: v("stayDuration"),
    tole: v("tole"),
    wardNo: v("wardNo"),
  };
}

function splitName(name: string) {
  const [first = name, ...rest] = name.trim().split(/\s+/);

  return { firstName: first, lastName: rest.join(" ") || first };
}

/**
 * The family and local guardian as guardian and emergency records — the same
 * records a scanned card writes, so an SOS reaches them whichever way the
 * resident came in. Only people with a phone number: a record nobody can ring
 * is not a contact.
 */
export function detailsContacts(details: ResidentDetails) {
  const guardians = (details.family ?? [])
    .filter((person) => (person.phone ?? "").replace(/\D/g, "").length >= 7)
    .map((person, index) => ({
      ...splitName(person.name),
      isPrimary: index === 0,
      phone: person.phone!,
      relation: person.relation,
    }));
  const local = details.localGuardian;
  const emergencyContact =
    local && (local.phone ?? "").replace(/\D/g, "").length >= 7
      ? { isPrimary: true, name: local.name, phone: local.phone!, relation: local.relation }
      : null;

  return { emergencyContact, guardians };
}

export type DetailFact = { label: string; phone?: string; value: string };

function person(label: string, entry: DetailsPerson & { address?: string }): DetailFact {
  return {
    label,
    phone: entry.phone,
    value: [entry.name, entry.occupation, entry.address].filter(Boolean).join(" · "),
  };
}

/** The form read back in the order of the paper, empty sections dropped. */
export function detailsSections(details: ResidentDetails | null | undefined) {
  if (!details) return [];

  const facts = (rows: [string, string | undefined][]): DetailFact[] =>
    rows.filter((row): row is [string, string] => Boolean(row[1]?.trim())).map(([label, value]) => ({ label, value }));

  const sections = [
    {
      facts: facts([
        ["Date of birth", details.dateOfBirth],
        ["Gender", details.gender ? (GENDER_LABELS[details.gender] ?? details.gender) : undefined],
        ["Blood group", details.bloodGroup],
        ["Food", details.food ? (FOOD_LABELS[details.food] ?? details.food) : undefined],
        ["Disease", details.medicalNotes],
      ]),
      title: "Personal",
    },
    {
      facts: facts([
        ["District", details.district],
        ["Municipality", details.municipality],
        ["Ward no.", details.wardNo],
        ["Street / Tole", details.tole],
      ]),
      title: "Address",
    },
    {
      facts: facts([
        ["Citizenship no.", details.citizenshipNo],
        ["Issued on", details.citizenshipIssuedOn],
        ["Issued at", details.citizenshipIssuedAt],
      ]),
      title: "Citizenship",
    },
    {
      facts: facts([
        ["Institute", details.institution],
        ["Level", details.levelOfStudy],
        ["Class time", details.classTime],
        ["Staying for", details.stayDuration],
      ]),
      title: "Study",
    },
    {
      facts: [
        ...(details.family ?? []).map((entry) => person(entry.relation, entry)),
        ...(details.localGuardian
          ? [person(`Local guardian · ${details.localGuardian.relation}`, details.localGuardian)]
          : []),
      ],
      title: "Family",
    },
  ];

  return sections.filter((section) => section.facts.length > 0);
}
