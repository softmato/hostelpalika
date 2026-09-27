"use client";

import {
  ArrowLeft,
  AlertTriangle,
  ArrowRight,
  Banknote,
  Building2,
  Check,
  CreditCard,
  FileText,
  IdCard,
  Landmark,
  ScrollText,
  ImagePlus,
  Loader2,
  Plus,
  QrCode,
  Save,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  cloneElement,
  type ChangeEvent,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useState,
  type ReactElement,
} from "react";

import { useCheckoutHandoff } from "@/app/_components/checkout-handoff";
import { useConfirm } from "@/app/_components/confirm-dialog";
import { MEAL_TIMING_DEFAULTS } from "@hostel/shared/food/meal-window";

import { LocationPicker, type LocationPickerValue } from "@/components/maps/location-picker";
import { useMediaViewer } from "@/components/media-viewer";
import { useSiteConfig } from "@/components/site-config-provider";
import {
  EMPTY_PAYOUT_DRAFT,
  PayoutAccountFields,
  payoutAccountPayload,
} from "@/components/bookings/payout-account-fields";
import { ApiRequestError, browserApi } from "@/lib/browser-api";
import { acceptAttribute } from "@/lib/uploads/accepts";
import { uploadRegistrationDocument } from "@/lib/uploads/registration-document";
import { uploadFile } from "@/lib/uploads/uploader";
import { cn } from "@/lib/utils";
import { readRenamedStorage } from "@/lib/storage-rename";
import {
  EMPTY_SHORT_STAYS,
  RegistrationShortStays,
  shortStaysPayload,
  type ShortStayDraft,
} from "@/app/_components/registration-short-stays";
import type { TeamOwnerEmailStatus } from "@/modules/hostels/hostel.service";
import type { TeamPrepaymentView } from "@/modules/team/team-prepayment.service";
import { DescriptionSuggestions } from "./description-suggestions";
import { billingCycles, bestDiscountPercent, cycleTotal, type BillingCycle } from "./plans-catalog";
import {
  cityOptions,
  DocRow as DocSlotRow,
  FileUploadArea,
  isUploadedFile,
  submittedDocuments,
  ID_PROOF_TYPES,
  type IdProofType,
  facilityOptions,
  BEDS_BY_ROOM_TYPE,
  editRoomRow,
  numberValue,
  roomTypeOptions,
  RULES_TEMPLATES,
  rupees,
} from "./registration-fields";
import { StepFlow, StepRail, type RegistrationStep } from "./registration-step-shell";
import { PLATFORM_NAME } from "@hostel/shared/brand/brand";

/**
 * The field team's registration form.
 *
 * ## Why this is a flow now and not one dense page
 *
 * It used to be a single long page, on the argument that an agent filling it in
 * for the fifteenth time does not need to be guided. That argument was right
 * about the agent and wrong about the form: this one now collects a whole
 * hostel — photos by kind, house rules, the food routine, per-room pricing,
 * documents, the plan and the money — because a hostel our own staff registered
 * should not go live thinner than one an owner filled in themselves at midnight.
 *
 * Forty fields with no rail tells nobody how much is left. So it wears the same
 * shell as the public form, for the same reason: the journey stays visible while
 * exactly one thing is asked at a time. What stays different is the manner —
 * no reassurance panels, no explanations of why we need a citizenship document.
 * The agent knows. The rail is scaffolding, not hand-holding.
 *
 * ## The two things this form has that the public one does not
 *
 * The plan is chosen **here** and the money is taken **here**, because the agent
 * is with the owner and both happen in that conversation. And submitting
 * publishes the hostel on the spot — which is why the last step is a decision
 * rather than a button, and why it is the only step that cannot be skipped past.
 */

type RoomRow = {
  bedsPerRoom: string;
  id: string;
  monthlyRent: string;
  rooms: string;
  roomType: string;
  vacantBeds: string;
};

type PhotoKind = "EXTERIOR" | "INTERIOR" | "ROOM";

type PhotoRow = {
  id: string;
  kind: PhotoKind;
  name: string;
  roomType?: string;
  uploading: boolean;
  url: string;
};

type DocRow = {
  claimToken?: string;
  fileAssetId?: string;
  id: string;
  name: string;
  type: string;
  uploading: boolean;
  url: string;
};

/** The same optional slots the public form offers, in the same order. */
const SUPPORTING_DOCS: { desc: string; icon: LucideIcon; title: string; type: string }[] = [
  {
    desc: "Property deed, ownership certificate or lease (optional)",
    icon: FileText,
    title: "Ownership Proof",
    type: "Ownership proof",
  },
  {
    desc: "PAN card or VAT registration certificate (optional)",
    icon: CreditCard,
    title: "PAN / VAT Document",
    type: "PAN / VAT document",
  },
  {
    desc: "Local authority license or registration (optional)",
    icon: ScrollText,
    title: "Hostel License / Registration",
    type: "Hostel license",
  },
  {
    desc: "Cheque or bank statement for the payout account (optional)",
    icon: Landmark,
    title: "Bank Details",
    type: "Bank account details",
  },
];

/** An ID upload is filed under its ID type, or "Owner ID proof" before one is picked. */
function isIdDocument(type: string) {
  return type === "Owner ID proof" || (ID_PROOF_TYPES as readonly string[]).includes(type);
}

const MEAL_TYPES = ["BREAKFAST", "LUNCH", "SNACKS", "DINNER"] as const;
type MealType = (typeof MEAL_TYPES)[number];

const ROUTINE_DAYS = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;
type RoutineDay = (typeof ROUTINE_DAYS)[number];

/** `SUNDAY` → `Sun`. The rail is tight and the full names do not fit. */
function shortDay(day: RoutineDay) {
  return day.charAt(0) + day.slice(1, 3).toLowerCase();
}

function titleCase(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

const DRAFT_KEY = "hostelpalika:team-registration-draft";
/* Pre-rename spelling, moved up on first read: this holds an agent's
 * unfinished registration and nothing else has a copy of it. */
const LEGACY_DRAFT_KEY = "hostelhub:team-registration-draft";

/**
 * Bumped whenever a stored draft can no longer be read at face value.
 *
 * Version 2 is the arrival of the sample week. Drafts written before it hold an
 * empty routine — either absent, or, if somebody pressed "use this day for every
 * day" on a blank day, twenty-eight explicit empty strings. An empty string is
 * meaningful now: it is a cell the agent cleared on purpose, for a hostel that
 * genuinely serves no snacks. So the two cannot be told apart by looking at the
 * values, and the older draft's routine is discarded rather than guessed at.
 *
 * Only the routine is discarded. Everything else in an old draft — the hostel,
 * the owner, the rooms, the uploads — is still exactly what the agent typed, and
 * throwing that away to fix a menu would be the worse trade by a wide margin.
 */
const DRAFT_VERSION = 2;

/**
 * A typical Nepali hostel week, pre-filled so the agent edits rather than types.
 *
 * Twenty-eight cells is a lot to fill from a conversation, and the answer to
 * most of them is the same in most hostels — dal bhat twice, tea with something
 * at four. Starting from that and correcting the differences is both faster and
 * more accurate than an empty grid, because it prompts the questions ("do you do
 * eggs on Friday?") instead of relying on the agent to think of them.
 *
 * ## The obvious hazard, and what is done about it
 *
 * A default that is never looked at becomes a menu the hostel never agreed to.
 * These are real values, not placeholders, so an agent who skips the step
 * publishes this week as fact. The review step therefore checks whether the
 * routine is still untouched and says so — see `recommendations`. It does not
 * block: a routine that happens to match the sample is a routine, and a hostel
 * that genuinely serves dal bhat twice a day should not have to retype it to
 * prove they meant it.
 */
/*
 * The same four strings the hostel's own Food & Menu screen seeds, imported
 * rather than restated. A hostel our agent registered should not open with
 * different serving times from one the owner set up themselves — and
 * `MEAL_ANNOUNCE_LEAD_MINUTES` is documented against *these* windows never
 * overlapping, which a second set of defaults would quietly break.
 */
const DEFAULT_TIMINGS: Record<MealType, string> = MEAL_TIMING_DEFAULTS;

const DEFAULT_WEEK: Record<RoutineDay, Record<MealType, string>> = {
  SUNDAY: {
    BREAKFAST: "Roti, Aloo Tarkari, Tea",
    LUNCH: "Dal, Bhat, Tarkari, Achar",
    SNACKS: "Chiura, Tea",
    DINNER: "Dal, Bhat, Tarkari",
  },
  MONDAY: {
    BREAKFAST: "Bread, Jam, Tea",
    LUNCH: "Dal, Bhat, Tarkari, Achar",
    SNACKS: "Biscuit, Tea",
    DINNER: "Dal, Bhat, Saag",
  },
  TUESDAY: {
    BREAKFAST: "Roti, Tarkari, Tea",
    LUNCH: "Dal, Bhat, Tarkari",
    SNACKS: "Chana, Tea",
    DINNER: "Dal, Bhat, Tarkari, Achar",
  },
  WEDNESDAY: {
    BREAKFAST: "Paratha, Tea",
    LUNCH: "Dal, Bhat, Tarkari, Achar",
    SNACKS: "Chiura, Tea",
    DINNER: "Dal, Bhat, Anda Curry",
  },
  THURSDAY: {
    BREAKFAST: "Roti, Aloo Tarkari, Tea",
    LUNCH: "Dal, Bhat, Tarkari",
    SNACKS: "Chowmein, Tea",
    DINNER: "Dal, Bhat, Saag",
  },
  FRIDAY: {
    BREAKFAST: "Bread, Anda, Tea",
    LUNCH: "Dal, Bhat, Tarkari, Achar",
    SNACKS: "Chiura, Tea",
    DINNER: "Dal, Bhat, Masu",
  },
  SATURDAY: {
    BREAKFAST: "Puri, Tarkari, Tea",
    LUNCH: "Dal, Bhat, Tarkari, Achar",
    SNACKS: "Sel Roti, Tea",
    DINNER: "Dal, Bhat, Tarkari",
  },
};

/** The flat `DAY:MEAL` shape the form edits in. */
function defaultRoutine(): Record<string, string> {
  const cells: Record<string, string> = {};

  for (const day of ROUTINE_DAYS) {
    for (const meal of MEAL_TYPES) {
      cells[`${day}:${meal}`] = DEFAULT_WEEK[day][meal];
    }
  }

  return cells;
}

const STEPS: RegistrationStep[] = [
  {
    description: "Who owns it, and what the place is called.",
    key: 1,
    label: "Owner & hostel",
  },
  { description: "Address, area, and how to find the door.", key: 2, label: "Where it is" },
  {
    description: "Room types, how many of each, and the rent.",
    key: 3,
    label: "Rooms & pricing",
  },
  {
    description: "Outside, inside, and each kind of room.",
    key: 4,
    label: "Photos",
  },
  {
    description: "Facilities, meals and the weekly routine.",
    key: 5,
    label: "Facilities & food",
  },
  {
    description: "Owner ID, house rules, and whatever else they handed you.",
    key: 6,
    label: "Documents & rules",
  },
  {
    description: "What they are buying, and what you collected.",
    key: 7,
    label: "Plan & payment",
  },
  { description: "Check it, then put the hostel live.", key: 8, label: "Review & publish" },
];

function newRoom(): RoomRow {
  return {
    bedsPerRoom: String(BEDS_BY_ROOM_TYPE["Single Room"]),
    id: crypto.randomUUID(),
    monthlyRent: "",
    rooms: "",
    roomType: "Single Room",
    vacantBeds: "",
  };
}

function Card({
  children,
  subtitle,
  title,
}: {
  children: React.ReactNode;
  subtitle?: string;
  title: string;
}) {
  return (
    <section className="app-card p-5">
      <h2 className="text-base font-bold text-foreground">{title}</h2>
      {subtitle ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
      ) : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/* ── Field errors ──────────────────────────────────────────────────────────
 *
 * A registration the server refuses has to say *which* box is wrong, on the
 * step that box lives on, with the cursor already in it. "Validation failed"
 * across the top of the review step told an agent standing in a lobby nothing —
 * the server knew it was the phone number and the form threw that away.
 *
 * Every input that can be wrong carries a `data-field` name. The server's zod
 * paths (`contact.phone`, `roomConfigurations.2.bedsPerRoom`) and the form's own
 * checks both resolve to one of those names, which gives three things from one
 * key: the step to open, the element to focus, and where to print the message.
 */

const ROOM_KEY_LABEL = {
  bedsPerRoom: "Beds each",
  monthlyRent: "Rent",
  rooms: "Rooms",
  roomType: "Room type",
  vacantBeds: "Vacant",
} as const;

type RoomKey = keyof typeof ROOM_KEY_LABEL;

/** Which step each named field lives on. Room and routine cells are prefixed. */
const FIELD_STEP: Record<string, number> = {
  address: 2,
  admissionFee: 3,
  alternatePhone: 1,
  amount: 7,
  area: 2,
  city: 2,
  cookCount: 5,
  description: 1,
  documents: 6,
  email: 1,
  facilities: 5,
  foodNotes: 5,
  hostelName: 1,
  landmark: 2,
  mapLink: 2,
  mealsPerDay: 5,
  ownerName: 1,
  paymentReference: 7,
  phone: 1,
  photos: 4,
  pin: 2,
  payout: 7,
  plan: 7,
  referralDiscount: 3,
  rooms: 3,
  routine: 5,
  rules: 6,
  securityDeposit: 3,
  panNumber: 1,
  totalFloors: 1,
  yearEstablished: 1,
};

const FIELD_LABEL: Record<string, string> = {
  address: "Address line",
  admissionFee: "Admission fee",
  alternatePhone: "Alternate phone",
  amount: "Amount collected",
  area: "Area",
  city: "City",
  cookCount: "Cooks",
  description: "Description",
  documents: "Documents",
  email: "Owner email",
  facilities: "Facilities",
  foodNotes: "Food notes",
  hostelName: "Hostel name",
  landmark: "Landmark",
  mapLink: "Maps link",
  mealsPerDay: "Meals a day",
  ownerName: "Owner name",
  paymentReference: "Payment reference",
  phone: "Owner phone",
  photos: "Photos",
  pin: "Map pin",
  payout: "Payout account",
  plan: "Plan",
  referralDiscount: "Referral discount",
  rooms: "Room types",
  routine: "Weekly routine",
  rules: "House rules",
  securityDeposit: "Security deposit",
  panNumber: "PAN/VAT number",
  totalFloors: "Floors",
  yearEstablished: "Year established",
};

function stepOfField(field: string) {
  if (field.startsWith("room:")) return 3;
  if (field.startsWith("timing:") || field.startsWith("routine:")) return 5;

  return FIELD_STEP[field] ?? 1;
}

function phoneValid(value: string) {
  const length = value.trim().length;

  return length >= 7 && length <= 24;
}

/**
 * Zod's wording, in the words an agent would use.
 *
 * "Too small: expected string to have >=7 characters" is accurate and useless in
 * a lobby. Our own custom messages ("Year established should be four digits.")
 * are already sentences and pass straight through.
 */
function plainMessage(message: string, field: string) {
  const unit = field === "phone" || field === "alternatePhone" ? "digits" : "characters";
  const bound = message.match(/([<>]=?)\s*(-?\d+)/)?.[2];

  if (/^too small/i.test(message) && bound) {
    if (/string/i.test(message)) return `Needs at least ${bound} ${unit}.`;
    if (/array|set/i.test(message)) return `Needs at least ${bound}.`;

    return `Must be ${bound} or more.`;
  }

  if (/^too big/i.test(message) && bound) {
    if (/string/i.test(message)) return `Can be at most ${bound} ${unit}.`;
    if (/array|set/i.test(message)) return `No more than ${bound}.`;

    return `Must be ${bound} or less.`;
  }

  if (/invalid email/i.test(message)) return "That is not a valid email address.";
  if (/invalid url/i.test(message)) return "Has to be a full link, starting with https://.";
  if (/expected number/i.test(message)) return "Has to be a number.";
  if (/^invalid/i.test(message)) return "This is not a value we can accept.";

  return message;
}

/** The field-level issues a 422 carries, or nothing if this was not one. */
function validationIssues(error: unknown) {
  if (!(error instanceof ApiRequestError) || error.errorCode !== "VALIDATION_ERROR") {
    return [];
  }

  const issues = (error.details as { issues?: unknown } | undefined)?.issues;

  return Array.isArray(issues)
    ? issues.filter(
        (issue): issue is { message: string; path: string } =>
          typeof issue?.path === "string" && typeof issue?.message === "string",
      )
    : [];
}

type FieldErrors = Partial<Record<string, string>>;

const FieldErrorContext = createContext<{
  clear: (field: string) => void;
  errors: FieldErrors;
}>({ clear: () => {}, errors: {} });

function fieldErrorId(field: string) {
  return `field-error-${field.replace(/[^a-z0-9-]/gi, "-")}`;
}

function FieldError({ name }: { name: string }) {
  const { errors } = useContext(FieldErrorContext);
  const error = errors[name];

  return error ? (
    <span
      className="mt-1 block text-[11px] font-semibold text-destructive"
      id={fieldErrorId(name)}
    >
      {error}
    </span>
  ) : null;
}

function Field({
  children,
  hint,
  label,
  name,
  required,
}: {
  children: React.ReactNode;
  hint?: string;
  label: string;
  /** The key errors are filed under. Without one the field cannot be pointed at. */
  name?: string;
  required?: boolean;
}) {
  const { clear, errors } = useContext(FieldErrorContext);
  const error = name ? errors[name] : undefined;

  return (
    <label
      className="block"
      data-field={name}
      // Typing into the box is the agent acting on the message, so the server's
      // complaint goes. The form's own checks are derived and clear themselves.
      onChangeCapture={name && error ? () => clear(name) : undefined}
    >
      <span className="mb-1.5 block text-xs font-semibold text-foreground">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </span>
      {error && name && isValidElement(children)
        ? cloneElement(children as ReactElement<Record<string, unknown>>, {
            "aria-describedby": fieldErrorId(name),
            "aria-invalid": true,
          })
        : children}
      {error && name ? (
        <FieldError name={name} />
      ) : hint ? (
        <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

/**
 * A pointable area that is not a single input — the photo strips, the plan
 * cards, the map pin. Focus lands on the first control inside it.
 */
function ErrorRegion({
  children,
  className,
  name,
}: {
  children: React.ReactNode;
  className?: string;
  name: string;
}) {
  const { clear, errors } = useContext(FieldErrorContext);

  return (
    <div
      className={className}
      data-field={name}
      onChangeCapture={errors[name] ? () => clear(name) : undefined}
    >
      {children}
      <FieldError name={name} />
    </div>
  );
}

/**
 * One kind of photo, uploaded and previewed.
 *
 * Kind is fixed by the caller rather than chosen per file, because the thing
 * that goes wrong is not "the agent picked the wrong option" — it is nobody
 * picking at all and every shot landing as an interior. A section per kind makes
 * the category a consequence of where you dropped the file.
 */
function PhotoStrip({
  busy,
  kind,
  label,
  onAdd,
  onOpen,
  onRemove,
  photos,
  roomType,
}: {
  busy: boolean;
  kind: PhotoKind;
  label: string;
  onAdd: (kind: PhotoKind, files: File[], roomType?: string) => void;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
  photos: PhotoRow[];
  roomType?: string;
}) {
  const mine = photos.filter(
    (photo) => photo.kind === kind && (kind !== "ROOM" || photo.roomType === roomType),
  );

  return (
    <div>
      <p className="mb-2 text-xs font-semibold text-foreground">
        {label}
        {mine.length > 0 ? (
          <span className="ml-1.5 font-normal text-muted-foreground">
            {mine.length}
          </span>
        ) : null}
      </p>

      <div className="flex flex-wrap gap-2">
        {mine.map((photo) => (
          <div
            className="group relative size-24 overflow-hidden rounded-lg border border-border bg-surface"
            key={photo.id}
          >
            {photo.uploading ? (
              <span className="flex size-full items-center justify-center">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </span>
            ) : (
              /*
               * A thumbnail this small is not enough to check that the right
               * photo went into the right section — which is the whole reason
               * an agent looks at this step. Clicking opens the app-wide viewer
               * on the full set, so they can arrow through everything they have
               * uploaded at full size without leaving the form.
               */
              <button
                aria-label={`View ${photo.name}`}
                className="size-full cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-teal/50"
                onClick={() => onOpen(photo.id)}
                type="button"
              >
                <Image
                  alt={photo.name}
                  className="size-full object-cover"
                  height={96}
                  src={photo.url}
                  unoptimized
                  width={96}
                />
              </button>
            )}
            <button
              aria-label={`Remove ${photo.name}`}
              className="absolute right-1 top-1 rounded-md bg-background/85 p-1 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
              onClick={() => onRemove(photo.id)}
              type="button"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}

        <label
          className={cn(
            "flex size-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-center transition hover:border-brand-teal hover:bg-brand-teal/5",
            busy && "pointer-events-none opacity-50",
          )}
        >
          <ImagePlus className="size-4 text-muted-foreground" />
          <span className="text-[10px] font-semibold text-muted-foreground">Add</span>
          <input
            accept={acceptAttribute("image")}
            className="sr-only"
            multiple
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);

              if (files.length > 0) {
                onAdd(kind, files, roomType);
              }

              event.currentTarget.value = "";
            }}
            type="file"
          />
        </label>
      </div>
    </div>
  );
}

export function TeamRegisterHostelPage() {
  const router = useRouter();
  const { identity, plans: catalog } = useSiteConfig();
  const { confirm, confirmDialog } = useConfirm();
  const mediaViewer = useMediaViewer();

  const [step, setStep] = useState(1);

  const [hostelName, setHostelName] = useState("");
  const [description, setDescription] = useState("");
  const [hostelType, setHostelType] = useState<"BOYS" | "CO_LIVING" | "GIRLS">(
    "CO_LIVING",
  );
  const [yearEstablished, setYearEstablished] = useState("");
  const [totalFloors, setTotalFloors] = useState("");
  const [panNumber, setPanNumber] = useState("");
  const [shortStays, setShortStays] = useState<ShortStayDraft>(EMPTY_SHORT_STAYS);

  const [ownerName, setOwnerName] = useState("");
  const [phone, setPhone] = useState("");
  const [alternatePhone, setAlternatePhone] = useState("");
  const [email, setEmail] = useState("");

  const [address, setAddress] = useState("");
  const [area, setArea] = useState("");
  const [city, setCity] = useState("Kathmandu");
  const [landmark, setLandmark] = useState("");
  const [mapLink, setMapLink] = useState("");
  /*
   * The pin, and how it got there.
   *
   * The agent is standing in the building, which makes them the best source of
   * coordinates this hostel will ever have — better than geocoding "Balkmurari,
   * Narephat" and landing in the middle of the neighbourhood. A pin they placed
   * is MANUAL, which is what stops the nightly nearby-places sweep moving it.
   */
  const [pin, setPin] = useState<LocationPickerValue>({
    coordinates: null,
    source: "GEOCODED",
  });

  const [rooms, setRooms] = useState<RoomRow[]>([newRoom()]);
  /*
   * The joining figures. They are the rate card's, not the listing's — see
   * `seedOpeningRateCard` — which is why only the admission fee also shows up in
   * `pricing` on the payload.
   */
  const [admissionFee, setAdmissionFee] = useState("");
  const [securityDeposit, setSecurityDeposit] = useState("");
  const [referralDiscount, setReferralDiscount] = useState("");

  const [photos, setPhotos] = useState<PhotoRow[]>([]);

  const [facilities, setFacilities] = useState<string[]>([]);
  const [customFacility, setCustomFacility] = useState("");
  const [rules, setRules] = useState("");

  const [hasVeg, setHasVeg] = useState(true);
  const [hasNonVeg, setHasNonVeg] = useState(true);
  const [mealsPerDay, setMealsPerDay] = useState("3");
  /** How many cooks the kitchen runs. Feeds the plan's seat caps. */
  const [cookCount, setCookCount] = useState("1");
  const [foodNotes, setFoodNotes] = useState("");

  const [timings, setTimings] =
    useState<Partial<Record<MealType, string>>>(DEFAULT_TIMINGS);
  const [routineDay, setRoutineDay] = useState<RoutineDay>("SUNDAY");
  const [routine, setRoutine] = useState<Record<string, string>>(defaultRoutine);

  const [documents, setDocuments] = useState<DocRow[]>([]);
  const [idProofChoice, setIdProofChoice] = useState<IdProofType>("");
  const idDocuments = documents.filter((doc) => isIdDocument(doc.type));
  const otherDocuments = documents.filter(
    (doc) => !isIdDocument(doc.type) && !SUPPORTING_DOCS.some((slot) => slot.type === doc.type),
  );
  /** The picked ID type, or the one an uploaded ID from a restored draft carries. */
  const idProofType: IdProofType =
    idProofChoice ||
    ((ID_PROOF_TYPES as readonly string[]).includes(idDocuments[0]?.type ?? "")
      ? (idDocuments[0]!.type as IdProofType)
      : "");
  const idProofReady =
    Boolean(idProofType) && idDocuments.some(isUploadedFile);

  const [planId, setPlanId] = useState("");
  const [cycle, setCycle] = useState<BillingCycle>("monthly");
  // Online first: Softmato confirms it on the spot. Cash waits for a second person there.
  const [method, setMethod] = useState<"CASH" | "SOFTMATO">("SOFTMATO");
  /**
   * The setup fee to take, online or in cash. Starts at the platform's fee,
   * which is also the most an agent may take (`/api/v1/team/setup-fee`).
   */
  const [amount, setAmount] = useState("");
  const [setupFee, setSetupFee] = useState<number | null>(null);
  const [paymentReference, setPaymentReference] = useState("");
  const [payout, setPayout] = useState(EMPTY_PAYOUT_DRAFT);
  const handoff = useCheckoutHandoff();
  /*
   * The online payment taken on Plan & payment, before publishing. The id is
   * kept apart from what the server said about it so a read that fails on a
   * bad connection cannot drop it from the draft — the money would still be
   * real, and the publish is what attaches it to the hostel.
   */
  const [prepaymentId, setPrepaymentId] = useState("");
  const [prepaymentRow, setPrepayment] = useState<TeamPrepaymentView | null>(null);
  const [prepaymentCheck, setPrepaymentCheck] = useState(0);

  useEffect(() => {
    let live = true;

    void browserApi<{ setupFee: number }>("/api/v1/team/setup-fee")
      .then((result) => {
        if (!live) return;
        setSetupFee(result.setupFee);
        // A draft or a paid row already set the amount; only an empty box takes the default.
        setAmount((current) => (current.trim() ? current : String(result.setupFee)));
      })
      .catch(() => {
        // The box stays empty and the step says so; the server refuses too much either way.
      });

    return () => {
      live = false;
    };
  }, []);
  // Only the row the form currently points at; a dropped id shows nothing.
  const prepayment = prepaymentRow?.id === prepaymentId ? prepaymentRow : null;
  const paidOnline = prepayment?.status === "PAID" ? prepayment : null;

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  /*
   * A registration the server refused as a duplicate. Kept apart from `error`
   * because it is not a fault to fix in a field — it is a question for the
   * agent: is this the hostel we already have, or a second building?
   */
  const [duplicate, setDuplicate] = useState<{
    code: "HOSTEL_ALREADY_LISTED" | "OWNER_ALREADY_HAS_HOSTEL";
    message: string;
  } | null>(null);
  const [confirmSecondHostel, setConfirmSecondHostel] = useState(false);
  /*
   * The hostel this owner email is already tied to, or null when it is free.
   *
   * Checked as the agent types rather than at Publish, because an email in use
   * cannot be used at all — and learning that on the last step, after the
   * photos and the rooms are in, sends the agent back to a field they left ten
   * minutes ago. Debounced so a typed address is one request, and cancelled on
   * the next keystroke so a slow answer for "ram@gm" cannot overwrite the one
   * for "ram@gmail.com". The server refuses it again at Publish either way.
   */
  const [emailAnswer, setEmailAnswer] = useState<{
    email: string;
    state: "failed" | TeamOwnerEmailStatus;
    usedBy?: string;
  } | null>(null);
  const checkableEmail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim()) ? email.trim() : "";
  /** Derived, so an answer for an older address never shows against a newer one. */
  const emailCheck: { state: "idle" | "checking" | "failed" | TeamOwnerEmailStatus; usedBy?: string } =
    !checkableEmail
      ? { state: "idle" }
      : emailAnswer?.email === checkableEmail
        ? emailAnswer
        : { state: "checking" };
  /** Why this email cannot be used, or null. Only a refusal the server gave. */
  const emailProblem =
    emailCheck.state === "HOSTEL"
      ? `Already used by "${emailCheck.usedBy ?? "another hostel"}". Use a different email for this owner.`
      : emailCheck.state === "OTHER_ROLE"
        ? "This email belongs to a resident, staff or other non-owner account. Use a different email for this owner."
        : null;

  useEffect(() => {
    const address = checkableEmail;

    if (!address) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      void browserApi<{ status: TeamOwnerEmailStatus; usedBy: string | null }>(
        `/api/v1/team/email-check?email=${encodeURIComponent(address)}`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (!controller.signal.aborted) {
            setEmailAnswer({
              email: address,
              state: result.status,
              usedBy: result.usedBy ?? undefined,
            });
          }
        })
        .catch(() => {
          // A check that could not run is not a refusal. Publish still checks.
          if (!controller.signal.aborted) {
            setEmailAnswer({ email: address, state: "failed" });
          }
        });
    }, 450);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [checkableEmail]);
  /** What the server refused, filed under the field it was about. */
  const [submitErrors, setSubmitErrors] = useState<FieldErrors>({});
  /**
   * Set once the agent has been to the review step. From then on the form's own
   * checks are printed under the fields they are about — before it, a half-typed
   * phone number would be shouted at mid-keystroke.
   */
  const [reviewed, setReviewed] = useState(false);
  /**
   * The problems banner at the top is a nudge, not a wall: it shows for three
   * seconds each time the agent reviews, steps on, or tries to publish, then
   * gets out of the way. The inline messages under each field stay put. Hovering
   * holds it open so a link in it can still be clicked.
   */
  const [bannerFlash, setBannerFlash] = useState(0);
  const [bannerOpen, setBannerOpen] = useState(false);
  const [bannerHeld, setBannerHeld] = useState(false);

  function flashProblems() {
    setBannerOpen(true);
    // A banner that unmounted under the pointer never fired mouseleave.
    setBannerHeld(false);
    setBannerFlash((count) => count + 1);
  }

  useEffect(() => {
    if (!bannerOpen || bannerHeld) {
      return;
    }

    const timer = setTimeout(() => setBannerOpen(false), 3000);

    return () => clearTimeout(timer);
  }, [bannerOpen, bannerHeld, bannerFlash]);
  const [focusTarget, setFocusTarget] = useState<{ at: number; field: string } | null>(
    null,
  );
  const [draftNotice, setDraftNotice] = useState("");

  const cycles = billingCycles(catalog);
  const priced = catalog.plans.filter((plan) => plan.monthly > 0);
  const plan = priced.find((entry) => entry.id === planId);
  // A plan-priced online payment from before setup fees still ties the form to its plan.
  const planLocked = paidOnline?.kind === "PLAN";
  // What the owner pays for the plan once its free months end, on this cycle.
  const price = planLocked && paidOnline ? paidOnline.amount : plan ? cycleTotal(plan, cycle) : 0;
  const fee = numberValue(amount) ?? 0;
  const feeValid = Number.isInteger(fee) && fee > 0 && setupFee !== null && fee <= setupFee;
  // Cash is typed in; online is only ever what Softmato confirmed.
  const collecting = method === "CASH" ? fee : (paidOnline?.chargeAmount ?? 0);
  const uploading = documents.some((doc) => doc.uploading) || photos.some((p) => p.uploading);

  /** Room rows that have enough on them to be a room type at all. */
  const validRooms = rooms.filter(
    (room) => room.roomType.trim() && numberValue(room.rooms),
  );

  const roomTypeNames = Array.from(
    new Set(validRooms.map((room) => room.roomType.trim())),
  );

  /*
   * Capacity and the rent range are computed from the room rows rather than
   * asked for again. Two boxes that must agree with a table above them are two
   * boxes that will eventually disagree with it, and the table is the more
   * specific answer — `hostelDocumentFrom` already treats it that way.
   */
  const capacity = validRooms.reduce(
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

  const rentRange = (() => {
    const rents = validRooms
      .map((room) => numberValue(room.monthlyRent))
      .filter((rent): rent is number => rent !== undefined && rent > 0);

    return rents.length > 0
      ? { max: Math.max(...rents), min: Math.min(...rents) }
      : null;
  })();

  /** Whatever was typed in — derived, so it cannot drift from what is submitted. */
  const custom = facilities.filter((facility) => !facilityOptions.includes(facility));

  /**
   * Every uploaded photo, in the order the strips render them.
   *
   * The viewer is handed the whole set rather than one strip's worth so its
   * arrows walk the entire gallery: an agent checking their work wants to see
   * what the listing will look like, and the listing does not stop at the
   * section boundary either.
   */
  const uploadedPhotos = photos.filter((photo) => photo.url && !photo.uploading);

  function openPhoto(id: string) {
    const index = uploadedPhotos.findIndex((photo) => photo.id === id);

    if (index < 0) {
      return;
    }

    mediaViewer.open(
      uploadedPhotos.map((photo) => ({
        caption: photo.name,
        kind: "image" as const,
        src: photo.url,
        title:
          photo.kind === "ROOM"
            ? (photo.roomType ?? "Room")
            : photo.kind === "EXTERIOR"
              ? "Outside"
              : "Inside",
      })),
      index,
    );
  }

  /* ── Draft ───────────────────────────────────────────────────────────── */

  /*
   * An agent fills this in standing in a corridor on a phone connection. Losing
   * forty fields to a backgrounded tab is the difference between a tool and a
   * liability, so everything typed is kept locally until the form is submitted.
   *
   * Uploaded photos and documents are kept as URLs, which is safe: the file is
   * already on our storage by then, so the draft only carries a pointer to
   * something that exists.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // Back from Softmato (`prepayment`), or reopened from the desk (`resume`).
    const returned = params.get("prepayment");
    const resume = params.get("resume");

    if (returned || resume) {
      window.history.replaceState(null, "", window.location.pathname);
    }

    function restore(draft: Record<string, unknown>) {
      const read = <T,>(key: string, apply: (value: T) => void) => {
        if (draft[key] !== undefined) {
          apply(draft[key] as T);
        }
      };

      read<number>("step", setStep);
      read<string>("hostelName", setHostelName);
      read<string>("description", setDescription);
      read<"BOYS" | "CO_LIVING" | "GIRLS">("hostelType", setHostelType);
      read<string>("yearEstablished", setYearEstablished);
      read<string>("totalFloors", setTotalFloors);
      read<string>("panNumber", setPanNumber);
      read<ShortStayDraft>("shortStays", setShortStays);
      read<string>("ownerName", setOwnerName);
      read<string>("phone", setPhone);
      read<string>("alternatePhone", setAlternatePhone);
      read<string>("email", setEmail);
      read<string>("address", setAddress);
      read<string>("area", setArea);
      read<string>("city", setCity);
      read<string>("landmark", setLandmark);
      read<string>("mapLink", setMapLink);
      read<LocationPickerValue>("pin", setPin);
      read<RoomRow[]>("rooms", setRooms);
      read<string>("admissionFee", setAdmissionFee);
      read<string>("securityDeposit", setSecurityDeposit);
      read<string>("referralDiscount", setReferralDiscount);
      read<PhotoRow[]>("photos", setPhotos);
      read<string[]>("facilities", setFacilities);
      read<string>("rules", setRules);
      read<boolean>("hasVeg", setHasVeg);
      read<boolean>("hasNonVeg", setHasNonVeg);
      read<string>("mealsPerDay", setMealsPerDay);
      read<string>("cookCount", setCookCount);
      read<string>("foodNotes", setFoodNotes);
      /*
       * The routine and its timings **merge onto** the defaults rather than
       * replacing them.
       *
       * A draft saved before the sample week existed carries `{}` for both, and
       * `{}` is defined — so a plain restore handed the form two empty objects
       * and every agent with an older draft saw an empty grid where the sample
       * should have been. Merging also gets the general case right: a cell the
       * draft never recorded falls back to the sample, while a cell the agent
       * deliberately emptied is stored as `""` and stays empty.
       */
      /*
       * The routine merges onto the defaults so a cell the draft never recorded
       * falls back to the sample while a cell the agent emptied stays empty —
       * but only for a draft new enough for that distinction to mean anything.
       */
      if (draft.version === DRAFT_VERSION) {
        read<Partial<Record<MealType, string>>>("timings", (value) =>
          setTimings({ ...DEFAULT_TIMINGS, ...value }),
        );
        read<Record<string, string>>("routine", (value) =>
          setRoutine({ ...defaultRoutine(), ...value }),
        );
      }
      read<DocRow[]>("documents", setDocuments);
      read<string>("planId", setPlanId);
      read<BillingCycle>("cycle", setCycle);
      /*
       * The payout account is restored like everything else. An agent who has
       * read a bank account number off a cheque book and then lost signal should
       * not have to ask for it twice — and it is no more sensitive than the
       * government ID already sitting in this draft.
       */
      read<typeof EMPTY_PAYOUT_DRAFT>("payout", setPayout);
      read<string>("prepaymentId", setPrepaymentId);
    }

    /*
     * From the desk: the paid hostel's own copy on the server, not whatever
     * this browser last held. Kept by id even if that read fails.
     */
    if (resume) {
      void browserApi<{ draft: Record<string, unknown> | null }>(`/api/v1/team/prepayments/${resume}`)
        .then((row) => restore({ ...(row.draft ?? {}), prepaymentId: resume }))
        .catch(() => restore({ prepaymentId: resume }));

      return;
    }

    try {
      const saved = readRenamedStorage(localStorage, DRAFT_KEY, LEGACY_DRAFT_KEY);

      if (!saved && !returned) {
        return;
      }

      const draft = (saved ? JSON.parse(saved) : {}) as Record<string, unknown>;

      /*
       * Back from Softmato: the return URL names the payment and wins over the
       * draft — kept even when storage is blocked and the draft is gone, since
       * that money is real. It is a pointer, not proof: the payment is read
       * back from the server, which asks Softmato.
       */
      if (returned) {
        draft.prepaymentId = returned;
      }

      restore(draft);
    } catch {
      // A corrupt draft is discarded rather than diagnosed.
    }
  }, []);

  useEffect(() => {
    if (!prepaymentId) return;

    let live = true;

    browserApi<TeamPrepaymentView>(`/api/v1/team/prepayments/${prepaymentId}`)
      .then((row) => {
        if (!live) return;

        // Replaced, or already on a published hostel: nothing for this form.
        if (row.status === "SUPERSEDED" || row.status === "CLAIMED") {
          setPrepaymentId("");

          return;
        }

        setPrepayment(row);
        // An open row keeps its fee, so Take payment reuses it.
        if (row.kind === "SETUP_FEE") setAmount(String(row.amount));

        if (row.status === "PAID") {
          setMethod("SOFTMATO");

          // Paid for one plan at one price before setup fees: put back on exactly that.
          if (row.kind === "PLAN") {
            setPlanId(row.planId);
            setCycle(row.cycle);
          }
        }
      })
      .catch(() => {
        // Kept by id; the next check, or the publish, reads it again.
      });

    return () => {
      live = false;
    };
  }, [prepaymentId, prepaymentCheck]);

  /*
   * One writer for both the autosave and the button.
   *
   * The button does not do anything the typing has not already done — it exists
   * because autosave is invisible, and an agent who has spent twenty minutes on
   * a form has no way of knowing it is safe. Pressing something and being told
   * "Saved" is the whole feature; the storage write is incidental.
   */
  function writeDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draftSnapshot()));

      return true;
    } catch {
      // Private mode, or a full quota. The form still works; it just forgets —
      // and the button says so rather than claiming a save that did not happen.
      return false;
    }
  }

  /** The whole form as one object — the browser's draft, and a paid hostel's copy on the server. */
  function draftSnapshot() {
    return {
      address,
      admissionFee,
      alternatePhone,
      area,
      city,
      cookCount,
      cycle,
      description,
      documents,
      email,
      facilities,
      foodNotes,
      hasNonVeg,
      hasVeg,
      hostelName,
      hostelType,
      landmark,
      mapLink,
      mealsPerDay,
      ownerName,
      payout,
      phone,
      photos,
      pin,
      planId,
      prepaymentId,
      referralDiscount,
      rooms,
      routine,
      rules,
      securityDeposit,
      step,
      timings,
      totalFloors,
      panNumber,
      shortStays,
      version: DRAFT_VERSION,
      yearEstablished,
    };
  }

  useEffect(() => {
    writeDraft();
    // `writeDraft` closes over every field; listing them is what makes the
    // autosave fire on each keystroke. It deliberately sets no state — a
    // timestamp updated on every keypress would cascade a render for something
    // nobody is reading. The button below is what reports, because a button
    // press is a moment somebody is actually looking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    address,
    admissionFee,
    alternatePhone,
    area,
    city,
    cookCount,
    cycle,
    description,
    documents,
    email,
    facilities,
    foodNotes,
    hasNonVeg,
    hasVeg,
    hostelName,
    hostelType,
    landmark,
    mapLink,
    mealsPerDay,
    ownerName,
    payout,
    phone,
    photos,
    pin,
    planId,
    prepaymentId,
    referralDiscount,
    rooms,
    routine,
    rules,
    securityDeposit,
    step,
    timings,
    panNumber,
    shortStays,
    totalFloors,
    yearEstablished,
  ]);

  /* ── Completeness ────────────────────────────────────────────────────── */

  function stepComplete(key: number) {
    switch (key) {
      case 1:
      case 2:
        // The same checks that stop a submission, so a tick on the rail cannot
        // sit beside a phone number the server is going to refuse.
        return !blocking.some((check) => check.step === key);
      case 3:
        return (
          validRooms.length > 0 && !blocking.some((check) => check.step === 3)
        );
      case 4:
        return photos.some((photo) => photo.url && !photo.uploading);
      case 5:
        return facilities.length > 0;
      case 6:
        return idProofReady;
      case 7:
        return Boolean(plan) && collecting > 0;
      default:
        return false;
    }
  }

  /**
   * What stops a submission, each filed under the field it is about.
   *
   * These are the server's own rules (`hostel-registration.validation.ts`),
   * checked here as well so the agent finds out on the step and not after a
   * round trip. "Not empty" was not enough: a six-digit phone passed this list
   * and was then refused by the server's seven-character minimum.
   */
  const blocking = (() => {
    const checks: { field: string; message: string; valid: boolean }[] = [
      {
        field: "ownerName",
        message: ownerName.trim() ? "Needs at least 2 characters." : "Enter the owner's name.",
        valid: ownerName.trim().length >= 2,
      },
      {
        field: "phone",
        message: phone.trim() ? "Needs at least 7 digits." : "Enter the owner's phone number.",
        valid: phoneValid(phone),
      },
      {
        field: "alternatePhone",
        message: "Needs at least 7 digits, or leave it empty.",
        valid: !alternatePhone.trim() || phoneValid(alternatePhone),
      },
      {
        field: "email",
        message: "That is not a valid email address.",
        valid: !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()),
      },
      {
        field: "hostelName",
        message: hostelName.trim() ? "Needs at least 2 characters." : "Enter the hostel's name.",
        valid: hostelName.trim().length >= 2,
      },
      {
        field: "yearEstablished",
        message: "Four digits, like 2018.",
        valid: !yearEstablished.trim() || /^\d{4}$/.test(yearEstablished.trim()),
      },
      {
        field: "panNumber",
        message: "Nine digits, from the PAN/VAT certificate.",
        valid: !panNumber.trim() || /^\d{9}$/.test(panNumber.replace(/\s/g, "")),
      },
      {
        field: "area",
        message: area.trim() ? "Needs at least 2 characters." : "Enter the area or locality.",
        valid: area.trim().length >= 2,
      },
      { field: "city", message: "Pick the city.", valid: city.trim().length >= 2 },
      {
        field: "rooms",
        message: "Add at least one room type with a number of rooms.",
        valid: validRooms.length > 0,
      },
      /*
       * Every room type needs a rent, because the rents *are* the rate card
       * (`seedOpeningRateCard`). A room type filed without one is a room type no
       * billing run can price: the resident in it is either refused with
       * BED_TYPE_NOT_PRICED or billed off the listing with nothing behind the
       * line. The agent is sitting with the owner and can ask.
       */
      ...validRooms
        .filter((room) => !(numberValue(room.monthlyRent) ?? 0))
        .map((room) => ({
          field: `room:${room.id}:monthlyRent`,
          message: "Enter the monthly rent — residents are billed from it.",
          valid: false,
        })),
      {
        field: "referralDiscount",
        message: "A referral discount cannot be more than the admission fee.",
        valid:
          (numberValue(referralDiscount) ?? 0) <= (numberValue(admissionFee) ?? 0),
      },
      { field: "plan", message: "Pick the plan the owner is buying.", valid: Boolean(plan) },
      {
        field: "amount",
        message:
          method === "SOFTMATO"
            ? "Take the setup fee online. A hostel does not publish unpaid."
            : "Enter the setup fee collected. A hostel does not publish unpaid.",
        valid: collecting > 0,
      },
      {
        field: "amount",
        message: `The setup fee is 1 to ${rupees(setupFee ?? 0)} — never more.`,
        valid: method !== "CASH" || !amount.trim() || feeValid,
      },
    ];

    return checks
      .filter((check) => !check.valid)
      .map((check) => ({
        ...check,
        label: labelOf(check.field),
        step: stepOfField(check.field),
      }));
  })();

  /**
   * Things a live listing is worse without, but which are not worth refusing a
   * registration over.
   *
   * A hostel with no photos publishes with a stock image, which is a poorer
   * listing and not an invalid one — and an agent who cannot get photos today
   * should still be able to file the hostel and take the money.
   */
  const recommendations = (() => {
    /*
     * The routine ships pre-filled with a typical week, which is a head start
     * and a trap: an agent who never opened step 5 would publish a menu the
     * hostel never agreed to. Untouched is therefore called out here by name
     * rather than passing silently as "filled in".
     */
    const sample = defaultRoutine();
    const routineUntouched =
      ROUTINE_DAYS.every((day) =>
        MEAL_TYPES.every(
          (meal) => (routine[`${day}:${meal}`] ?? "") === sample[`${day}:${meal}`],
        ),
      ) && MEAL_TYPES.every((meal) => (timings[meal] ?? "") === DEFAULT_TIMINGS[meal]);

    const checks: { field: string; label: string; step: number; valid: boolean }[] = [
      {
        field: "photos",
        label: "Photos of the building",
        step: 4,
        valid: photos.some((p) => p.url),
      },
      {
        // The server geocodes the address when nobody placed a pin, which puts
        // the hostel somewhere in the right neighbourhood. The agent is in the
        // building; they can do better, and it is worth asking them to.
        field: "pin",
        label: "The map pin — you are standing there, so place it",
        step: 2,
        valid: pin.coordinates !== null,
      },
      { field: "facilities", label: "Facilities", step: 5, valid: facilities.length > 0 },
      { field: "rules", label: "House rules", step: 6, valid: Boolean(rules.trim()) },
      {
        field: "routine",
        label: "The food routine is still the sample week — check it with the owner",
        step: 5,
        valid: !routineUntouched,
      },
      {
        field: "documents",
        label: "The owner's government ID — pick its type and upload it",
        step: 6,
        valid: idProofReady,
      },
      { field: "email", label: "The owner's email", step: 1, valid: Boolean(email.trim()) },
      {
        // Not blocking: a hostel is allowed to take no deposit. But an unstated
        // deposit and a zero deposit look identical afterwards, and the joining
        // invoice a resident is handed is short by whatever nobody typed.
        field: "securityDeposit",
        label: "The security deposit — a joining invoice without one is short",
        step: 3,
        valid: Boolean(securityDeposit.trim()),
      },
      {
        // Bookings stay switched off until a payout account is verified, so a
        // hostel filed without one publishes unable to take a booking.
        field: "payout",
        label: "Where booking payouts go — bookings stay off until it is set",
        step: 7,
        valid: Boolean(payoutAccountPayload(payout)),
      },
    ];

    return checks.filter((check) => !check.valid);
  })();

  /*
   * Every field that is wrong right now, and what to say about it: the form's
   * own checks once the agent has reached the review step, with whatever the
   * server refused laid over the top. Derived on every render, so a problem the
   * agent fixes drops off the list as they fix it — nothing to dismiss.
   */
  const showChecks = reviewed || step === STEPS.length;
  const fieldErrors: FieldErrors = {
    ...(showChecks
      ? Object.fromEntries(blocking.map((check) => [check.field, check.message]))
      : {}),
    ...submitErrors,
  };
  const problems = Object.entries(fieldErrors)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([field, message]) => ({
      field,
      label: labelOf(field),
      message,
      step: stepOfField(field),
    }))
    .sort((a, b) => a.step - b.step);

  /* ── Editing ─────────────────────────────────────────────────────────── */

  function addFacility() {
    const value = customFacility.trim().replace(/\s+/g, " ");

    if (!value || value.length > 80 || facilities.length >= 40) {
      return;
    }

    const preset = facilityOptions.find(
      (option) => option.toLowerCase() === value.toLowerCase(),
    );
    const name = preset ?? value;

    if (!facilities.some((item) => item.toLowerCase() === name.toLowerCase())) {
      setFacilities((prev) => [...prev, name]);
    }

    setCustomFacility("");
  }

  async function addDocument(type: string, file: File) {
    const id = crypto.randomUUID();

    setDocuments((prev) => [
      ...prev,
      { id, name: file.name, type, uploading: true, url: "" },
    ]);

    try {
      const uploaded = await uploadRegistrationDocument(file, type);

      setDocuments((prev) =>
        prev.map((doc) => (doc.id === id ? { ...doc, ...uploaded, uploading: false } : doc)),
      );
    } catch {
      setDocuments((prev) => prev.filter((doc) => doc.id !== id));
      setError(`Could not upload ${file.name}.`);
    }
  }

  function removeDocument(id: string) {
    setDocuments((prev) => prev.filter((doc) => doc.id !== id));
  }

  /** Changing the ID type relabels the ID already uploaded rather than orphaning it. */
  function chooseIdProofType(type: IdProofType) {
    setIdProofChoice(type);
    setDocuments((prev) =>
      prev.map((doc) =>
        isIdDocument(doc.type) ? { ...doc, type: type || "Owner ID proof" } : doc,
      ),
    );
  }

  /** The uploader props for one slot: its files, and uploads filed under its type. */
  function docSlot(type: string, matches = (docType: string) => docType === type, maxFiles = 1) {
    const files = documents.filter((doc) => matches(doc.type));
    const upload = async (picked: File[]) => {
      await Promise.all(
        picked.slice(0, Math.max(0, maxFiles - files.length)).map((file) => addDocument(type, file)),
      );
    };

    return {
      files,
      onFileSelect: async (event: ChangeEvent<HTMLInputElement>) => {
        const picked = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        await upload(picked);
      },
      onFilesDropped: upload,
      onRemove: removeDocument,
    };
  }

  function addPhotos(kind: PhotoKind, files: File[], roomType?: string) {
    for (const file of files) {
      const id = crypto.randomUUID();

      setPhotos((prev) => [
        ...prev,
        { id, kind, name: file.name, roomType, uploading: true, url: "" },
      ]);

      void (async () => {
        try {
          const uploaded = await uploadFile(file, {
            kind: "image",
            label: `${titleCase(kind)} photo`,
            silent: true,
            target: "public",
            visibility: "public",
          });

          const url = uploaded?.url;

          if (!url) {
            throw new Error("Upload failed");
          }

          setPhotos((prev) =>
            prev.map((photo) =>
              photo.id === id ? { ...photo, uploading: false, url } : photo,
            ),
          );
        } catch {
          setPhotos((prev) => prev.filter((photo) => photo.id !== id));
          setError(`Could not upload ${file.name}.`);
        }
      })();
    }
  }

  function setRoutineItems(day: RoutineDay, meal: MealType, value: string) {
    setRoutine((prev) => ({ ...prev, [`${day}:${meal}`]: value }));
  }

  /**
   * Copies the day on screen onto the other six. Most weeks are one week.
   *
   * Refuses to copy a day with nothing in it. Pressing this on a blank day can
   * only ever mean a misfire — nobody sets out to erase six days of meals — and
   * before the guard it did exactly that, writing an empty string into all
   * twenty-eight cells and leaving a routine that looked deliberately cleared.
   */
  function copyDayToAll(day: RoutineDay) {
    const source = MEAL_TYPES.map((meal) => routine[`${day}:${meal}`] ?? "");

    if (source.every((value) => !value.trim())) {
      setError(
        `${titleCase(day)} has no meals on it yet — fill it in before copying it across.`,
      );

      return;
    }

    setError("");
    setRoutine((prev) => {
      const next = { ...prev };

      for (const target of ROUTINE_DAYS) {
        MEAL_TYPES.forEach((meal, index) => {
          next[`${target}:${meal}`] = source[index];
        });
      }

      return next;
    });
  }

  function applyRulesTemplate(id: string) {
    const template = RULES_TEMPLATES.find((entry) => entry.id === id);

    if (!template) {
      return;
    }

    /*
     * The template is a document; `rules[]` is a list of short lines. Taking the
     * bulleted lines out of it gives the listing something readable without
     * dumping five headings and a blank line into the rules card.
     */
    const lines = template.body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("-"))
      .map((line) => line.replace(/^-\s*/, ""));

    setRules(lines.join("\n"));
  }

  /* ── Submitting ──────────────────────────────────────────────────────── */

  /**
   * Throws the draft away and reloads onto an empty form.
   *
   * Reloading rather than resetting thirty pieces of state by hand: there is one
   * definition of "a fresh form" — the one the component mounts with — and a
   * hand-written reset is a second one that will drift from it the next time a
   * field is added.
   */
  async function discardDraft() {
    /*
     * A paid hostel is never thrown away: its form is kept on the payment and
     * waits on My desk under "Paid, not published" until someone publishes it.
     */
    const confirmed = await confirm(
      paidOnline
        ? {
            actionLabel: "Keep it on my desk",
            description: `${hostelName.trim() || "This hostel"} is paid (${rupees(paidOnline.amount)}), so it is not discarded. The form is kept on My desk under Paid, not published — open it from there to publish.`,
            title: "Start a new hostel?",
          }
        : {
            actionLabel: "Discard it",
            description:
              "Everything typed into this form is thrown away, including uploads that have not been submitted. The hostel is not affected — nothing has been registered yet.",
            title: "Start over?",
            tone: "destructive",
          },
    );

    if (!confirmed) {
      return;
    }

    if (paidOnline) {
      try {
        await browserApi(`/api/v1/team/prepayments/${paidOnline.id}`, {
          body: JSON.stringify({ draft: draftSnapshot() }),
          method: "PATCH",
        });
      } catch (caught) {
        // Not cleared unless the server has it: this browser is the only other copy.
        setError(caught instanceof Error ? caught.message : "Could not keep it on your desk. Try again.");

        return;
      }
    }

    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      // Nothing stored to begin with.
    }

    window.location.reload();
  }

  function goTo(next: number) {
    // Review is only reachable once money is in: an unpaid hostel stops on Plan & payment.
    if (next >= STEPS.length && collecting <= 0) {
      focusField("amount");

      return;
    }

    if (step === STEPS.length || next >= STEPS.length) {
      setReviewed(true);
    }

    flashProblems();
    setStep(Math.min(STEPS.length, Math.max(1, next)));
    window.scrollTo({ behavior: "smooth", top: 0 });
  }

  /** Opens the step a field lives on and puts the cursor in it. */
  function focusField(field: string, day?: RoutineDay) {
    if (day) {
      setRoutineDay(day);
    }

    setReviewed(true);
    flashProblems();
    setStep(stepOfField(field));
    // A fresh object each time, so pointing at the same field twice still moves.
    setFocusTarget((prev) => ({ at: (prev?.at ?? 0) + 1, field }));
  }

  useEffect(() => {
    if (!focusTarget) {
      return;
    }

    // The step's section is committed by now, but its entrance animation is
    // still starting; one frame lets the scroll measure where it will settle.
    const frame = requestAnimationFrame(() => {
      const region = document.querySelector<HTMLElement>(
        `[data-field="${CSS.escape(focusTarget.field)}"]`,
      );

      if (!region) {
        window.scrollTo({ behavior: "smooth", top: 0 });

        return;
      }

      region.scrollIntoView({ behavior: "smooth", block: "center" });

      const control =
        region.querySelector<HTMLElement>(
          "input:not([type=file]):not([type=hidden]), select, textarea",
        ) ?? region.querySelector<HTMLElement>("button");

      control?.focus({ preventScroll: true });
    });

    return () => cancelAnimationFrame(frame);
  }, [focusTarget]);

  function clearSubmitError(field: string) {
    setSubmitErrors((prev) => {
      if (!(field in prev)) {
        return prev;
      }

      const next = { ...prev };
      delete next[field];

      return next;
    });
  }

  /** The name a field goes by in the problem list. Room cells name their row. */
  function labelOf(field: string) {
    if (field.startsWith("room:")) {
      const [, id, key] = field.split(":");
      const room = rooms.find((entry) => entry.id === id);

      return `${room?.roomType ?? "Room"} · ${ROOM_KEY_LABEL[key as RoomKey] ?? "Room"}`;
    }

    if (field.startsWith("timing:")) {
      return `${titleCase(field.slice("timing:".length))} time`;
    }

    if (field.startsWith("routine:")) {
      return `${titleCase(field.slice("routine:".length))} on the routine`;
    }

    return FIELD_LABEL[field] ?? field;
  }

  function buildPayload() {
    const roomConfigurations = validRooms.map((room) => ({
      bedsPerRoom: numberValue(room.bedsPerRoom) ?? 0,
      mealInclusion: "Included" as const,
      monthlyRent: numberValue(room.monthlyRent),
      rooms: numberValue(room.rooms) ?? 0,
      roomType: room.roomType.trim(),
      vacantBeds: numberValue(room.vacantBeds) ?? 0,
    }));

    const meals = ROUTINE_DAYS.flatMap((day) =>
      MEAL_TYPES.flatMap((meal) => {
        const items = (routine[`${day}:${meal}`] ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);

        return items.length > 0
          ? [{ dayOfWeek: day, items, mealType: meal }]
          : [];
      }),
    );

    const cleanTimings = Object.fromEntries(
      MEAL_TYPES.map((meal) => [meal, (timings[meal] ?? "").trim()]).filter(
        ([, value]) => value,
      ),
    );

    return {
      payoutAccount: payoutAccountPayload(payout),
      alternatePhone: alternatePhone.trim() || undefined,
      applicant: {
        email: email.trim() || undefined,
        name: ownerName.trim(),
        phone: phone.trim(),
      },
      capacitySummary: capacity,
      contact: { email: email.trim() || undefined, phone: phone.trim() },
      cookCount: numberValue(cookCount),
      description: description.trim() || undefined,
      documents: documents.flatMap((doc) => submittedDocuments(doc.type, [doc])),
      facilities,
      food: {
        hasNonVeg,
        hasVeg,
        mealsPerDay: numberValue(mealsPerDay),
        notes: foodNotes.trim() || undefined,
      },
      /*
       * Only sent when there is something in it. An empty routine posted every
       * time would create a `FoodRoutine` document for every hostel whether or
       * not anybody asked about meals, and "no routine recorded" then becomes
       * indistinguishable from "a routine with nothing in it".
       */
      foodRoutine:
        meals.length > 0 || Object.keys(cleanTimings).length > 0
          ? { meals, timings: cleanTimings }
          : undefined,
      hostelType,
      landmark: landmark.trim() || undefined,
      location: {
        address: address.trim() || undefined,
        area: area.trim(),
        city: city.trim(),
        /*
         * The pin travels with the address, so the listing has a map on the day
         * it publishes. Without it the server can only geocode the locality,
         * and the public page opens on a dashed box telling the visitor the
         * hostel has not finished setting itself up.
         */
        ...(pin.coordinates
          ? {
              lat: pin.coordinates.lat,
              lng: pin.coordinates.lng,
              locationSource: pin.source,
            }
          : {}),
      },
      mapLink: mapLink.trim() || undefined,
      name: hostelName.trim(),
      // Online sends no amount: the server reads it off the paid row.
      payment:
        method === "CASH"
          ? { amount: collecting, method, reference: paymentReference.trim() || undefined }
          : { amount: 0, method, ...(paidOnline ? { prepaymentId: paidOnline.id } : {}) },
      photos: photos
        .filter((photo) => photo.url && !photo.uploading)
        .map((photo) => ({
          kind: photo.kind,
          roomType: photo.kind === "ROOM" ? photo.roomType : undefined,
          url: photo.url,
        })),
      plan: { cycle, planId: plan?.id ?? "" },
      pricing: {
        admissionFee: numberValue(admissionFee),
        currency: "NPR",
        monthlyRentMax: rentRange?.max,
        monthlyRentMin: rentRange?.min,
      },
      /*
       * The other two joining figures. They are not on `pricing` because they
       * are not listing fields — they belong to the rate card the server opens
       * from this payload, and the listing projection reads the card, not this.
       */
      referralAdmissionDiscount: numberValue(referralDiscount),
      securityDeposit: numberValue(securityDeposit),
      roomConfigurations,
      roomTypes: roomTypeNames,
      rules: rules
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
      panNumber: panNumber.replace(/\s/g, "") || undefined,
      shortStays: shortStaysPayload(shortStays, rooms),
      totalFloors: numberValue(totalFloors),
      yearEstablished: yearEstablished.trim() || undefined,
    };
  }

  /**
   * The input a server-side issue is about.
   *
   * Array indices are resolved against the payload that was actually sent: the
   * third room configuration is the third *valid* room row, not the third row on
   * screen, and a meal index only names a day once it is looked up.
   */
  function fieldForPath(
    path: string,
    payload: ReturnType<typeof buildPayload>,
  ): { day?: RoutineDay; field: string } | null {
    const [head, second, third] = path.split(".");

    switch (head) {
      case "applicant":
      case "contact":
        return {
          field: second === "email" ? "email" : second === "name" ? "ownerName" : "phone",
        };
      case "name":
        return { field: "hostelName" };
      case "location":
        return {
          field: second === "area" || second === "city" || second === "address" ? second : "pin",
        };
      case "roomConfigurations": {
        const room = validRooms[Number(second)];

        return {
          field: room && third && third in ROOM_KEY_LABEL ? `room:${room.id}:${third}` : "rooms",
        };
      }
      case "roomTypes":
      case "capacitySummary":
      case "totalCapacity":
        return { field: "rooms" };
      case "pricing":
        return { field: second === "admissionFee" ? "admissionFee" : "rooms" };
      case "securityDeposit":
        return { field: "securityDeposit" };
      case "referralAdmissionDiscount":
        return { field: "referralDiscount" };
      case "cookCount":
        return { field: "cookCount" };
      case "payoutAccount":
        return { field: "payout" };
      case "food":
        return { field: second === "notes" ? "foodNotes" : "mealsPerDay" };
      case "foodRoutine": {
        if (second === "timings" && third) {
          return { field: `timing:${third}` };
        }

        const meal = second === "meals" ? payload.foodRoutine?.meals[Number(third)] : undefined;

        return meal
          ? { day: meal.dayOfWeek, field: `routine:${meal.mealType}` }
          : { field: "routine" };
      }
      case "payment":
        return { field: second === "reference" ? "paymentReference" : "amount" };
      default:
        return head in FIELD_STEP ? { field: head } : null;
    }
  }

  /**
   * Opens Softmato checkout on this device for the owner to scan, before the
   * hostel exists. Priced and checked on the server; the form only names the
   * plan. Softmato brings the agent back to `?prepayment=<id>`.
   */
  function takeOnlinePayment() {
    if (!plan || !feeValid) return;

    writeDraft();
    void handoff.start({
      back: "/team/register",
      body: {
        area: area.trim(),
        cycle,
        draft: draftSnapshot(),
        email: email.trim(),
        hostelName: hostelName.trim(),
        ownerName: ownerName.trim(),
        phone: phone.trim(),
        planId: plan.id,
        amount: fee,
        ...(prepaymentId ? { prepaymentId } : {}),
      },
      endpoint: "/api/v1/team/prepayments",
      /*
       * Kept before the redirect, in the draft itself: pressing Back on
       * Softmato's page returns here without the return URL, and a second
       * press of Take payment must reuse this row rather than open another.
       */
      onOpened: (result) => {
        const id = (result.prepayment as { id?: string } | undefined)?.id;

        if (!id) return;

        setPrepaymentId(id);

        try {
          const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}") as Record<string, unknown>;

          localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...saved, prepaymentId: id }));
        } catch {
          // The return URL still carries it.
        }
      },
      preparing: "Setting up the setup-fee payment",
    });
  }

  async function publish() {
    setError("");
    setSubmitErrors({});
    flashProblems();

    if (blocking.length > 0) {
      focusField(blocking[0].field);

      return;
    }

    if (uploading) {
      setError("Wait for the uploads to finish.");

      return;
    }

    if (method === "CASH" && !feeValid) {
      setSubmitErrors({ amount: `The setup fee is 1 to ${rupees(setupFee ?? 0)} — never more.` });
      focusField("amount");

      return;
    }

    /*
     * The last gate before a hostel is public.
     *
     * Everything else on this form can be corrected afterwards from the admin
     * portal. This cannot: the listing goes live, the owner is emailed, and an
     * invoice with somebody's money against it exists. So the agent is told in
     * plain figures what they are about to do and has to say yes to it.
     */
    /*
     * Refused here rather than left to the server, so the agent is taken to the
     * one field that is wrong instead of reading a banner about it. The server
     * refuses the same thing if this is ever bypassed.
     */
    if (emailProblem) {
      setError(emailProblem);
      focusField("email");

      return;
    }

    const confirmed = await confirm({
      actionLabel: "Publish the hostel",
      description: [
        planLocked
          ? `${hostelName.trim()} goes live now, on the ${plan?.name} plan at ${rupees(price)}.`
          : `${hostelName.trim()} goes live now, on the ${plan?.name} plan${plan?.freeMonths ? `, free for ${plan.freeMonths} months if this building has not had them before` : ""}.`,
        // Only reached with money in (`blocking`), so it is one or the other.
        paidOnline
          ? `${rupees(paidOnline.amount)} paid online${paidOnline.reference ? ` (${paidOnline.reference})` : ""} is attached to it.`
          : `${rupees(collecting)} setup fee in cash is filed with Softmato; the owner's receipt follows once it is confirmed.`,
        "The owner will be emailed that their hostel is published, with the amount you collected.",
      ].join(" "),
      title: "Publish this hostel?",
    });

    if (!confirmed) {
      return;
    }

    setSubmitting(true);

    // Kept, not rebuilt in the catch: the server's array indices point into
    // exactly this object.
    const payload = {
      ...buildPayload(),
      ...(confirmSecondHostel ? { confirmSecondHostel: true } : {}),
    };

    try {
      const result = await browserApi<{ hostel: { id: string } }>(
        "/api/v1/team/hostels",
        { body: JSON.stringify(payload), method: "POST" },
      );

      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        // Nothing to do — a leftover draft is a stale form, not a lost hostel.
      }

      // Straight on to the people already living there — the owner is usually
      // still at the counter, which is the easiest moment to fill that list.
      // Online money was taken on Plan & payment, before this, so nothing opens here.
      router.push(`/team/hostels/${result.hostel.id}/residents?published=1`);
    } catch (err) {
      setSubmitting(false);

      /*
       * A 422 names every field it refused. Each one is filed under its input,
       * and the agent is taken to the earliest — the same place they would have
       * started if they were fixing it by hand.
       */
      if (
        err instanceof ApiRequestError &&
        (err.errorCode === "HOSTEL_ALREADY_LISTED" ||
          err.errorCode === "OWNER_ALREADY_HAS_HOSTEL")
      ) {
        setDuplicate({ code: err.errorCode, message: err.message });

        return;
      }

      const issues = validationIssues(err);
      const found: FieldErrors = {};
      let first: { day?: RoutineDay; field: string } | null = null;

      for (const issue of issues) {
        const target = fieldForPath(issue.path, payload);

        if (!target || found[target.field]) {
          continue;
        }

        found[target.field] =
          plainMessage(issue.message, target.field) +
          (target.day ? ` (${titleCase(target.day)})` : "");

        if (!first || stepOfField(target.field) < stepOfField(first.field)) {
          first = target;
        }
      }

      if (first) {
        setSubmitErrors(found);
        focusField(first.field, first.day);

        return;
      }

      // A refusal we cannot place still says what it was about.
      setError(
        issues.length > 0
          ? `${issues[0].path}: ${plainMessage(issues[0].message, issues[0].path)}`
          : err instanceof Error
            ? err.message
            : "Could not register this hostel.",
      );
    }
  }

  /* ── Render ──────────────────────────────────────────────────────────── */

  return (
    <FieldErrorContext.Provider value={{ clear: clearSubmitError, errors: fieldErrors }}>
    <div className="pb-10">
      {handoff.overlay}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Register a hostel
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Collect everything the owner would otherwise set up themselves. It
            publishes on the last step, not before.
          </p>
        </div>

        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-2">
            <button
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-foreground transition hover:border-brand-teal hover:bg-brand-teal/5"
              onClick={() => {
                const at = new Date().toLocaleTimeString("en-GB", {
                  hour: "2-digit",
                  minute: "2-digit",
                });

                setDraftNotice(
                  writeDraft()
                    ? `Draft saved on this device at ${at}.`
                    : "This browser will not let us save a draft — do not close the tab.",
                );
              }}
              type="button"
            >
              <Save className="size-3.5" />
              Save draft
            </button>

            <button
              className="rounded-lg px-2 py-2 text-xs font-semibold text-muted-foreground transition hover:text-destructive"
              onClick={() => void discardDraft()}
              type="button"
            >
              Start over
            </button>
          </div>

          {/* Autosave is silent by design; this is the receipt for it. */}
          <p aria-live="polite" className="text-[11px] text-muted-foreground">
            {draftNotice || "Saved on this device as you type"}
          </p>
        </div>
      </div>

      {/*
        A duplicate, as the server judged it before writing anything.

        Amber, not red: the agent has done nothing wrong, the platform has
        spotted something they may not know. "Already listed" has no way past —
        it is the same building, and a second listing would split its residents
        and reviews. "Owner already has one" can be a real second building, so
        the agent confirms it and publishes again; the flag rides on that next
        submit and nothing is sent until they press Publish.
      */}
      {duplicate ? (
        <div
          className="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-foreground"
          role="alert"
        >
          <p className="font-semibold">
            {duplicate.code === "HOSTEL_ALREADY_LISTED"
              ? `This hostel is already on ${PLATFORM_NAME}`
              : "This owner already has a hostel"}
          </p>
          <p className="mt-1 text-muted-foreground">{duplicate.message}</p>

          {duplicate.code === "OWNER_ALREADY_HAS_HOSTEL" ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="rounded-lg bg-brand-teal px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
                onClick={() => {
                  setConfirmSecondHostel(true);
                  setDuplicate(null);
                }}
                type="button"
              >
                Yes, it&apos;s a separate building
              </button>
              <button
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted"
                onClick={() => setDuplicate(null)}
                type="button"
              >
                No, don&apos;t register it
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {confirmSecondHostel && !duplicate ? (
        <p className="mb-4 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          Confirmed as a second building for this owner. Press Publish again to register it.
        </p>
      ) : null}

      {error ? (
        <p
          className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm font-medium text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {/*
        Every problem, each one a way straight to it. The review step lists the
        same things in its own card, so this only shows on the other steps.
      */}
      {bannerOpen && showChecks && step !== STEPS.length && problems.length > 0 ? (
        <div
          className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm"
          onMouseEnter={() => setBannerHeld(true)}
          onMouseLeave={() => setBannerHeld(false)}
          role="alert"
        >
          <p className="font-semibold text-destructive">
            {problems.length === 1
              ? "One thing to fix before this can publish"
              : `${problems.length} things to fix before this can publish`}
          </p>
          <ul className="mt-1.5 space-y-1">
            {problems.map((problem) => (
              <li key={problem.field}>
                <button
                  className="text-left text-destructive hover:underline"
                  onClick={() => focusField(problem.field)}
                  type="button"
                >
                  <span className="font-semibold">{problem.label}</span> — {problem.message}
                  <span className="ml-1.5 text-muted-foreground">
                    {STEPS[problem.step - 1].label}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <StepRail
          currentStep={step}
          onStepSelect={goTo}
          stepComplete={stepComplete}
          steps={STEPS}
        />

        <StepFlow className="min-w-0 space-y-5" stepKey={step}>
          {step === 1 ? (
            <>
              <Card subtitle="Who owns it and how to reach them." title="Owner">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Owner name" name="ownerName" required>
                    <input
                      className="input-field w-full"
                      onChange={(event) => setOwnerName(event.target.value)}
                      value={ownerName}
                    />
                  </Field>
                  <Field label="Phone" name="phone" required>
                    <input
                      className="input-field w-full"
                      inputMode="tel"
                      onChange={(event) => setPhone(event.target.value)}
                      value={phone}
                    />
                  </Field>
                  <Field
                    hint="Their invoice, receipt and sign-in details go here."
                    label="Email"
                    name="email"
                  >
                    <div className="relative">
                      <input
                        aria-describedby="owner-email-check"
                        aria-invalid={emailProblem ? true : undefined}
                        className="input-field w-full pr-9"
                        inputMode="email"
                        onChange={(event) => setEmail(event.target.value)}
                        type="email"
                        value={email}
                      />
                      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
                        {emailCheck.state === "checking" ? (
                          <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        ) : emailProblem ? (
                          <X className="size-4 text-destructive" />
                        ) : emailCheck.state === "AVAILABLE" ||
                          emailCheck.state === "EXISTING_ACCOUNT" ? (
                          <Check className="size-4 text-brand-teal" />
                        ) : null}
                      </span>
                    </div>
                    <span
                      aria-live="polite"
                      className={cn(
                        "mt-1 block text-[11px] font-semibold",
                        emailProblem ? "text-destructive" : "text-muted-foreground",
                        (emailCheck.state === "AVAILABLE" ||
                          emailCheck.state === "EXISTING_ACCOUNT") &&
                          "text-brand-teal",
                      )}
                      id="owner-email-check"
                      role={emailProblem ? "alert" : undefined}
                    >
                      {emailCheck.state === "checking"
                        ? "Checking the email…"
                        : (emailProblem ??
                          (emailCheck.state === "AVAILABLE"
                            ? "Email is free to use."
                            : emailCheck.state === "EXISTING_ACCOUNT"
                              ? "This owner already has an account. The hostel will be added to it."
                              : emailCheck.state === "failed"
                                ? "Could not check this email right now. It is checked again at Publish."
                                : null))}
                    </span>
                  </Field>
                  <Field label="Alternate phone" name="alternatePhone">
                    <input
                      className="input-field w-full"
                      inputMode="tel"
                      onChange={(event) => setAlternatePhone(event.target.value)}
                      value={alternatePhone}
                    />
                  </Field>
                </div>
              </Card>

              <Card subtitle="What the place is and what it is called." title="The hostel">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Hostel name" name="hostelName" required>
                    <input
                      className="input-field w-full"
                      onChange={(event) => setHostelName(event.target.value)}
                      value={hostelName}
                    />
                  </Field>
                  <Field label="Type">
                    <select
                      className="input-field w-full"
                      onChange={(event) =>
                        setHostelType(
                          event.target.value as "BOYS" | "CO_LIVING" | "GIRLS",
                        )
                      }
                      value={hostelType}
                    >
                      <option value="CO_LIVING">Co-living</option>
                      <option value="BOYS">Boys</option>
                      <option value="GIRLS">Girls</option>
                    </select>
                  </Field>
                  <Field label="Year established" name="yearEstablished">
                    <input
                      className="input-field w-full"
                      inputMode="numeric"
                      onChange={(event) => setYearEstablished(event.target.value)}
                      placeholder="2018"
                      value={yearEstablished}
                    />
                  </Field>
                  <Field label="Floors" name="totalFloors">
                    <input
                      className="input-field w-full"
                      inputMode="numeric"
                      onChange={(event) => setTotalFloors(event.target.value)}
                      value={totalFloors}
                    />
                  </Field>
                  <Field hint="Optional. Nine digits." label="PAN/VAT number" name="panNumber">
                    <input
                      className="input-field w-full tabular-nums"
                      inputMode="numeric"
                      onChange={(event) => setPanNumber(event.target.value)}
                      placeholder="601234567"
                      value={panNumber}
                    />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field
                      hint="Two or three lines. It is the first thing a resident reads."
                      label="Description"
                      name="description"
                    >
                      <textarea
                        className="input-field h-24 w-full py-2"
                        onChange={(event) => setDescription(event.target.value)}
                        value={description}
                      />
                    </Field>
                    <DescriptionSuggestions
                      facts={{ area, city, hostelName, hostelType, yearEstablished }}
                      onChange={setDescription}
                      value={description}
                    />
                  </div>
                </div>
              </Card>
            </>
          ) : null}

          {step === 2 ? (
            <Card subtitle="How somebody actually finds it." title="Where it is">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Area / locality" name="area" required>
                  <input
                    className="input-field w-full"
                    onChange={(event) => setArea(event.target.value)}
                    value={area}
                  />
                </Field>
                <Field label="City" name="city" required>
                  <select
                    className="input-field w-full"
                    onChange={(event) => setCity(event.target.value)}
                    value={city}
                  >
                    {cityOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Address line" name="address">
                  <input
                    className="input-field w-full"
                    onChange={(event) => setAddress(event.target.value)}
                    value={address}
                  />
                </Field>
                <Field
                  hint="Opposite the campus gate, behind the temple."
                  label="Landmark"
                  name="landmark"
                >
                  <input
                    className="input-field w-full"
                    onChange={(event) => setLandmark(event.target.value)}
                    value={landmark}
                  />
                </Field>
                <div className="sm:col-span-2">
                  <Field
                    hint="Kept exactly as the owner sent it, and shown on the listing."
                    label="Maps link"
                    name="mapLink"
                  >
                    <input
                      className="input-field w-full"
                      onChange={(event) => setMapLink(event.target.value)}
                      placeholder="https://maps.app.goo.gl/…"
                      value={mapLink}
                    />
                  </Field>
                </div>
                {/*
                  The pin, not the address text, is what the public map shows and
                  what the nearby colleges, hospitals and parks are measured from.
                  The agent is standing in the building while they fill this in,
                  so this is the one moment the platform can get it exactly right
                  — an address geocoded later lands in the middle of the tole.
                */}
                <ErrorRegion className="space-y-2 sm:col-span-2" name="pin">
                  <div>
                    <p className="text-sm font-bold text-foreground">Exact map pin</p>
                    <p className="text-xs font-medium text-muted-foreground">
                      Paste the maps link above, search for the hostel, use your
                      current location while you are standing at it, or drag the
                      marker onto the gate. Without a pin the listing publishes
                      without a map.
                    </p>
                  </div>
                  <LocationPicker
                    addressHint={[address, area, city].filter(Boolean).join(", ")}
                    lookupPath="/api/v1/team/geocode"
                    onChange={setPin}
                    onResolvedAddress={(parts) => {
                      // The picker resolved a real place; let it fill in what
                      // the agent has not typed rather than overwriting them.
                      if (parts.address && !address.trim()) setAddress(parts.address);
                      if (parts.area && !area.trim()) setArea(parts.area);
                      if (parts.city && cityOptions.includes(parts.city)) {
                        setCity(parts.city);
                      }
                    }}
                    value={pin}
                  />
                </ErrorRegion>
              </div>
            </Card>
          ) : null}

          {step === 3 ? (
            <>
              <Card
                subtitle="One row per kind of room. The totals below come from these."
                title="Rooms"
              >
                <ErrorRegion className="space-y-2" name="rooms">
                  {rooms.map((room) => {
                    const cell = (key: RoomKey) => `room:${room.id}:${key}`;
                    const invalid = (key: RoomKey) =>
                      Boolean(fieldErrors[cell(key)]) || undefined;
                    const rowErrors = (Object.keys(ROOM_KEY_LABEL) as RoomKey[]).flatMap(
                      (key) => {
                        const message = fieldErrors[cell(key)];

                        return message ? [`${ROOM_KEY_LABEL[key]}: ${message}`] : [];
                      },
                    );

                    return (
                      <div key={room.id}>
                        <div className="flex flex-wrap items-end gap-2">
                          <label className="min-w-[9rem] flex-1" data-field={cell("roomType")}>
                            <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">
                              {ROOM_KEY_LABEL.roomType}
                            </span>
                            <select
                              aria-invalid={invalid("roomType")}
                              className="input-field w-full"
                              onChange={(event) => {
                                clearSubmitError(cell("roomType"));
                                setRooms((prev) =>
                                  prev.map((entry) =>
                                    entry.id === room.id
                                      ? editRoomRow(entry, { roomType: event.target.value })
                                      : entry,
                                  ),
                                );
                              }}
                              value={room.roomType}
                            >
                              {roomTypeOptions.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </select>
                          </label>

                          {(["rooms", "bedsPerRoom", "vacantBeds", "monthlyRent"] as const).map(
                            (key) => (
                              <label className="w-20" data-field={cell(key)} key={key}>
                                <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">
                                  {ROOM_KEY_LABEL[key]}
                                </span>
                                <input
                                  aria-invalid={invalid(key)}
                                  className="input-field w-full"
                                  inputMode="numeric"
                                  onChange={(event) => {
                                    clearSubmitError(cell(key));
                                    setRooms((prev) =>
                                      prev.map((entry) =>
                                        entry.id === room.id
                                          ? editRoomRow(entry, { [key]: event.target.value })
                                          : entry,
                                      ),
                                    );
                                  }}
                                  value={room[key]}
                                />
                              </label>
                            ),
                          )}

                          <button
                            aria-label="Remove this room type"
                            className="rounded-lg border border-border p-2.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                            disabled={rooms.length === 1}
                            onClick={() =>
                              setRooms((prev) => prev.filter((entry) => entry.id !== room.id))
                            }
                            type="button"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </div>

                        {rowErrors.length > 0 ? (
                          <p className="mt-1 text-[11px] font-semibold text-destructive">
                            {rowErrors.join(" · ")}
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                </ErrorRegion>

                <button
                  className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-brand-teal hover:underline"
                  onClick={() => setRooms((prev) => [...prev, newRoom()])}
                  type="button"
                >
                  <Plus className="size-3.5" /> Add room type
                </button>

                <dl className="mt-4 grid grid-cols-3 gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
                  {(
                    [
                      ["Rooms", capacity.totalRooms],
                      ["Beds", capacity.totalBeds],
                      ["Vacant", capacity.vacantBeds],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-[11px] text-muted-foreground">{label}</dt>
                      <dd className="font-bold tabular-nums text-foreground">{value}</dd>
                    </div>
                  ))}
                </dl>
              </Card>

              <Card
                subtitle="Stays of a few nights, booked and paid through us. Ask the owner."
                title="Short stays"
              >
                <RegistrationShortStays onChange={setShortStays} rooms={rooms} value={shortStays} />
              </Card>

              <Card
                subtitle="The rents above plus these figures become the hostel's rate card — what every resident is billed from, from today."
                title="Rate card"
              >
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field
                    hint="Charged once, when a resident joins."
                    label="Admission fee"
                    name="admissionFee"
                  >
                    <input
                      className="input-field w-full"
                      inputMode="numeric"
                      onChange={(event) => setAdmissionFee(event.target.value)}
                      value={admissionFee}
                    />
                  </Field>
                  <Field
                    hint="Refundable. On the same joining invoice as the admission fee."
                    label="Security deposit"
                    name="securityDeposit"
                  >
                    <input
                      className="input-field w-full"
                      inputMode="numeric"
                      onChange={(event) => setSecurityDeposit(event.target.value)}
                      value={securityDeposit}
                    />
                  </Field>
                  <Field
                    hint="Comes off the admission fee for a referred resident. Never off the rent."
                    label="Referral discount"
                    name="referralDiscount"
                  >
                    <input
                      className="input-field w-full"
                      inputMode="numeric"
                      onChange={(event) => setReferralDiscount(event.target.value)}
                      value={referralDiscount}
                    />
                  </Field>
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
                  <div>
                    <dt className="text-[11px] text-muted-foreground">
                      Rent range on the listing
                    </dt>
                    <dd className="font-bold tabular-nums text-foreground">
                      {rentRange
                        ? rentRange.min === rentRange.max
                          ? rupees(rentRange.min)
                          : `${rupees(rentRange.min)} – ${rupees(rentRange.max)}`
                        : "Add rents above"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-muted-foreground">
                      A resident pays on joining
                    </dt>
                    <dd className="font-bold tabular-nums text-foreground">
                      {rupees(
                        (numberValue(admissionFee) ?? 0) +
                          (numberValue(securityDeposit) ?? 0),
                      )}
                    </dd>
                  </div>
                </dl>
              </Card>
            </>
          ) : null}

          {step === 4 ? (
            <Card
              subtitle="The listing leads with an exterior. Room shots attach to the room type they are of."
              title="Photos"
            >
              <ErrorRegion className="space-y-5" name="photos">
                <PhotoStrip
                  busy={false}
                  kind="EXTERIOR"
                  label="Outside the building"
                  onAdd={addPhotos}
                  onOpen={openPhoto}
                  onRemove={(id) =>
                    setPhotos((prev) => prev.filter((photo) => photo.id !== id))
                  }
                  photos={photos}
                />
                <PhotoStrip
                  busy={false}
                  kind="INTERIOR"
                  label="Inside — common areas, kitchen, study room"
                  onAdd={addPhotos}
                  onOpen={openPhoto}
                  onRemove={(id) =>
                    setPhotos((prev) => prev.filter((photo) => photo.id !== id))
                  }
                  photos={photos}
                />

                {roomTypeNames.length === 0 ? (
                  <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                    Add a room type on the previous step to attach room photos to
                    it.
                  </p>
                ) : (
                  roomTypeNames.map((name) => (
                    <PhotoStrip
                      busy={false}
                      key={name}
                      kind="ROOM"
                      label={name}
                      onAdd={addPhotos}
                      onOpen={openPhoto}
                      onRemove={(id) =>
                        setPhotos((prev) => prev.filter((photo) => photo.id !== id))
                      }
                      photos={photos}
                      roomType={name}
                    />
                  ))
                )}
              </ErrorRegion>
            </Card>
          ) : null}

          {step === 5 ? (
            <>
              <Card subtitle="What the hostel has." title="Facilities">
                <ErrorRegion className="flex flex-wrap gap-2" name="facilities">
                  {[...facilityOptions, ...custom].map((facility) => {
                    const active = facilities.includes(facility);
                    const isCustom = custom.includes(facility);

                    return (
                      <button
                        className={cn(
                          "rounded-lg border px-3 py-1.5 text-xs font-semibold transition",
                          active
                            ? "border-brand-teal bg-brand-teal/10 text-brand-teal"
                            : "border-border text-muted-foreground hover:border-brand-teal/40",
                        )}
                        key={facility}
                        onClick={() =>
                          setFacilities((prev) =>
                            prev.includes(facility)
                              ? prev.filter((item) => item !== facility)
                              : [...prev, facility],
                          )
                        }
                        type="button"
                      >
                        {facility}
                        {isCustom ? <span className="ml-1 opacity-50">&times;</span> : null}
                      </button>
                    );
                  })}
                </ErrorRegion>

                <div className="mt-3 flex gap-2">
                  <input
                    className="input-field min-w-0 flex-1"
                    onChange={(event) => setCustomFacility(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addFacility();
                      }
                    }}
                    placeholder="Something else they have"
                    value={customFacility}
                  />
                  <button
                    className="shrink-0 rounded-lg border border-border px-4 text-xs font-semibold text-foreground transition hover:border-brand-teal hover:bg-brand-teal/5 disabled:opacity-40"
                    disabled={!customFacility.trim()}
                    onClick={addFacility}
                    type="button"
                  >
                    Add
                  </button>
                </div>
              </Card>

              <Card subtitle="What the kitchen serves." title="Food">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Kitchen">
                    <div className="flex gap-2">
                      {(
                        [
                          ["Veg", hasVeg, setHasVeg],
                          ["Non-veg", hasNonVeg, setHasNonVeg],
                        ] as const
                      ).map(([label, active, set]) => (
                        <button
                          className={cn(
                            "flex-1 rounded-lg border px-3 py-2.5 text-xs font-semibold transition",
                            active
                              ? "border-brand-teal bg-brand-teal/10 text-brand-teal"
                              : "border-border text-muted-foreground hover:border-brand-teal/40",
                          )}
                          key={label}
                          onClick={() => set(!active)}
                          type="button"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </Field>
                  <Field label="Meals a day" name="mealsPerDay">
                    <input
                      className="input-field w-full"
                      inputMode="numeric"
                      onChange={(event) => setMealsPerDay(event.target.value)}
                      value={mealsPerDay}
                    />
                  </Field>
                  <Field
                    hint="How many cooks the kitchen runs. Sets the plan's cook seats."
                    label="Cooks"
                    name="cookCount"
                  >
                    <input
                      className="input-field w-full"
                      inputMode="numeric"
                      onChange={(event) => setCookCount(event.target.value)}
                      value={cookCount}
                    />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label="Notes" name="foodNotes">
                      <input
                        className="input-field w-full"
                        onChange={(event) => setFoodNotes(event.target.value)}
                        placeholder="Special meal every Saturday"
                        value={foodNotes}
                      />
                    </Field>
                  </div>
                </div>
              </Card>

              <Card
                subtitle="Timings apply to the whole week. Items are per day — fill one day and copy it across."
                title="Weekly routine"
              >
                <div className="grid gap-3 sm:grid-cols-4">
                  {MEAL_TYPES.map((meal) => (
                    <Field key={meal} label={`${titleCase(meal)} time`} name={`timing:${meal}`}>
                      <input
                        className="input-field w-full"
                        onChange={(event) =>
                          setTimings((prev) => ({ ...prev, [meal]: event.target.value }))
                        }
                        placeholder="7:30 am"
                        value={timings[meal] ?? ""}
                      />
                    </Field>
                  ))}
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-1">
                  {ROUTINE_DAYS.map((day) => (
                    <button
                      className={cn(
                        "rounded-lg px-3 py-1.5 text-xs font-semibold transition",
                        routineDay === day
                          ? "bg-brand-teal text-white"
                          : "text-muted-foreground hover:bg-muted",
                      )}
                      key={day}
                      onClick={() => setRoutineDay(day)}
                      type="button"
                    >
                      {shortDay(day)}
                    </button>
                  ))}
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2" data-field="routine">
                  {MEAL_TYPES.map((meal) => (
                    <Field key={meal} label={titleCase(meal)} name={`routine:${meal}`}>
                      <input
                        className="input-field w-full"
                        onChange={(event) =>
                          setRoutineItems(routineDay, meal, event.target.value)
                        }
                        placeholder="Dal, Bhat, Tarkari"
                        value={routine[`${routineDay}:${meal}`] ?? ""}
                      />
                    </Field>
                  ))}
                </div>

                <button
                  className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-brand-teal hover:underline"
                  onClick={() => copyDayToAll(routineDay)}
                  type="button"
                >
                  <Check className="size-3.5" />
                  Use {titleCase(routineDay)} for every day
                </button>
              </Card>
            </>
          ) : null}

          {step === 6 ? (
            <>
            <Card subtitle="The owner's ID is required. The rest if they have it." title="Documents">
              <FieldError name="documents" />
              <div className="space-y-4" data-field="documents">
                <div className="grid gap-4 rounded-xl border-2 border-brand-teal/40 bg-brand-teal/[0.03] p-4 md:grid-cols-[1fr_1.2fr] md:items-start">
                  <div className="flex items-start gap-3">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-teal/10 text-brand-teal">
                      <IdCard className="size-5" />
                    </span>
                    <div>
                      <p className="text-sm font-bold text-foreground">
                        Government ID Proof <span className="text-destructive">*</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        The owner&apos;s citizenship, NID or passport. Front and back if it
                        has two sides.
                      </p>
                    </div>
                  </div>
                  <div className="space-y-2.5">
                    <label className="block text-xs font-semibold text-foreground">
                      ID document type <span className="text-destructive">*</span>
                      <select
                        className="input-field mt-1"
                        onChange={(event) => chooseIdProofType(event.target.value as IdProofType)}
                        value={idProofType}
                      >
                        <option value="">Select ID type…</option>
                        {ID_PROOF_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </select>
                    </label>
                    <FileUploadArea
                      label={idProofType ? `Upload ${idProofType}` : "Select an ID type first, then upload"}
                      maxFiles={2}
                      {...docSlot(idProofType || "Owner ID proof", isIdDocument, 2)}
                    />
                  </div>
                </div>

                <p className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <span className="h-px flex-1 bg-border" /> Optional supporting documents{" "}
                  <span className="h-px flex-1 bg-border" />
                </p>

                {SUPPORTING_DOCS.map((slot) => (
                  <DocSlotRow desc={slot.desc} icon={slot.icon} key={slot.type} title={slot.title}>
                    <FileUploadArea label={`Upload ${slot.title}`} {...docSlot(slot.type)} />
                  </DocSlotRow>
                ))}

                {otherDocuments.length > 0 ? (
                  <DocSlotRow desc="Uploaded earlier in this draft." icon={FileText} title="Other documents">
                    <FileUploadArea
                      files={otherDocuments}
                      maxFiles={otherDocuments.length}
                      onFileSelect={async () => {}}
                      onRemove={removeDocument}
                    />
                  </DocSlotRow>
                ) : null}
              </div>
            </Card>

            <Card
              subtitle="One rule per line. Start from a template and edit what differs."
              title="House rules"
            >
              <div className="mb-3 flex flex-wrap gap-2">
                {RULES_TEMPLATES.map((template) => (
                  <button
                    className="rounded-lg border border-dashed border-border px-3 py-1.5 text-left text-xs font-semibold text-foreground transition hover:border-brand-teal hover:bg-brand-teal/5"
                    key={template.id}
                    onClick={() => applyRulesTemplate(template.id)}
                    type="button"
                  >
                    {template.name}
                  </button>
                ))}
              </div>

              <ErrorRegion name="rules">
                <textarea
                  aria-invalid={Boolean(fieldErrors.rules) || undefined}
                  className="input-field h-auto min-h-40 w-full resize-y py-2"
                  onChange={(event) => setRules(event.target.value)}
                  placeholder={"Gate closes at 10:00 PM\nNo smoking indoors"}
                  value={rules}
                />
              </ErrorRegion>
            </Card>
            </>
          ) : null}

          {step === 7 ? (
            <>
              <Card
                subtitle="Optional. Where we send their share of bookings — they can add it later from Payment Setup."
                title="Booking payouts"
              >
                <PayoutAccountFields onChange={setPayout} value={payout} />
              </Card>

              <Card
                subtitle="Nothing is paid for the plan today: it starts on its free months."
                title="Plan"
              >
                <div className="mb-4 inline-flex rounded-lg border border-border bg-muted/50 p-1">
                  {cycles.map((option) => {
                    const saving = bestDiscountPercent(catalog, option.id);

                    return (
                      <button
                        className={cn(
                          "rounded-md px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed",
                          cycle === option.id
                            ? "bg-surface text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground",
                        )}
                        // Paid for one cycle before setup fees; a different one would be a different price.
                        disabled={planLocked}
                        key={option.id}
                        onClick={() => setCycle(option.id)}
                        type="button"
                      >
                        {option.label}
                        {saving > 0 ? (
                          <span className="ml-1 text-brand-teal">−{saving}%</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>

                {priced.length === 0 ? (
                  <p className="rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
                    No plans are published yet. A superadmin sets them in Website
                    Config → Plans &amp; Pricing.
                  </p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-field="plan">
                    {priced.map((entry) => {
                      const selected = entry.id === planId;

                      return (
                        <button
                          className={cn(
                            "rounded-xl border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-50",
                            selected
                              ? "border-brand-teal bg-brand-teal/5 ring-1 ring-brand-teal/30"
                              : "border-border bg-surface hover:border-brand-teal/40",
                          )}
                          disabled={planLocked && entry.id !== paidOnline?.planId}
                          key={entry.id}
                          onClick={() => setPlanId(entry.id)}
                          type="button"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-bold text-foreground">
                              {entry.name}
                            </p>
                            {selected ? (
                              <span className="flex size-5 items-center justify-center rounded-full bg-brand-teal text-white">
                                <Check className="size-3" strokeWidth={3} />
                              </span>
                            ) : null}
                          </div>

                          {entry.freeMonths ? (
                            <p className="mt-2 text-xs font-semibold text-brand-teal">
                              {entry.freeMonths} {entry.freeMonths === 1 ? "month" : "months"} free, then
                            </p>
                          ) : null}
                          <p
                            className={cn(
                              "text-lg font-bold tabular-nums text-foreground",
                              entry.freeMonths ? "mt-0.5" : "mt-2",
                            )}
                          >
                            {rupees(cycleTotal(entry, cycle))}
                            <span className="ml-1 text-xs font-medium text-muted-foreground">
                              /{" "}
                              {cycles
                                .find((option) => option.id === cycle)
                                ?.label.toLowerCase()}
                            </span>
                          </p>

                          {entry.description ? (
                            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                              {entry.description}
                            </p>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                )}
                <FieldError name="plan" />

                {plan && !planLocked ? (
                  <p className="mt-4 rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
                    Tell the owner:{" "}
                    {plan.freeMonths
                      ? `this month is free, and ${plan.freeMonths - 1} more after it — no need to recharge until then.`
                      : "the plan is billed from today."}{" "}
                    After that they recharge this hostel themselves from Billing on the
                    website{identity.supportPhone ? `, or call ${identity.supportPhone}` : ""}. A
                    building that has had its free months before is billed from today.
                  </p>
                ) : null}
              </Card>

              <Card
                subtitle={`One-off, collected now. Up to ${rupees(setupFee ?? 0)} — the hostel does not publish until it is paid.`}
                title="Setup fee"
              >
                <div className="flex gap-2">
                  {(
                    [
                      ["SOFTMATO", "Online (recommended)", QrCode],
                      ["CASH", "Cash", Banknote],
                    ] as const
                  ).map(([value, label, Icon]) => (
                    <button
                      className={cn(
                        "flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50",
                        method === value
                          ? "border-brand-teal bg-brand-teal/10 text-brand-teal"
                          : "border-border text-muted-foreground hover:border-brand-teal/40",
                      )}
                      disabled={Boolean(paidOnline) && value !== "SOFTMATO"}
                      key={value}
                      onClick={() => setMethod(value)}
                      type="button"
                    >
                      <Icon className="size-4" />
                      {label}
                    </button>
                  ))}
                </div>

                {method === "SOFTMATO" && paidOnline ? (
                  /* Softmato's figures, not the agent's: read-only. */
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <Field
                      hint={`Paid online${paidOnline.provider ? ` by ${paidOnline.provider}` : ""}${paidOnline.paidAt ? `, ${new Date(paidOnline.paidAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}` : ""}.`}
                      label="Amount collected"
                      name="amount"
                    >
                      <input
                        className="input-field w-full cursor-not-allowed bg-muted/40 font-semibold tabular-nums"
                        readOnly
                        value={rupees(paidOnline.chargeAmount)}
                      />
                    </Field>
                    <Field hint="From Softmato's receipt." label="Reference" name="paymentReference">
                      <input
                        className="input-field w-full cursor-not-allowed bg-muted/40 font-mono"
                        readOnly
                        value={paidOnline.reference ?? "—"}
                      />
                    </Field>
                  </div>
                ) : (
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <Field
                      hint={`Whole rupees, 1 to ${rupees(setupFee ?? 0)}. Lower it if you agreed less; never more.`}
                      label="Setup fee"
                      name="amount"
                    >
                      <input
                        className="input-field w-full tabular-nums"
                        inputMode="numeric"
                        onChange={(event) => setAmount(event.target.value)}
                        placeholder={setupFee === null ? "" : String(setupFee)}
                        value={amount}
                      />
                    </Field>
                    {method === "CASH" ? (
                      <Field hint="Slip number, if you wrote one." label="Reference" name="paymentReference">
                        <input
                          className="input-field w-full"
                          onChange={(event) => setPaymentReference(event.target.value)}
                          value={paymentReference}
                        />
                      </Field>
                    ) : null}
                  </div>
                )}

                {method === "SOFTMATO" && !paidOnline ? (
                  <div className="mt-4 rounded-lg border border-border bg-muted/30 p-4">
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {prepayment?.status === "OPEN"
                        ? "Not paid yet. If the owner already paid, check again."
                        : "Checkout opens on this screen with a QR the owner scans from their banking app or wallet. You come back here once it is paid."}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        className="inline-flex items-center gap-2 rounded-lg bg-brand-teal px-4 py-2.5 text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-60"
                        disabled={!plan || handoff.busy || !feeValid}
                        onClick={takeOnlinePayment}
                        type="button"
                      >
                        <QrCode className="size-4" />
                        {plan ? `Take payment · ${rupees(fee)}` : "Pick a plan first"}
                      </button>
                      {prepayment?.status === "OPEN" ? (
                        <button
                          className="rounded-lg border border-border px-4 py-2.5 text-sm font-semibold text-foreground transition hover:border-brand-teal/40"
                          onClick={() => setPrepaymentCheck((count) => count + 1)}
                          type="button"
                        >
                          Check again
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {method === "CASH" ? (
                  <div className="mt-4 flex gap-2.5 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs leading-relaxed text-foreground">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                    <p>
                      <strong className="font-semibold">
                        Do not take more than {rupees(setupFee ?? 0)} in cash.
                      </strong>{" "}
                      We call every hostel after registration to confirm what they paid.
                      Taking more than the setup fee, or anything for the plan, is fraud and
                      can lead to legal action.
                    </p>
                  </div>
                ) : null}
              </Card>
            </>
          ) : null}

          {step === 8 ? (
            <>
              <Card
                subtitle="Everything on this form, as the owner will see it."
                title="Review"
              >
                <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                  {(
                    [
                      ["Hostel", hostelName.trim() || "—"],
                      ["Owner", `${ownerName.trim() || "—"} · ${phone.trim() || "—"}`],
                      [
                        "Where",
                        [area.trim(), city.trim()].filter(Boolean).join(", ") || "—",
                      ],
                      [
                        "Rooms",
                        validRooms.length > 0
                          ? `${capacity.totalRooms} rooms · ${capacity.totalBeds} beds · ${capacity.vacantBeds} vacant`
                          : "—",
                      ],
                      [
                        "Rent",
                        rentRange
                          ? rentRange.min === rentRange.max
                            ? rupees(rentRange.min)
                            : `${rupees(rentRange.min)} – ${rupees(rentRange.max)}`
                          : "—",
                      ],
                      ["Photos", String(photos.filter((p) => p.url).length)],
                      ["Facilities", String(facilities.length)],
                      [
                        "Documents",
                        String(documents.filter(isUploadedFile).length),
                      ],
                      [
                        "Plan",
                        plan
                          ? planLocked
                            ? `${plan.name} · ${rupees(price)}`
                            : `${plan.name} · ${plan.freeMonths ? `${plan.freeMonths} months free, then ` : ""}${rupees(price)}`
                          : "—",
                      ],
                      [
                        planLocked ? "Collected" : "Setup fee",
                        paidOnline
                          ? `${rupees(paidOnline.amount)} · online · ${paidOnline.reference ?? "paid"}`
                          : method === "CASH" && collecting > 0
                            ? `${rupees(collecting)} · cash`
                            : "Nothing",
                      ],
                    ] as const
                  ).map(([label, value]) => (
                    <div className="flex justify-between gap-4 text-sm" key={label}>
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="text-right font-semibold text-foreground">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </Card>

              {problems.length > 0 ? (
                <Card
                  subtitle="These have to be right before the hostel can publish. Each one takes you to the box."
                  title="Still to fix"
                >
                  <ul className="space-y-1.5">
                    {problems.map((item) => (
                      <li key={item.field}>
                        <button
                          className="text-left text-sm text-destructive hover:underline"
                          onClick={() => focusField(item.field)}
                          type="button"
                        >
                          <span className="font-semibold">{item.label}</span> — {item.message}
                          <span className="ml-1.5 text-muted-foreground">
                            {STEPS[item.step - 1].label}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}

              {recommendations.length > 0 ? (
                <Card
                  subtitle="The hostel will publish without these. The listing is thinner for it."
                  title="Worth going back for"
                >
                  <ul className="space-y-1.5">
                    {recommendations.map((item) => (
                      <li key={item.label}>
                        <button
                          className="text-sm font-semibold text-foreground hover:underline"
                          onClick={() => focusField(item.field)}
                          type="button"
                        >
                          {item.label}
                          <span className="ml-1.5 font-normal text-muted-foreground">
                            {STEPS[item.step - 1].label}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                <button
                  className="inline-flex items-center gap-2 rounded-lg bg-brand-teal px-6 py-3 text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-50"
                  // Not disabled while something is wrong: pressing it is how
                  // the agent gets taken to the first thing to fix.
                  disabled={submitting || uploading}
                  onClick={() => void publish()}
                  type="button"
                >
                  {submitting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Building2 className="size-4" />
                  )}
                  Review and publish
                </button>
              </div>
            </>
          ) : null}

          {/* Bottom navigation. The last step has its own button. */}
          {step < STEPS.length ? (
            <div className="flex items-center justify-between gap-3 pt-1">
              <button
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2.5 text-sm font-semibold text-foreground transition hover:bg-muted disabled:opacity-40"
                disabled={step === 1}
                onClick={() => goTo(step - 1)}
                type="button"
              >
                <ArrowLeft className="size-4" /> Back
              </button>
              <button
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-teal px-5 py-2.5 text-sm font-bold text-white transition hover:brightness-110"
                onClick={() => goTo(step + 1)}
                type="button"
              >
                Continue <ArrowRight className="size-4" />
              </button>
            </div>
          ) : null}
        </StepFlow>
      </div>

      {confirmDialog}
    </div>
    </FieldErrorContext.Provider>
  );
}
