/**
 * The hostel registration application, as a value.
 *
 * ## What this is a port of
 *
 * `apps/web/src/app/_components/public-hostel-registration-page.tsx` — 3,300
 * lines, five steps, one `POST /public/hostels/register`. Everything in that file
 * that is a *decision* (which fields, which are required, which step each belongs
 * to, what the request body looks like) lives here, so the screen is layout and
 * this is testable. Everything in it that is desktop furniture — the draft
 * autosave to `localStorage`, the sidebar of portal cards, the plan price
 * calculator with its 10% VAT line — is not ported.
 *
 * The payload is typed from `hostelRegistrationSchema`
 * (`apps/web/src/modules/hostels/hostel-registration.validation.ts`), not from
 * the web component. That schema now declares `landmark`, `mapLink` and the
 * pin's `location.lat`/`lng`/`locationSource`, and the hostel document stores
 * all of them, so the location step sends them as fields.
 *
 * ## Why the required set is the website's and not the schema's
 *
 * The schema asks for very little — a name, an area, an applicant name and
 * phone. The website asks for a great deal more, and the two extra requirements
 * that look like padding are the two that decide whether the application can be
 * *processed*:
 *
 * - **Owner email.** The server creates the owner `User` from it. Without one,
 *   `resolveHostelOwner` bails and the approval never reaches anybody — the
 *   application is accepted and then silently unfinishable.
 * - **A government ID and a rules document.** A platform reviewer approves a
 *   business that will hold other people's rent and house their children. An
 *   application with no identity document attached is one they have to reject.
 *
 * Both are satisfiable on a phone here, which is the whole reason this flow
 * exists: the ID is photographed with the camera, and the rules document is
 * generated from one of the templates below (see `uploadPublicText`). On the
 * website both mean "go and find a file", which is fine at a desk and is what
 * sent the phone to a browser tab.
 */

export const HOSTEL_TYPES = [
  { label: "Boys only", value: "BOYS" },
  { label: "Girls only", value: "GIRLS" },
  { label: "Co-living", value: "CO_LIVING" },
] as const;

export type HostelTypeValue = (typeof HOSTEL_TYPES)[number]["value"];

export const CITY_OPTIONS = [
  "Kathmandu",
  "Lalitpur",
  "Bhaktapur",
  "Pokhara",
  "Butwal",
  "Biratnagar",
  "Dharan",
  "Chitwan",
  "Birgunj",
  "Nepalgunj",
] as const;

export { ROOM_TYPE_OPTIONS } from "@hostel/constants/room-types";

export const MEAL_INCLUSIONS = ["Included", "Not Included", "Optional"] as const;

export type MealInclusion = (typeof MEAL_INCLUSIONS)[number];

export const FACILITY_OPTIONS = [
  "WiFi",
  "Hot water",
  "Parking",
  "Laundry",
  "Gym",
  "Study table",
  "Attached bathroom",
  "AC",
  "CCTV",
  "Power backup",
  "Kitchen",
  "Common room",
] as const;

export const ID_PROOF_TYPES = [
  "Citizenship",
  "National Identity Card (NID)",
  "Passport",
] as const;

export type IdProofType = (typeof ID_PROOF_TYPES)[number];

/** The website's three plans, id and name only — the phone does not price them. */
export const HOSTEL_PLANS = [
  {
    id: "starter",
    name: "Starter Plan",
    summary: "For a small hostel getting started. Public listing and the basics.",
  },
  {
    id: "pro",
    name: "Pro Plan",
    summary: "Priority listing, analytics, several staff accounts, priority support.",
  },
  {
    id: "enterprise",
    name: "Enterprise Plan",
    summary: "Unlimited branches, beds and staff, with a dedicated manager.",
  },
] as const;

export type PlanId = (typeof HOSTEL_PLANS)[number]["id"];

/**
 * The house-rules templates, ported from the website's `RULES_TEMPLATES`.
 *
 * Verbatim, and that is the point. The rules document is part of the application
 * a platform reviewer reads, so an owner who registers from the app and one who
 * registers from a desk have to be submitting the same document — a second,
 * paraphrased set of house rules for phone applicants would be a second policy.
 */
export type RulesTemplate = {
  body: string;
  id: string;
  name: string;
  summary: string;
};

export const RULES_TEMPLATES: RulesTemplate[] = [
  {
    body: [
      "HOSTEL RULES & POLICIES",
      "",
      "1. Entry & Exit",
      "   - Main gate closes at 10:00 PM. Late entry requires prior warden approval.",
      "   - Residents must sign the in/out register when leaving overnight.",
      "",
      "2. Visitors",
      "   - Visitors are allowed only in the common area between 9:00 AM and 7:00 PM.",
      "   - Visitors are not permitted inside resident rooms.",
      "",
      "3. Conduct",
      "   - Smoking, alcohol, and any illegal substances are strictly prohibited.",
      "   - Maintain silence after 10:00 PM to respect fellow residents.",
      "",
      "4. Payments",
      "   - Monthly rent is due within the first 5 days of each month.",
      "   - A one-month security deposit is required at the time of admission.",
      "",
      "5. Property & Safety",
      "   - Residents are responsible for damage to hostel property.",
      "   - Report any maintenance or safety issue to the warden immediately.",
    ].join("\n"),
    id: "standard",
    name: "Standard House Rules",
    summary: "General discipline, timings, visitors, and payment terms.",
  },
  {
    body: [
      "HOSTEL RULES & POLICIES (STUDENT / STRICT)",
      "",
      "1. Study Environment",
      "   - Study hours 7:00 PM - 9:00 PM are strictly quiet hours.",
      "   - No loud music or gatherings on weekdays.",
      "",
      "2. Timings",
      "   - Gate closes at 9:00 PM on weekdays, 10:00 PM on weekends.",
      "   - Attendance is taken every night; guardians are notified of absences.",
      "",
      "3. Visitors & Guests",
      "   - Opposite-gender visitors are not allowed beyond the reception.",
      "   - Overnight guests are not permitted.",
      "",
      "4. Prohibited",
      "   - Smoking, alcohol, drugs, and weapons are strictly banned.",
      "   - Cooking inside rooms is not allowed.",
      "",
      "5. Discipline",
      "   - Repeated violations may lead to termination of accommodation.",
      "   - Rent must be cleared by the 5th of every month.",
    ].join("\n"),
    id: "student-strict",
    name: "Student Hostel (Strict)",
    summary: "Stricter timings, study hours, and guardian notifications.",
  },
  {
    body: [
      "HOSTEL RULES & POLICIES (FLEXIBLE / WORKING PROFESSIONALS)",
      "",
      "1. Access",
      "   - 24/7 access with secure keycard/biometric entry.",
      "   - Please be considerate of others when returning late.",
      "",
      "2. Common Areas",
      "   - Kitchen and lounge are shared - clean up after use.",
      "   - Quiet hours are observed from 11:00 PM to 6:00 AM.",
      "",
      "3. Visitors",
      "   - Guests are welcome in common areas until 9:00 PM.",
      "   - Inform reception in advance for any guest.",
      "",
      "4. Payments",
      "   - Rent is due by the 7th of each month.",
      "   - One-month deposit, refundable on proper checkout with notice.",
      "",
      "5. Community",
      "   - No smoking indoors; designated areas only.",
      "   - Respect shared spaces and fellow residents.",
    ].join("\n"),
    id: "flexible",
    name: "Working Professionals (Flexible)",
    summary: "24/7 access, shared spaces, lighter restrictions.",
  },
];

/* -------------------------------------------------------------------------- */
/* The form                                                                   */
/* -------------------------------------------------------------------------- */

/** Numbers stay strings while they are being typed — see `numberValue`. */
export type RoomRow = {
  bedsPerRoom: string;
  id: string;
  mealInclusion: MealInclusion;
  monthlyRent: string;
  rooms: string;
  roomType: string;
  vacantBeds: string;
};

export type HostelAttachment = {
  /** Private documents only — what the application submits. See `PublicFile`. */
  claimToken?: string;
  fileAssetId?: string;
  fileName: string;
  url: string;
};

/** "Do you offer short stays?" Daily rates keyed by the room type's name as typed. */
export type ShortStayForm = { enabled: boolean; minNights: string; rates: Record<string, string> };

export type HostelForm = {
  address: string;
  admissionFee: string;
  formFee: string;
  agreed: boolean;
  area: string;
  city: string;
  description: string;
  email: string;
  facilities: string[];
  hostelName: string;
  hostelType: HostelTypeValue;
  idProof: HostelAttachment | null;
  idProofType: IdProofType | "";
  landmark: string;
  /** A Google Maps share link, kept exactly as pasted and shown on the listing. */
  mapLink: string;
  mealsPerDay: string;
  ownerName: string;
  /** The business's PAN/VAT number — optional, nine digits. */
  panNumber: string;
  /**
   * Where the pin sits — optional, read from the owner's pasted Maps link. It is
   * their own placement, so it is submitted as `MANUAL`, which is what
   * stops the nightly nearby-places sweep sliding it back to the tole's centre.
   *
   * Spelled out rather than imported from `lib/geo`: this module has no imports
   * so `apps/web`'s contract test can load it (see
   * `mobile-registration-contract.test.ts`).
   */
  pin: { lat: number; lng: number } | null;
  /** Free text, one rule per line. Also what a chosen template fills in. */
  rules: string;
  rulesDocument: HostelAttachment | null;
  ownerPhone: string;
  photos: HostelAttachment[];
  rooms: RoomRow[];
  selectedPlan: PlanId;
  servesNonVeg: boolean;
  servesVeg: boolean;
  shortStays: ShortStayForm;
  totalFloors: string;
};

export function emptyRoomRow(id: string, roomType = "Single Room"): RoomRow {
  return {
    bedsPerRoom: "",
    id,
    mealInclusion: "Included",
    monthlyRent: "",
    rooms: "",
    roomType,
    vacantBeds: "",
  };
}

export function emptyHostelForm(firstRoomId: string): HostelForm {
  return {
    address: "",
    admissionFee: "",
    formFee: "",
    agreed: false,
    area: "",
    city: "Kathmandu",
    description: "",
    email: "",
    facilities: [],
    hostelName: "",
    hostelType: "CO_LIVING",
    idProof: null,
    idProofType: "",
    landmark: "",
    mapLink: "",
    mealsPerDay: "2",
    ownerName: "",
    ownerPhone: "",
    panNumber: "",
    photos: [],
    pin: null,
    rooms: [emptyRoomRow(firstRoomId)],
    rules: "",
    rulesDocument: null,
    selectedPlan: "pro",
    servesNonVeg: true,
    servesVeg: true,
    shortStays: { enabled: false, minNights: "1", rates: {} },
    totalFloors: "",
  };
}

export const HOSTEL_STEPS = [
  { key: "basics", label: "Basics" },
  { key: "location", label: "Location" },
  { key: "rooms", label: "Rooms" },
  { key: "documents", label: "Documents" },
  { key: "review", label: "Review" },
] as const;

export type HostelStepKey = (typeof HOSTEL_STEPS)[number]["key"];

export type HostelErrors = Partial<Record<keyof HostelForm, string>>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function hostelStepErrors(
  step: HostelStepKey,
  form: HostelForm,
): HostelErrors {
  const errors: HostelErrors = {};

  if (step === "basics") {
    if (form.hostelName.trim().length < 2) {
      errors.hostelName = "What is the hostel called?";
    }

    if (!form.description.trim()) {
      errors.description = "A couple of lines about the place — residents read this.";
    }

    if (form.ownerName.trim().length < 2) {
      errors.ownerName = "Who owns or runs it?";
    }

    if (form.ownerPhone.trim().length < 7) {
      errors.ownerPhone = "A phone number we can reach you on.";
    }

    if (form.panNumber.trim() && !/^\d{9}$/.test(form.panNumber.replace(/\s/g, ""))) {
      errors.panNumber = "A PAN/VAT number is 9 digits.";
    }

    /*
     * Not optional, though the schema says it is. The server creates the owner's
     * account from this address and the approval email is sent to it; an
     * application without one is accepted and can then never be completed.
     */
    if (!EMAIL_PATTERN.test(form.email.trim())) {
      errors.email = "We send the approval here, so it has to be a real address.";
    }
  }

  if (step === "location") {
    if (!form.address.trim()) {
      errors.address = "Street or tole — enough for someone to find the door.";
    }

    if (form.area.trim().length < 2) {
      errors.area = "Which area is it in?";
    }

    if (form.city.trim().length < 2) {
      errors.city = "Which city?";
    }  }

  if (step === "rooms" && form.formFee?.trim() && (!Number.isInteger(Number(form.formFee)) || Number(form.formFee) < 0)) {
    errors.formFee = "Enter a non-negative form fee in whole rupees.";
  }

  if (step === "rooms" && !hasUsableRooms(form.rooms)) {
    errors.rooms = "Add at least one room type with a room count and beds per room.";
  }

  if (step === "documents") {
    if (!form.idProofType) {
      errors.idProofType = "Which ID are you attaching?";
    }

    if (!form.idProof) {
      errors.idProof = "Photograph your ID — the platform team verifies it.";
    }

    if (!form.rulesDocument) {
      errors.rulesDocument = "Attach your house rules, or start from a template.";
    }
  }

  if (step === "review" && !form.agreed) {
    errors.agreed = "Confirm the details are yours before submitting.";
  }

  return errors;
}

export function hasHostelErrors(errors: HostelErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function isHostelStepComplete(step: HostelStepKey, form: HostelForm): boolean {
  return !hasHostelErrors(hostelStepErrors(step, form));
}

export function firstIncompleteHostelStep(form: HostelForm): HostelStepKey | null {
  return HOSTEL_STEPS.find((step) => !isHostelStepComplete(step.key, form))?.key ?? null;
}

/** A row counts once it names a type and declares both counts above zero. */
function hasUsableRooms(rooms: RoomRow[]): boolean {
  return rooms.some(
    (room) =>
      Boolean(room.roomType.trim()) &&
      (numberValue(room.rooms) ?? 0) > 0 &&
      (numberValue(room.bedsPerRoom) ?? 0) > 0,
  );
}

/**
 * A typed field as a number, or `undefined`.
 *
 * `undefined` and not `0`: the schema's optional numbers mean "not stated", and
 * an unstated admission fee submitted as `0` is a claim that the hostel charges
 * nothing to move in.
 */
export function numberValue(value: string): number | undefined {
  const parsed = Number(value.trim());

  return value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

/** Beds and rooms across every usable row — the review step's headline. */
export function capacitySummary(rooms: RoomRow[]) {
  return rooms.reduce(
    (total, room) => {
      const count = numberValue(room.rooms) ?? 0;
      const beds = numberValue(room.bedsPerRoom) ?? 0;

      return {
        totalBeds: total.totalBeds + count * beds,
        totalRooms: total.totalRooms + count,
        vacantBeds: total.vacantBeds + (numberValue(room.vacantBeds) ?? 0),
      };
    },
    { totalBeds: 0, totalRooms: 0, vacantBeds: 0 },
  );
}

/* -------------------------------------------------------------------------- */
/* The payload                                                                */
/* -------------------------------------------------------------------------- */

export type HostelRegisterPayload = {
  applicant: { email?: string; name: string; phone: string };
  capacitySummary: { totalBeds: number; totalRooms: number; vacantBeds: number };
  contact: { email?: string; phone: string };
  description?: string;
  documents: { claimToken: string; documentType: string; fileAssetId: string }[];
  facilities: string[];
  food: { hasNonVeg: boolean; hasVeg: boolean; mealsPerDay?: number };
  hostelType: HostelTypeValue;
  /** Where booking payouts go (docs/BOOKINGS.md item 26). Optional; checked by the platform before any payout. */
  payoutAccount?: {
    bankName: string;
    branch: string;
    holderName: string;
    method: "BANK" | "ESEWA" | "KHALTI";
    number: string;
  };
  landmark?: string;
  location: {
    address?: string;
    area: string;
    city: string;
    lat?: number;
    lng?: number;
    locationSource?: "MANUAL";
  };
  mapLink?: string;
  name: string;
  notes: string;
  panNumber?: string;
  photos: { alt: string; url: string }[];
  pricing: {
    admissionFee?: number;
    formFee?: number;
    currency: string;
    monthlyRentMax?: number;
    monthlyRentMin?: number;
  };
  /** Another hostel's or a partner's code, checked on `register-hostel/index`. */
  referralCode?: string;
  roomConfigurations: {
    bedsPerRoom: number;
    mealInclusion: MealInclusion;
    monthlyRent?: number;
    rooms: number;
    roomType: string;
    vacantBeds: number;
  }[];
  roomTypes: string[];
  rules: string[];
  selectedPlan: string;
  shortStays?: { enabled: boolean; minNights: number; rates: { dailyRate: number; roomType: string }[] };
  totalFloors?: number;
};

/**
 * The request body for `POST /public/hostels/register`.
 *
 * `monthlyRentMin`/`Max` are **derived** from the room rows rather than typed,
 * exactly as the website derives them: an owner who states a range and then lists
 * rooms priced outside it has published a price the platform will contradict on
 * the listing page, and there is no version of that which is the owner's fault.
 *
 * `notes` is the free-text carrier for the few answers the schema has no field
 * for — floors, the landmark, the plan they picked. Same `·`-joined line the
 * website builds, so a reviewer reads one format.
 */
export function buildHostelPayload(form: HostelForm): HostelRegisterPayload {
  const roomConfigurations = form.rooms
    .filter((room) => room.roomType.trim())
    .map((room) => ({
      bedsPerRoom: numberValue(room.bedsPerRoom) ?? 0,
      mealInclusion: room.mealInclusion,
      monthlyRent: numberValue(room.monthlyRent),
      rooms: numberValue(room.rooms) ?? 0,
      roomType: room.roomType.trim(),
      vacantBeds: numberValue(room.vacantBeds) ?? 0,
    }));

  const rents = roomConfigurations
    .map((room) => room.monthlyRent)
    .filter((rent): rent is number => typeof rent === "number");

  const name = form.hostelName.trim();
  const email = form.email.trim() || undefined;
  const phone = form.ownerPhone.trim();

  return {
    applicant: { email, name: form.ownerName.trim(), phone },
    capacitySummary: capacitySummary(form.rooms),
    contact: { email, phone },
    description: form.description.trim() || undefined,
    documents: [
      ...(form.idProof?.fileAssetId && form.idProof.claimToken
        ? [
            {
              claimToken: form.idProof.claimToken,
              documentType: form.idProofType || "Owner ID proof",
              fileAssetId: form.idProof.fileAssetId,
            },
          ]
        : []),
      ...(form.rulesDocument?.fileAssetId && form.rulesDocument.claimToken
        ? [
            {
              claimToken: form.rulesDocument.claimToken,
              documentType: "Rules & policies",
              fileAssetId: form.rulesDocument.fileAssetId,
            },
          ]
        : []),
    ],
    facilities: form.facilities,
    food: {
      hasNonVeg: form.servesNonVeg,
      hasVeg: form.servesVeg,
      mealsPerDay: numberValue(form.mealsPerDay),
    },
    hostelType: form.hostelType,
    landmark: form.landmark.trim() || undefined,
    location: {
      address: form.address.trim() || undefined,
      area: form.area.trim(),
      city: form.city.trim(),
      ...(form.pin
        ? { lat: form.pin.lat, lng: form.pin.lng, locationSource: "MANUAL" as const }
        : {}),
    },
    mapLink: form.mapLink.trim() || undefined,
    name,
    notes: [
      form.landmark.trim() ? `Landmark: ${form.landmark.trim()}` : "",
      `Floors: ${numberValue(form.totalFloors) ?? 1}`,
      // No plan line: the app no longer asks for one, so it would read as a choice the owner never made.
      "Submitted from the mobile app",
    ]
      .filter(Boolean)
      .join(" · "),
    panNumber: form.panNumber.replace(/\s/g, "") || undefined,
    photos: form.photos.map((photo) => ({ alt: `${name} - Photo`, url: photo.url })),
    pricing: {
      admissionFee: numberValue(form.admissionFee),
      formFee: numberValue(form.formFee),
      currency: "NPR",
      monthlyRentMax: rents.length > 0 ? Math.max(...rents) : undefined,
      monthlyRentMin: rents.length > 0 ? Math.min(...rents) : undefined,
    },
    roomConfigurations,
    roomTypes: roomConfigurations.map((room) => room.roomType),
    /*
     * `textArraySchema` caps each entry at **80 characters** and the array at
     * **40**. A house rule typed as a paragraph would therefore 422 the whole
     * application over a field nobody would look at twice, so long lines are cut
     * to fit rather than allowed to fail — the untouched text is attached as the
     * rules document either way, and that is the copy anyone actually reads.
     */
    rules: form.rules
      .split(/\r?\n/)
      .map((line) => line.trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 40),
    selectedPlan: form.selectedPlan,
    shortStays: form.shortStays.enabled
      ? {
          enabled: true,
          minNights: numberValue(form.shortStays.minNights) ?? 1,
          rates: roomConfigurations
            .map((room) => ({ dailyRate: numberValue(form.shortStays.rates[room.roomType] ?? "") ?? 0, roomType: room.roomType }))
            .filter((rate) => rate.dailyRate > 0),
        }
      : undefined,
    totalFloors: numberValue(form.totalFloors),
  };
}
