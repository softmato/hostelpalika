"use client";

import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Bed,
  Building2,
  Check,
  CheckCircle2,
  ChefHat,
  Clock,
  Copy,
  CreditCard,
  FileText,
  IdCard,
  Image as ImageIcon,
  Info,
  Landmark,
  Loader2,
  Lock,
  MapPin,
  Pencil,
  Plus,
  Save,
  ScrollText,
  Search,
  Send,
  ShieldCheck,
  Smartphone,
  Star,
  Trash2,
  Upload,
  UserRound,
  Users,
  Utensils,
  Wifi,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { useReferralCodeFromUrl } from "@/app/_components/register-hostel-start";
import { checkAuthWithRefresh } from "@/lib/auth-check";
import {
  EMPTY_PAYOUT_DRAFT,
  PayoutAccountFields,
  payoutAccountPayload,
} from "@/components/bookings/payout-account-fields";
import { ApiRequestError, browserApi } from "@/lib/browser-api";
import { DescriptionSuggestions } from "./description-suggestions";
import { HostelRegistrationProgress } from "./hostel-registration-progress";
import { StepFlow, StepRail } from "./registration-step-shell";
import {
  cityOptions,
  facilityOptions,
  DocRow,
  FileUploadArea,
  ID_PROOF_TYPES,
  BEDS_BY_ROOM_TYPE,
  editRoomRow,
  numberValue,
  RULES_TEMPLATES,
  roomTypeOptions,
  isUploadedFile,
  submittedDocuments,
  type IdProofType,
  type RulesTemplate,
  type UploadedFile,
} from "./registration-fields";
import { acceptAttribute } from "@/lib/uploads/accepts";
import { uploadRegistrationDocument } from "@/lib/uploads/registration-document";
import { uploadFile } from "@/lib/uploads/uploader";
import { cn } from "@/lib/utils";

import { PublicShell } from "./shared";
import { SiteName } from "@/components/site-config-provider";
import { useSiteConfig } from "@/components/site-config-provider";
import { useConfirm } from "@/app/_components/confirm-dialog";
import { useHasResidentIdCard } from "@/lib/use-resident-id-card";
import { readRenamedStorage } from "@/lib/storage-rename";
import {
  EMPTY_SHORT_STAYS,
  RegistrationShortStays,
  shortStaysPayload,
  type ShortStayDraft,
} from "@/app/_components/registration-short-stays";

type MealInclusion = "Included" | "Not Included" | "Optional";

type RoomConfig = {
  bedsPerRoom: string;
  id: string;
  mealInclusion: MealInclusion;
  monthlyRent: string;
  rooms: string;
  roomType: string;
  securityDeposit: string;
  vacantBeds: string;
};

type DraftData = {
  address: string;
  admissionFee: string;
  agreed: boolean;
  alternatePhone: string;
  area: string;
  bankDoc: UploadedFile[];
  city: string;
  cookCount: string;
  description: string;
  email: string;
  exteriorPhotos: UploadedFile[];
  facilities: string[];
  foodAvailability: "extra" | "included" | "none";
  hasNonVeg: boolean;
  hasVeg: boolean;
  hostelName: string;
  hostelType: "BOYS" | "CO_LIVING" | "GIRLS";
  idProofType: IdProofType;
  landmark: string;
  licenseDoc: UploadedFile[];
  mapLink: string;
  mealsPerDay: string;
  ownerAge: string;
  ownerGender: "" | "Female" | "Male" | "Other";
  ownerIdDoc: UploadedFile[];
  ownerName: string;
  ownershipDoc: UploadedFile[];
  panDoc: UploadedFile[];
  phone: string;
  roomPhotos: UploadedFile[];
  rooms: RoomConfig[];
  rules: string;
  rulesDoc: UploadedFile[];
  rulesTemplateId: string | null;
  savedAt: string;
  shortStays?: ShortStayDraft;
  step: number;
  panNumber: string;
  totalCapacity: string;
  totalFloors: string;
  yearEstablished: string;
};

export type OwnerApplication = {
  hostelId: string;
  hostelName: string;
  hostelStatus: string;
  id: string;
  infoRequestNote: string;
  rejectionReason: string;
  requestedDocuments: { documentType: string; note: string }[];
  status: "PENDING" | "APPROVED" | "REJECTED" | "NEEDS_MORE_INFO";
  submittedAt: string;
  verificationStatus: string;
};

const DRAFT_STORAGE_PREFIX = "hostelpalika:hostel-registration-draft:";
const SUBMITTED_STORAGE_PREFIX = "hostelpalika:hostel-submitted:";
/* Pre-rename spellings. Read through `readRenamedStorage`, which moves a value
 * up to the new key the first time it sees one — a draft here is somebody's
 * unfinished registration, and a submitted marker is what stops them being
 * shown a blank form for a hostel they already filed. */
const LEGACY_DRAFT_STORAGE_PREFIX = "hostelhub:hostel-registration-draft:";
const LEGACY_SUBMITTED_STORAGE_PREFIX = "hostelhub:hostel-submitted:";

function draftStorageKey(accountKey: string) {
  return `${DRAFT_STORAGE_PREFIX}${accountKey}`;
}

function submittedStorageKey(accountKey: string) {
  return `${SUBMITTED_STORAGE_PREFIX}${accountKey}`;
}

function readDraft(accountKey: string) {
  return readRenamedStorage(
    window.localStorage,
    draftStorageKey(accountKey),
    `${LEGACY_DRAFT_STORAGE_PREFIX}${accountKey}`,
  );
}

function readSubmittedMarker(accountKey: string) {
  return readRenamedStorage(
    window.localStorage,
    submittedStorageKey(accountKey),
    `${LEGACY_SUBMITTED_STORAGE_PREFIX}${accountKey}`,
  );
}

type SubmittedMarker = {
  applicationId?: string;
  hostelId: string;
  hostelName?: string;
  submittedAt?: string;
};

// Build a placeholder status object from the locally-remembered submission so
// the status screen is consistent on refresh even if the server lookup can't
// match the signed-in user to the applicant record yet.
function markerToApplication(marker: SubmittedMarker): OwnerApplication {
  return {
    hostelId: marker.hostelId,
    hostelName: marker.hostelName || "Your hostel",
    hostelStatus: "PENDING_APPROVAL",
    id: marker.applicationId || "",
    infoRequestNote: "",
    rejectionReason: "",
    requestedDocuments: [],
    status: "PENDING",
    submittedAt: marker.submittedAt || "",
    verificationStatus: "PENDING",
  };
}

const ROOM_TYPE_META: Record<string, { icon: LucideIcon; tone: string }> = {
  "Double Sharing": { icon: Users, tone: "bg-blue-50 text-blue-600" },
  Dormitory: { icon: Building2, tone: "bg-amber-50 text-amber-600" },
  "Four Sharing": { icon: Users, tone: "bg-rose-50 text-rose-600" },
  "Single Room": { icon: Bed, tone: "bg-emerald-50 text-emerald-600" },
  "Triple Sharing": { icon: Users, tone: "bg-violet-50 text-violet-600" },
};

const PORTALS: {
  app: boolean;
  desc: string;
  icon: LucideIcon;
  title: string;
  web: boolean;
}[] = [
  {
    app: true,
    desc: "Manage residents, rooms, payments & notices.",
    icon: ShieldCheck,
    title: "Hostel Warden Portal",
    web: true,
  },
  {
    app: true,
    desc: "Residents view dues, food menu & raise complaints.",
    icon: UserRound,
    title: "Resident Portal",
    web: true,
  },
  {
    app: true,
    desc: "Cooks update daily menu & meal proof.",
    icon: ChefHat,
    title: "Cook App",
    web: false,
  },
  {
    app: true,
    desc: "Guardians track safety & attendance.",
    icon: Users,
    title: "Guardian App",
    web: false,
  },
];

/**
 * Registration happens before the owner has an account, so files go through the
 * rate-limited public multipart route. This one publishes a photo and returns its
 * URL; documents are stored privately by `uploadRegistrationDocument`. Progress,
 * validation and error reporting are the universal uploader's job.
 */
async function uploadPublicPhoto(file: File, label: string): Promise<string> {
  const uploaded = await uploadFile(file, {
    kind: "image",
    label,
    silent: true,
    target: "public",
    visibility: "public",
  });

  if (!uploaded?.url) {
    throw new Error("Upload failed");
  }

  return uploaded.url;
}

function createRoom(roomType = "Single Room"): RoomConfig {
  return {
    bedsPerRoom: BEDS_BY_ROOM_TYPE[roomType] ? String(BEDS_BY_ROOM_TYPE[roomType]) : "",
    id: crypto.randomUUID(),
    mealInclusion: "Included",
    monthlyRent: "",
    rooms: "",
    roomType,
    securityDeposit: "",
    vacantBeds: "",
  };
}

const FIELD_KEY_STEP: Record<string, number> = {
  applicant: 1,
  contact: 1,
  description: 1,
  food: 1,
  hostelType: 1,
  name: 1,
  panNumber: 1,
  yearEstablished: 1,
  facilities: 2,
  landmark: 2,
  location: 2,
  mapLink: 2,
  rules: 2,
  pricing: 3,
  roomConfigurations: 3,
  roomTypes: 3,
  totalFloors: 3,
  documents: 4,
  photos: 4,
};

function humanizeFieldKey(key: string) {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function PortalPill({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-brand-teal/10 px-2 py-0.5 text-[10px] font-bold text-brand-teal">
      {label === "Web" ? (
        <Landmark className="size-2.5" />
      ) : (
        <Smartphone className="size-2.5" />
      )}
      {label}
    </span>
  );
}

function PortalsCard({ className }: { className?: string }) {
  return (
    <div className={cn("app-card p-5", className)}>
      <div className="flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-lg bg-brand-teal/10 text-brand-teal">
          <BadgeCheck className="size-4.5" />
        </span>
        <div>
          <h3 className="text-sm font-bold text-foreground">
            What you&apos;ll get after approval
          </h3>
          <p className="text-[11px] text-muted-foreground">
            Dedicated portals for your whole team.
          </p>
        </div>
      </div>
      <div className="mt-4 space-y-3">
        {PORTALS.map((portal) => (
          <div className="flex items-start gap-3" key={portal.title}>
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-brand-teal">
              <portal.icon className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="text-xs font-bold text-foreground">{portal.title}</p>
                {portal.web ? <PortalPill label="Web" /> : null}
                {portal.app ? <PortalPill label="App" /> : null}
              </div>
              <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                {portal.desc}
              </p>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 rounded-lg bg-brand-teal/5 px-3 py-2 text-[11px] font-medium text-brand-teal">
        Your shared cook login is generated automatically once your hostel is approved.
        You create warden logins yourself from your dashboard.
      </p>
    </div>
  );
}

/**
 * Registration-specific file field. It keeps its own row list because the
 * wizard persists document URLs into the saved draft, but accept rules, hint
 * copy and the upload itself all come from the universal uploader.
 */
export function PublicHostelRegistrationPage() {
  const siteName = useSiteConfig().identity.siteName;
  // Approval re-issues an existing resident card as an owner card, so anyone
  // holding one is told before they submit rather than after it changes.
  const hasResidentCard = useHasResidentIdCard();
  const { confirm, confirmDialog } = useConfirm();
  const hostelNameRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const ownerNameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLInputElement>(null);
  const roomsSectionRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(1);
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // From the landing page's referral step (`?ref=`). Checked again on submit.
  const referralFromUrl = useReferralCodeFromUrl();
  const [referralRemoved, setReferralRemoved] = useState(false);
  const referralCode = referralRemoved ? "" : referralFromUrl;
  const [message, setMessage] = useState("");
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [existingApplication, setExistingApplication] = useState<OwnerApplication | null>(
    null,
  );
  const [startNewRegistration, setStartNewRegistration] = useState(false);
  const [statusChecked, setStatusChecked] = useState(false);

  // Step 1 — Basic Information
  const [hostelName, setHostelName] = useState("");
  const [hostelType, setHostelType] = useState<"BOYS" | "CO_LIVING" | "GIRLS">(
    "CO_LIVING",
  );
  const [yearEstablished, setYearEstablished] = useState("");
  const [panNumber, setPanNumber] = useState("");
  const [shortStays, setShortStays] = useState<ShortStayDraft>(EMPTY_SHORT_STAYS);
  const [totalCapacity, setTotalCapacity] = useState("");
  const [description, setDescription] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerAge, setOwnerAge] = useState("");
  const [ownerGender, setOwnerGender] = useState<"" | "Female" | "Male" | "Other">("");
  const [phone, setPhone] = useState("");
  const [alternatePhone, setAlternatePhone] = useState("");
  const [email, setEmail] = useState("");
  const [mealsPerDay, setMealsPerDay] = useState("3");
  const [hasVeg, setHasVeg] = useState(true);
  const [hasNonVeg, setHasNonVeg] = useState(true);
  const [cookCount, setCookCount] = useState("1");

  // Step 2 — Location & Facilities
  const [country] = useState("Nepal");
  const [city, setCity] = useState("Kathmandu");
  const [area, setArea] = useState("");
  const [address, setAddress] = useState("");
  const [landmark, setLandmark] = useState("");
  const [mapLink, setMapLink] = useState("");
  // Deliberately not part of the saved draft: an account number stays out of localStorage.
  const [payout, setPayout] = useState(EMPTY_PAYOUT_DRAFT);
  const [facilities, setFacilities] = useState<string[]>(["Wi-Fi", "CCTV", "Hot Water"]);
  const [customFacility, setCustomFacility] = useState("");
  const [facilityError, setFacilityError] = useState("");
  const [foodAvailability, setFoodAvailability] = useState<"extra" | "included" | "none">(
    "included",
  );
  const [rules, setRules] = useState("");

  // Step 3 — Rooms & Pricing
  const [totalFloors, setTotalFloors] = useState("1");
  const [rooms, setRooms] = useState<RoomConfig[]>([createRoom("Single Room")]);
  const [admissionFee, setAdmissionFee] = useState("");

  // Step 4 — Documents & Verification
  const [ownershipDoc, setOwnershipDoc] = useState<UploadedFile[]>([]);
  const [ownerIdDoc, setOwnerIdDoc] = useState<UploadedFile[]>([]);
  const [idProofType, setIdProofType] = useState<IdProofType>("");
  const [panDoc, setPanDoc] = useState<UploadedFile[]>([]);
  const [licenseDoc, setLicenseDoc] = useState<UploadedFile[]>([]);
  const [bankDoc, setBankDoc] = useState<UploadedFile[]>([]);
  const [exteriorPhotos, setExteriorPhotos] = useState<UploadedFile[]>([]);
  const [roomPhotos, setRoomPhotos] = useState<UploadedFile[]>([]);
  const [rulesDoc, setRulesDoc] = useState<UploadedFile[]>([]);

  // Rules & policies — template chooser + editable modal
  const [rulesTemplateId, setRulesTemplateId] = useState<string | null>(null);
  const [rulesModalOpen, setRulesModalOpen] = useState(false);
  const [rulesDraft, setRulesDraft] = useState("");
  const idProofSectionRef = useRef<HTMLDivElement>(null);
  const rulesSectionRef = useRef<HTMLDivElement>(null);

  // Set once the signed-in account resolves. Non-empty means the Email field is
  // bound to that account and locked (see the hydrate effect below).
  const [lockedEmail, setLockedEmail] = useState("");

  const [draftAccountKey, setDraftAccountKey] = useState<string | null>(null);
  const [restoredDraftAt, setRestoredDraftAt] = useState<string | null>(null);
  const draftHydratedRef = useRef(false);

  // Resolve which account "slot" a draft belongs to (falls back to a shared
  // anonymous slot pre-login), then silently restore any draft already saved
  // for that slot. This only ever READS storage — the only thing that WRITES
  // a draft is clicking "Save Draft" below.
  useEffect(() => {
    let cancelled = false;

    async function resolveAccountAndHydrate() {
      let accountKey = "anonymous";
      let accountEmail = "";

      try {
        const res = await checkAuthWithRefresh();
        if (!cancelled && res.ok) {
          const payload = await res.json().catch(() => null);
          const id = payload?.data?.user?.id;
          if (id) accountKey = String(id);
          accountEmail = payload?.data?.user?.email ?? "";
        }
      } catch {
        // ignore — fall back to the anonymous slot
      }

      if (cancelled) return;
      setDraftAccountKey(accountKey);

      // Approval mails the owner *account's* address, not this field: on
      // approve the server resolves hostel.ownerId -> User.email. A typo here
      // would create a separate owner account and send the credentials to an
      // address the applicant can't read, so bind the field to the signed-in
      // account and lock it.
      if (accountEmail) {
        setLockedEmail(accountEmail);
        setEmail(accountEmail);
      }

      // Restore the submitted-application status for this account slot so the
      // status screen stays consistent across refreshes. The server lookup is
      // the source of truth; the local marker is a fallback used when the
      // signed-in account can't yet be matched to the applicant record.
      const restoreFromMarker = () => {
        if (cancelled || typeof window === "undefined") return;
        try {
          const rawMarker = readSubmittedMarker(accountKey);
          if (rawMarker) {
            setExistingApplication(
              markerToApplication(JSON.parse(rawMarker) as SubmittedMarker),
            );
          }
        } catch {
          // corrupt marker — ignore
        }
      };

      try {
        const data = await browserApi<{ applications: OwnerApplication[] }>(
          "/api/v1/public/hostel-applications/my-applications",
        );
        if (cancelled) return;
        if (data.applications[0]) {
          setExistingApplication(data.applications[0]);
        } else {
          restoreFromMarker();
        }
      } catch {
        restoreFromMarker();
      } finally {
        if (!cancelled) setStatusChecked(true);
      }

      if (draftHydratedRef.current || typeof window === "undefined") return;
      draftHydratedRef.current = true;

      try {
        const raw = readDraft(accountKey);
        if (!raw) return;
        const draft = JSON.parse(raw) as Partial<DraftData>;

        if (draft.hostelName !== undefined) setHostelName(draft.hostelName);
        if (draft.hostelType !== undefined) setHostelType(draft.hostelType);
        if (draft.yearEstablished !== undefined)
          setYearEstablished(draft.yearEstablished);
        if (draft.panNumber !== undefined) setPanNumber(draft.panNumber);
        if (draft.shortStays !== undefined) setShortStays(draft.shortStays);
        if (draft.totalCapacity !== undefined) setTotalCapacity(draft.totalCapacity);
        if (draft.description !== undefined) setDescription(draft.description);
        if (draft.ownerName !== undefined) setOwnerName(draft.ownerName);
        if (draft.ownerAge !== undefined) setOwnerAge(draft.ownerAge);
        if (draft.ownerGender !== undefined) setOwnerGender(draft.ownerGender);
        if (draft.phone !== undefined) setPhone(draft.phone);
        if (draft.alternatePhone !== undefined) setAlternatePhone(draft.alternatePhone);
        // A locked account email always wins over whatever the draft saved.
        if (draft.email !== undefined && !accountEmail) setEmail(draft.email);
        if (draft.mealsPerDay !== undefined) setMealsPerDay(draft.mealsPerDay);
        if (draft.hasVeg !== undefined) setHasVeg(draft.hasVeg);
        if (draft.hasNonVeg !== undefined) setHasNonVeg(draft.hasNonVeg);
        if (draft.cookCount !== undefined) setCookCount(draft.cookCount);
        if (draft.city !== undefined) setCity(draft.city);
        if (draft.area !== undefined) setArea(draft.area);
        if (draft.address !== undefined) setAddress(draft.address);
        if (draft.landmark !== undefined) setLandmark(draft.landmark);
        if (draft.mapLink !== undefined) setMapLink(draft.mapLink);
        if (draft.facilities !== undefined) setFacilities(draft.facilities);
        if (draft.foodAvailability !== undefined)
          setFoodAvailability(draft.foodAvailability);
        if (draft.rules !== undefined) setRules(draft.rules);
        if (draft.totalFloors !== undefined) setTotalFloors(draft.totalFloors);
        if (draft.rooms !== undefined) setRooms(draft.rooms);
        if (draft.admissionFee !== undefined) setAdmissionFee(draft.admissionFee);
        if (draft.ownershipDoc !== undefined) setOwnershipDoc(draft.ownershipDoc);
        if (draft.ownerIdDoc !== undefined) setOwnerIdDoc(draft.ownerIdDoc);
        if (draft.panDoc !== undefined) setPanDoc(draft.panDoc);
        if (draft.licenseDoc !== undefined) setLicenseDoc(draft.licenseDoc);
        if (draft.bankDoc !== undefined) setBankDoc(draft.bankDoc);
        if (draft.exteriorPhotos !== undefined) setExteriorPhotos(draft.exteriorPhotos);
        if (draft.roomPhotos !== undefined) setRoomPhotos(draft.roomPhotos);
        if (draft.rulesDoc !== undefined) setRulesDoc(draft.rulesDoc);
        if (draft.rulesTemplateId !== undefined)
          setRulesTemplateId(draft.rulesTemplateId);
        if (draft.idProofType !== undefined) setIdProofType(draft.idProofType);
        if (draft.agreed !== undefined) setAgreed(draft.agreed);
        if (draft.step !== undefined) setStep(draft.step);

        setRestoredDraftAt(draft.savedAt ?? null);
      } catch {
        // corrupt/unreadable draft — ignore silently
      }
    }

    void resolveAccountAndHydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  // Once a user has submitted an application, this tab shows its live status
  // (including any documents the platform team has requested) instead of a
  // blank form.
  const refreshApplicationStatus = async () => {
    try {
      const data = await browserApi<{ applications: OwnerApplication[] }>(
        "/api/v1/public/hostel-applications/my-applications",
      );
      if (data.applications[0]) {
        setExistingApplication(data.applications[0]);
        return;
      }
    } catch {
      // fall through to the local marker below
    }
    if (typeof window !== "undefined") {
      try {
        const rawMarker = window.localStorage.getItem(
          submittedStorageKey(draftAccountKey ?? "anonymous"),
        );
        if (rawMarker) {
          setExistingApplication(
            markerToApplication(JSON.parse(rawMarker) as SubmittedMarker),
          );
        }
      } catch {
        // ignore
      }
    }
  };

  function discardDraft() {
    if (draftAccountKey && typeof window !== "undefined") {
      window.localStorage.removeItem(draftStorageKey(draftAccountKey));
    }
    setRestoredDraftAt(null);
  }


  const summary = useMemo(() => {
    return rooms.reduce(
      (s, r) => {
        const roomCount = numberValue(r.rooms) ?? 0;
        const beds = roomCount * (numberValue(r.bedsPerRoom) ?? 0);
        const vacant = numberValue(r.vacantBeds) ?? 0;
        const occupied = Math.max(0, beds - vacant);
        return {
          revenue: s.revenue + occupied * (numberValue(r.monthlyRent) ?? 0),
          totalBeds: s.totalBeds + beds,
          totalRooms: s.totalRooms + roomCount,
          vacantBeds: s.vacantBeds + vacant,
        };
      },
      { revenue: 0, totalBeds: 0, totalRooms: 0, vacantBeds: 0 },
    );
  }, [rooms]);

  const occupiedBeds = Math.max(0, summary.totalBeds - summary.vacantBeds);
  const occupancyPct =
    summary.totalBeds > 0 ? Math.round((occupiedBeds / summary.totalBeds) * 100) : 0;

  const rentValues = rooms
    .map((r) => numberValue(r.monthlyRent))
    .filter((v): v is number => typeof v === "number");

  const allUploaded = [
    ...ownershipDoc,
    ...ownerIdDoc,
    ...panDoc,
    ...licenseDoc,
    ...bankDoc,
    ...exteriorPhotos,
    ...roomPhotos,
    ...rulesDoc,
  ];
  const uploadingFiles = allUploaded.filter((f) => f.uploading).length;
  const uploadedCount = allUploaded.filter(isUploadedFile).length;

  const capacitySummary = {
    totalBeds: summary.totalBeds,
    totalRooms: summary.totalRooms,
    vacantBeds: summary.vacantBeds,
  };

  /**
   * Uploads a picked/dropped batch into one document slot. Rows appear
   * immediately and are removed again if their upload fails — the global
   * toaster reports the reason and offers a retry.
   */
  function uploadIntoSlot(
    setter: React.Dispatch<React.SetStateAction<UploadedFile[]>>,
    label: string,
    visibility: "private" | "public" = "private",
  ) {
    return async (files: File[]) => {
      for (const file of files) {
        const id = crypto.randomUUID();
        setter((prev) => [...prev, { id, name: file.name, url: "", uploading: true }]);
        try {
          const uploaded =
            visibility === "public"
              ? { url: await uploadPublicPhoto(file, label) }
              : await uploadRegistrationDocument(file, label);
          setter((prev) =>
            prev.map((f) => (f.id === id ? { ...f, ...uploaded, uploading: false } : f)),
          );
        } catch {
          setter((prev) => prev.filter((f) => f.id !== id));
        }
      }
    };
  }

  function handleFileSelect(
    setter: React.Dispatch<React.SetStateAction<UploadedFile[]>>,
    label = "Document",
    visibility: "private" | "public" = "private",
  ) {
    return async (e: React.ChangeEvent<HTMLInputElement>) => {
      const input = e.currentTarget;
      const files = Array.from(input.files ?? []);
      if (!files.length) return;
      await uploadIntoSlot(setter, label, visibility)(files);
      input.value = "";
    };
  }

  /** Wires one document slot's pick, drop and remove handlers in one spread. */
  function docSlot(
    setter: React.Dispatch<React.SetStateAction<UploadedFile[]>>,
    label: string,
    visibility: "private" | "public" = "private",
  ) {
    return {
      onFileSelect: handleFileSelect(setter, label, visibility),
      onFilesDropped: uploadIntoSlot(setter, label, visibility),
      onRemove: (id: string) => setter((prev) => prev.filter((file) => file.id !== id)),
    };
  }

  // Turn rules & policies text into a .txt file uploaded for this user, stored
  // as the single rulesDoc entry.
  async function saveRulesTextAsFile(text: string) {
    const id = crypto.randomUUID();
    const fileName = `${(hostelName.trim() || "hostel").replace(/[^\w\-]+/g, "-").toLowerCase()}-rules.txt`;
    setRulesDoc([{ id, name: fileName, url: "", uploading: true }]);
    try {
      const file = new File([text], fileName, { type: "text/plain" });
      const uploaded = await uploadRegistrationDocument(file, "Rules & policies");
      setRulesDoc([{ id, name: fileName, url: "", ...uploaded, uploading: false }]);
    } catch {
      setRulesDoc([]);
      setMessage("Could not save the rules file. Please try again.");
    }
  }

  function chooseRulesTemplate(template: RulesTemplate) {
    setRulesTemplateId(template.id);
    void saveRulesTextAsFile(template.body);
  }

  function openRulesEditor() {
    const template = RULES_TEMPLATES.find((t) => t.id === rulesTemplateId);
    setRulesDraft(template?.body ?? RULES_TEMPLATES[0].body);
    setRulesModalOpen(true);
  }

  async function saveRulesEditor() {
    setRulesModalOpen(false);
    if (!rulesTemplateId) setRulesTemplateId("custom");
    await saveRulesTextAsFile(rulesDraft);
  }

  /*
   * Each step says what it is *for* as well as what it is called. A number tells
   * somebody how much is left; a sentence tells them what they are about to be
   * asked, which is what lets them decide whether they have the paperwork in
   * front of them or should come back later.
   */
  const stepsList = [
    {
      description: "Your hostel, and how to reach you.",
      key: 1,
      label: "Basic information",
    },
    {
      description: "Where it is, and what it offers.",
      key: 2,
      label: "Location & facilities",
    },
    {
      description: "Room types, beds and what they cost.",
      key: 3,
      label: "Rooms & pricing",
    },
    {
      description: "Ownership, ID and anything else we need.",
      key: 4,
      label: "Documents",
    },
    { description: "One last look before it goes to us.", key: 5, label: "Review" },
  ];

  function stepComplete(key: number) {
    switch (key) {
      case 1:
        return Boolean(
          hostelName.trim() && description.trim() && ownerName.trim() && phone.trim(),
        );
      case 2:
        return Boolean(address.trim() && city.trim() && area.trim());
      case 3:
        return summary.totalBeds > 0;
      case 4:
        return (
          Boolean(idProofType) &&
          ownerIdDoc.some(isUploadedFile) &&
          rulesDoc.some(isUploadedFile)
        );
      case 5:
        return agreed;
      default:
        return false;
    }
  }

  function toggleFacility(f: string) {
    setFacilities((prev) =>
      prev.includes(f) ? prev.filter((i) => i !== f) : [...prev, f],
    );
  }

  /**
   * Anything the owner added that is not one of the presets.
   *
   * Derived rather than kept in a second piece of state: `facilities` is the one
   * list that gets submitted, and a parallel `customFacilities` array would be a
   * second copy of the same fact — free to disagree with it, and certain to
   * after a draft restore.
   */
  const customFacilities = facilities.filter(
    (facility) => !facilityOptions.includes(facility),
  );

  /**
   * Adds whatever is typed, if it is worth adding.
   *
   * Matching is case-insensitive against the presets *and* what has already been
   * added, so typing "wifi" when Wi-Fi is already ticked does not produce two
   * entries meaning the same thing on the public listing. A typed value that
   * matches a preset selects that preset instead of adding a near-duplicate.
   */
  function addCustomFacility() {
    const value = customFacility.trim().replace(/\s+/g, " ");

    if (!value) {
      return;
    }

    // 80 per entry and 40 entries are the schema's own limits — refusing here
    // means a clear message instead of a validation error at submit.
    if (value.length > 80) {
      setFacilityError("Keep a facility name under 80 characters.");

      return;
    }

    if (facilities.length >= 40) {
      setFacilityError("That is as many facilities as we can list.");

      return;
    }

    const preset = facilityOptions.find(
      (option) => option.toLowerCase() === value.toLowerCase(),
    );

    if (preset) {
      setCustomFacility("");
      setFacilityError("");

      if (!facilities.includes(preset)) {
        setFacilities((prev) => [...prev, preset]);
      }

      return;
    }

    if (facilities.some((facility) => facility.toLowerCase() === value.toLowerCase())) {
      setCustomFacility("");
      setFacilityError("");

      return;
    }

    setFacilities((prev) => [...prev, value]);
    setCustomFacility("");
    setFacilityError("");
  }

  function updateRoom(id: string, next: Partial<RoomConfig>) {
    setRooms((prev) => prev.map((r) => (r.id === id ? editRoomRow(r, next) : r)));
  }

  function goTo(next: number) {
    setStep(Math.min(5, Math.max(1, next)));
    if (typeof window !== "undefined") window.scrollTo({ behavior: "smooth", top: 0 });
  }

  function focusStep(targetStep: number, ref?: React.RefObject<HTMLElement | null>) {
    goTo(targetStep);
    window.setTimeout(() => {
      const el = ref?.current;
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      if (typeof el.focus === "function") el.focus();
    }, 80);
  }

  function getRequiredFieldChecks(): { label: string; step: number; valid: boolean }[] {
    return [
      { label: "Hostel Name", step: 1, valid: Boolean(hostelName.trim()) },
      { label: "Description", step: 1, valid: Boolean(description.trim()) },
      { label: "Owner Full Name", step: 1, valid: Boolean(ownerName.trim()) },
      {
        label: "Owner Phone — at least 7 digits",
        step: 1,
        valid: phone.trim().length >= 7,
      },
      // Without an email the approval never reaches the owner: the server
      // creates an owner User with no address, and resolveHostelOwner bails.
      {
        label: "Owner Email",
        step: 1,
        valid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()),
      },
      { label: "Address Line", step: 2, valid: Boolean(address.trim()) },
      { label: "Area / Locality", step: 2, valid: Boolean(area.trim()) },
      {
        label: "At least one room type with room count and beds per room",
        step: 3,
        valid: summary.totalRooms > 0 && summary.totalBeds > 0,
      },
      {
        label:
          "Government ID proof — select a type (Citizenship / NID / Passport) and upload it",
        step: 4,
        valid: Boolean(idProofType) && ownerIdDoc.some(isUploadedFile),
      },
      {
        label: "Hostel Rules & Policies document",
        step: 4,
        valid: rulesDoc.some(isUploadedFile),
      },
    ];
  }

  function findMissingRequiredFields() {
    return getRequiredFieldChecks().filter((c) => !c.valid);
  }

  function refForRequiredField(
    label: string,
  ): React.RefObject<HTMLElement | null> | undefined {
    switch (label) {
      case "Hostel Name":
        return hostelNameRef;
      case "Description":
        return descriptionRef;
      case "Owner Full Name":
        return ownerNameRef;
      case "Owner Phone — at least 7 digits":
        return phoneRef;
      case "Owner Email":
        return emailRef;
      case "Address Line":
        return addressRef;
      case "Area / Locality":
        return areaRef;
      case "At least one room type with room count and beds per room":
        return roomsSectionRef;
      case "Government ID proof — select a type (Citizenship / NID / Passport) and upload it":
        return idProofSectionRef;
      case "Hostel Rules & Policies document":
        return rulesSectionRef;
      default:
        return undefined;
    }
  }

  function saveDraft() {
    if (typeof window === "undefined") return;

    const draft: DraftData = {
      address,
      admissionFee,
      agreed,
      alternatePhone,
      area,
      bankDoc,
      city,
      cookCount,
      description,
      email,
      exteriorPhotos,
      facilities,
      foodAvailability,
      hasNonVeg,
      hasVeg,
      hostelName,
      hostelType,
      idProofType,
      landmark,
      licenseDoc,
      mapLink,
      mealsPerDay,
      ownerAge,
      ownerGender,
      ownerIdDoc,
      ownerName,
      ownershipDoc,
      panDoc,
      panNumber,
      phone,
      roomPhotos,
      rooms,
      rules,
      rulesDoc,
      rulesTemplateId,
      savedAt: new Date().toISOString(),
      shortStays,
      step,
      totalCapacity,
      totalFloors,
      yearEstablished,
    };

    window.localStorage.setItem(
      draftStorageKey(draftAccountKey ?? "anonymous"),
      JSON.stringify(draft),
    );
    setRestoredDraftAt(draft.savedAt);
    setDraftSaved(true);
    window.setTimeout(() => setDraftSaved(false), 2500);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAttemptedSubmit(true);

    const missing = findMissingRequiredFields();
    if (missing.length > 0) {
      focusStep(missing[0].step, refForRequiredField(missing[0].label));
      return;
    }

    if (uploadingFiles > 0) {
      setMessage("Please wait for all uploads to complete.");
      return;
    }

    if (
      hasResidentCard &&
      !(await confirm({
        actionLabel: "Yes, submit my hostel",
        description:
          "Your resident ID card will be automatically converted into a Hostel Owner card once your hostel registration is approved. You will no longer hold a resident card on this account.",
        title: "Register this hostel?",
      }))
    ) {
      return;
    }

    setIsSubmitting(true);
    setMessage("");

    const roomConfigurations = rooms
      .filter((r) => r.roomType.trim())
      .map((r) => ({
        bedsPerRoom: numberValue(r.bedsPerRoom) ?? 0,
        mealInclusion: r.mealInclusion,
        monthlyRent: numberValue(r.monthlyRent),
        rooms: numberValue(r.rooms) ?? 0,
        roomType: r.roomType.trim(),
        securityDeposit: numberValue(r.securityDeposit),
        vacantBeds: numberValue(r.vacantBeds) ?? 0,
      }));

    const photos = [
      ...exteriorPhotos
        .filter((p) => p.url)
        .map((p) => ({ alt: `${hostelName.trim()} - Exterior`, url: p.url })),
      ...roomPhotos
        .filter((p) => p.url)
        .map((p) => ({ alt: `${hostelName.trim()} - Room`, url: p.url })),
    ];

    const documents = [
      ...submittedDocuments("Ownership proof", ownershipDoc),
      ...submittedDocuments(idProofType || "Owner ID proof", ownerIdDoc),
      ...submittedDocuments("PAN / VAT document", panDoc),
      ...submittedDocuments("Hostel license", licenseDoc),
      ...submittedDocuments("Bank account details", bankDoc),
      ...submittedDocuments("Rules & policies", rulesDoc),
    ];

    const ownerNote = [
      ownerAge.trim() ? `Owner age: ${ownerAge.trim()}` : "",
      ownerGender ? `Owner gender: ${ownerGender}` : "",
      `Cooks: ${numberValue(cookCount) ?? 0}`,
      `Floors: ${numberValue(totalFloors) ?? 1}`,
    ]
      .filter(Boolean)
      .join(" · ");

    try {
      const result = await browserApi<{ hostel: { id: string; name?: string } }>(
        "/api/v1/public/hostels/register",
        {
          body: JSON.stringify({
            applicant: {
              email: email.trim() || undefined,
              name: ownerName.trim(),
              phone: phone.trim(),
            },
            alternatePhone: alternatePhone.trim() || undefined,
            capacitySummary,
            contact: { email: email.trim() || undefined, phone: phone.trim() },
            description: description.trim() || undefined,
            documents,
            facilities,
            food: {
              hasNonVeg,
              hasVeg,
              mealsPerDay: foodAvailability === "none" ? 0 : numberValue(mealsPerDay),
              notes:
                foodAvailability === "extra"
                  ? "Meals available at extra charge"
                  : undefined,
            },
            hostelType,
            landmark: landmark.trim() || undefined,
            location: {
              address: address.trim() || undefined,
              area: area.trim(),
              city: city.trim(),
              country,
            },
            mapLink: mapLink.trim() || undefined,
            name: hostelName.trim(),
            notes: ownerNote,
            payoutAccount: payoutAccountPayload(payout),
            photos,
            pricing: {
              admissionFee: numberValue(admissionFee),
              currency: "NPR",
              monthlyRentMax: rentValues.length > 0 ? Math.max(...rentValues) : undefined,
              monthlyRentMin: rentValues.length > 0 ? Math.min(...rentValues) : undefined,
            },
            roomConfigurations,
            roomTypes: roomConfigurations.map((r) => r.roomType),
            rules: rules
              .split(/\r?\n|,/)
              .map((l) => l.trim())
              .filter(Boolean),
                  totalCapacity: numberValue(totalCapacity),
            panNumber: panNumber.replace(/\s/g, "") || undefined,
            referralCode: referralCode || undefined,
            shortStays: shortStaysPayload(shortStays, rooms),
            totalFloors: numberValue(totalFloors),
            yearEstablished: yearEstablished.trim() || undefined,
          }),
          method: "POST",
        },
      );
      const marker: SubmittedMarker = {
        hostelId: result.hostel.id,
        hostelName: hostelName.trim() || result.hostel.name,
        submittedAt: new Date().toISOString(),
      };
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(draftStorageKey(draftAccountKey ?? "anonymous"));
        window.localStorage.setItem(
          submittedStorageKey(draftAccountKey ?? "anonymous"),
          JSON.stringify(marker),
        );
        window.scrollTo({ behavior: "smooth", top: 0 });
      }
      setExistingApplication(markerToApplication(marker));
      setStartNewRegistration(false);
      setSubmitted(true);
      void refreshApplicationStatus();
    } catch (error) {
      if (error instanceof ApiRequestError) {
        const details = error.details as
          | { fieldErrors?: Record<string, string[]> }
          | undefined;
        const firstEntry = details?.fieldErrors
          ? Object.entries(details.fieldErrors)[0]
          : undefined;

        if (firstEntry) {
          const [key, messages] = firstEntry;
          setMessage(
            `${humanizeFieldKey(key)}: ${messages[0] ?? "Please check this field and try again."} Fix it and resubmit.`,
          );
          goTo(FIELD_KEY_STEP[key] ?? 1);
        } else if (error.message === "Validation failed") {
          setMessage(
            "Some required information is missing or invalid. Please review each step and try again.",
          );
          goTo(1);
        } else {
          setMessage(error.message);
        }
      } else {
        setMessage(
          error instanceof Error ? error.message : "Could not submit hostel application.",
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  const hostelTypeLabel = {
    BOYS: "Boys Hostel",
    CO_LIVING: "Co-living",
    GIRLS: "Girls Hostel",
  }[hostelType];
  const missingFields = attemptedSubmit ? findMissingRequiredFields() : [];

  if (!statusChecked && !submitted) {
    return (
      <PublicShell active="register-hostel">
        <div className="flex min-h-[50vh] items-center justify-center">
          <Loader2 className="size-7 animate-spin text-muted-foreground" />
        </div>
      </PublicShell>
    );
  }

  if (existingApplication && !startNewRegistration && !submitted) {
    return (
      <PublicShell active="register-hostel">
        <HostelStatusView
          application={existingApplication}
          onRegisterAnother={() => setStartNewRegistration(true)}
          onResubmitted={refreshApplicationStatus}
        />
      </PublicShell>
    );
  }

  return (
    <PublicShell active="register-hostel">
      {confirmDialog}

      {/*
        Wider than the 1240px the rest of the site uses, because this page is the
        one that has to hold a seven-column table of room types beside two
        supporting columns. At 1240 the middle got 558px for an 820px table, so
        it scrolled sideways on a desktop with room to spare.
      */}
      <form className="mx-auto max-w-[1440px] px-4 py-8 md:px-6" onSubmit={submit}>
        {/* Header */}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground md:text-[26px]">
              Register New Hostel
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {submitted
                ? "Your application has been submitted for review."
                : `Step ${step} of 5 — add your hostel details to get listed on ${siteName}.`}
            </p>
            {referralCode && !submitted ? (
              <p className="mt-2 inline-flex items-center gap-2 rounded-full bg-brand-teal/10 px-3 py-1 text-xs font-semibold text-brand-teal">
                Referral code {referralCode}
                <button
                  aria-label="Remove referral code"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setReferralRemoved(true)}
                  type="button"
                >
                  ×
                </button>
              </p>
            ) : null}
          </div>
          {!submitted ? (
            <button
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2 text-sm font-semibold text-foreground shadow-sm transition hover:bg-muted"
              onClick={saveDraft}
              type="button"
            >
              {draftSaved ? (
                <CheckCircle2 className="size-4 text-success" />
              ) : (
                <Save className="size-4" />
              )}
              {draftSaved ? "Draft saved" : "Save Draft"}
            </button>
          ) : null}
        </div>

        {restoredDraftAt && !submitted ? (
          <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-brand-teal/25 bg-brand-teal/5 p-3 text-sm text-brand-teal">
            <span>
              Restored your saved draft from {new Date(restoredDraftAt).toLocaleString()}.
            </span>
            <button
              className="font-semibold underline underline-offset-2 hover:text-brand-teal/70"
              onClick={discardDraft}
              type="button"
            >
              Discard draft
            </button>
          </div>
        ) : null}

        {missingFields.length > 0 ? (
          <div className="mb-5 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <p className="font-semibold">
              Please complete the following before submitting:
            </p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
              {missingFields.map((field) => (
                <li key={field.label}>
                  {field.label}{" "}
                  <span className="text-destructive/70">(Step {field.step})</span>
                </li>
              ))}
            </ul>
          </div>
        ) : message ? (
          <div className="mb-5 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm font-medium text-destructive">
            {message}
          </div>
        ) : null}

        {submitted ? (
          <SubmittedView />
        ) : (
          /*
           * Three columns: the rail, the current step, and the contextual aside.
           * The rail replaces the horizontal stepper that used to sit above
           * everything — on a phone that stepper needed 640px of horizontal
           * scroll to show five steps, so the one piece of chrome telling
           * somebody where they were in the form was the one piece they could
           * not see.
           */
          <div className="grid items-start gap-8 lg:grid-cols-[200px_1fr] xl:grid-cols-[200px_1fr_300px]">
            <StepRail
              currentStep={step}
              onStepSelect={goTo}
              stepComplete={stepComplete}
              steps={stepsList}
            />

            {/*
              `min-w-0` is load-bearing, not tidying.

              A grid item defaults to `min-width: auto`, which means it will not
              shrink below the intrinsic width of its content. Step 3's room
              table is `min-w-[820px]` inside an `overflow-x-auto`, so without
              this the column grew to fit the table instead of letting it
              scroll — and the aside was pushed off the right edge of the page,
              with its figures cut in half.
            */}
            <StepFlow className="min-w-0 space-y-6" stepKey={step}>
              {/* STEP 1 — BASIC INFORMATION */}
              {step === 1 ? (
                <section className="app-card p-6">
                  <h2 className="text-lg font-bold text-foreground">Basic Information</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Tell students about your hostel and who runs it.
                  </p>

                  <div className="mt-6 grid gap-5 md:grid-cols-2">
                    <Field label="Hostel Name" required>
                      <input
                        className="input-field"
                        onChange={(e) => setHostelName(e.target.value)}
                        placeholder="e.g. Green View Hostel"
                        ref={hostelNameRef}
                        required
                        value={hostelName}
                      />
                    </Field>
                    <Field label="Hostel Type" required>
                      <select
                        className="input-field"
                        onChange={(e) =>
                          setHostelType(e.target.value as typeof hostelType)
                        }
                        value={hostelType}
                      >
                        <option value="BOYS">Boys Hostel</option>
                        <option value="GIRLS">Girls Hostel</option>
                        <option value="CO_LIVING">Co-living</option>
                      </select>
                    </Field>
                    <Field label="Year Established">
                      <input
                        className="input-field"
                        max={new Date().getFullYear()}
                        min={1950}
                        onChange={(e) => setYearEstablished(e.target.value)}
                        placeholder="e.g. 2020"
                        type="number"
                        value={yearEstablished}
                      />
                    </Field>
                    <Field label="PAN/VAT Number">
                      <input
                        className="input-field"
                        inputMode="numeric"
                        maxLength={11}
                        onChange={(e) => setPanNumber(e.target.value)}
                        placeholder="9 digits (optional)"
                        value={panNumber}
                      />
                    </Field>
                    <Field label="Total Resident Capacity">
                      <input
                        className="input-field"
                        min={0}
                        onChange={(e) => setTotalCapacity(e.target.value)}
                        placeholder="e.g. 100"
                        type="number"
                        value={totalCapacity}
                      />
                    </Field>
                  </div>

                  <div className="mt-5">
                    <Field label="Description" required>
                      <textarea
                        className="input-field min-h-24 py-2.5"
                        maxLength={2000}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="Highlight your location, atmosphere, nearby colleges, etc."
                        ref={descriptionRef}
                        required
                        value={description}
                      />
                    </Field>
                    <DescriptionSuggestions
                      facts={{ area, city, hostelName, hostelType, yearEstablished }}
                      onChange={setDescription}
                      value={description}
                    />
                  </div>

                  <div className="mt-6 border-t border-border pt-5">
                    <h3 className="text-sm font-bold text-foreground">Owner Details</h3>
                    <div className="mt-4 grid gap-5 md:grid-cols-2">
                      <Field label="Full Name" required>
                        <input
                          className="input-field"
                          onChange={(e) => setOwnerName(e.target.value)}
                          ref={ownerNameRef}
                          required
                          value={ownerName}
                        />
                      </Field>
                      <div className="grid grid-cols-2 gap-4">
                        <Field label="Age">
                          <input
                            className="input-field"
                            min={18}
                            max={100}
                            onChange={(e) => setOwnerAge(e.target.value)}
                            placeholder="e.g. 42"
                            type="number"
                            value={ownerAge}
                          />
                        </Field>
                        <Field label="Gender">
                          <select
                            className="input-field"
                            onChange={(e) =>
                              setOwnerGender(e.target.value as typeof ownerGender)
                            }
                            value={ownerGender}
                          >
                            <option value="">Select</option>
                            <option value="Male">Male</option>
                            <option value="Female">Female</option>
                            <option value="Other">Other</option>
                          </select>
                        </Field>
                      </div>
                      <Field label="Phone" required>
                        <input
                          className="input-field"
                          onChange={(e) => setPhone(e.target.value)}
                          ref={phoneRef}
                          required
                          type="tel"
                          value={phone}
                        />
                      </Field>
                      <Field label="Alternate Phone">
                        <input
                          className="input-field"
                          onChange={(e) => setAlternatePhone(e.target.value)}
                          type="tel"
                          value={alternatePhone}
                        />
                      </Field>
                      <Field label="Email" required>
                        <input
                          className={
                            lockedEmail
                              ? "input-field cursor-not-allowed bg-muted text-muted-foreground"
                              : "input-field"
                          }
                          onChange={(e) => setEmail(e.target.value)}
                          readOnly={Boolean(lockedEmail)}
                          ref={emailRef}
                          required
                          type="email"
                          value={email}
                        />
                        {lockedEmail ? (
                          <span className="flex items-start gap-1.5 text-[11px] font-medium text-muted-foreground">
                            <Lock className="mt-0.5 size-3 shrink-0" />
                            Taken from your signed-in account. Approval and login
                            credentials are sent here.
                          </span>
                        ) : null}
                      </Field>
                    </div>
                  </div>

                  <div className="mt-6 border-t border-border pt-5">
                    <h3 className="text-sm font-bold text-foreground">
                      Kitchen &amp; Staff
                    </h3>
                    <div className="mt-4 grid gap-5 md:grid-cols-2">
                      <Field label="Meals Per Day">
                        <input
                          className="input-field"
                          min={0}
                          max={6}
                          onChange={(e) => setMealsPerDay(e.target.value)}
                          type="number"
                          value={mealsPerDay}
                        />
                      </Field>
                      <Field label="Number of Cooks">
                        <input
                          className="input-field"
                          min={0}
                          max={50}
                          onChange={(e) => setCookCount(e.target.value)}
                          placeholder="e.g. 2"
                          type="number"
                          value={cookCount}
                        />
                      </Field>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-4">
                      <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                        <input
                          checked={hasVeg}
                          className="size-4 rounded text-brand-teal"
                          onChange={(e) => setHasVeg(e.target.checked)}
                          type="checkbox"
                        />{" "}
                        Veg
                      </label>
                      <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                        <input
                          checked={hasNonVeg}
                          className="size-4 rounded text-brand-teal"
                          onChange={(e) => setHasNonVeg(e.target.checked)}
                          type="checkbox"
                        />{" "}
                        Non-Veg
                      </label>
                    </div>
                    <p className="mt-3 flex items-start gap-2 rounded-lg bg-brand-teal/5 px-3 py-2.5 text-[11px] font-medium text-brand-teal">
                      <ChefHat className="mt-0.5 size-3.5 shrink-0" />
                      We generate one shared Cook App login for your kitchen after
                      approval, so whoever is cooking can announce meals. You can rotate
                      its password any time.
                    </p>
                  </div>
                </section>
              ) : null}

              {/* STEP 2 — LOCATION & FACILITIES */}
              {step === 2 ? (
                <section className="app-card p-6">
                  <h2 className="text-lg font-bold text-foreground">Location Details</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Add the address and location details of your hostel.
                  </p>

                  <div className="mt-6 space-y-5">
                    <Field label="Address Line" required>
                      <input
                        className="input-field"
                        onChange={(e) => setAddress(e.target.value)}
                        placeholder="Enter full address"
                        ref={addressRef}
                        required
                        value={address}
                      />
                    </Field>
                    <div className="grid gap-5 md:grid-cols-2">
                      <Field label="City" required>
                        <select
                          className="input-field"
                          onChange={(e) => setCity(e.target.value)}
                          value={city}
                        >
                          {cityOptions.map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Area / Locality" required>
                        <input
                          className="input-field"
                          onChange={(e) => setArea(e.target.value)}
                          placeholder="e.g. Bagdol, Baneshwor"
                          ref={areaRef}
                          required
                          value={area}
                        />
                      </Field>
                    </div>
                    <Field label="Landmark (Optional)">
                      <input
                        className="input-field"
                        onChange={(e) => setLandmark(e.target.value)}
                        placeholder="Enter nearby landmark"
                        value={landmark}
                      />
                    </Field>

                    <div className="grid gap-5 md:grid-cols-2">
                      <div>
                        <p className="mb-1.5 text-sm font-semibold text-foreground">
                          Location Preview
                        </p>
                        <div className="flex h-[140px] items-center justify-center rounded-lg border border-border bg-muted/40 bg-[linear-gradient(90deg,transparent_23px,var(--color-border)_24px),linear-gradient(transparent_23px,var(--color-border)_24px)] bg-[length:24px_24px]">
                          <MapPin className="size-8 text-brand-teal" />
                        </div>
                      </div>
                      <div>
                        <p className="mb-1.5 text-sm font-semibold text-foreground">
                          Google Maps Link (Optional)
                        </p>
                        <input
                          className="input-field w-full"
                          onChange={(e) => setMapLink(e.target.value)}
                          placeholder="https://maps.google.com/..."
                          value={mapLink}
                        />
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          Paste your Google Maps location link
                        </p>
                        {mapLink ? (
                          <a
                            className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-teal hover:underline"
                            href={mapLink}
                            rel="noreferrer"
                            target="_blank"
                          >
                            <MapPin className="size-3.5" /> Open in Google Maps
                          </a>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 border-t border-border pt-5">
                    <h3 className="text-sm font-bold text-foreground">Facilities</h3>
                    <p className="mb-3 text-xs text-muted-foreground">
                      Select the facilities available at your hostel.
                    </p>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                      {facilityOptions.map((facility) => {
                        const on = facilities.includes(facility);
                        return (
                          <button
                            key={facility}
                            className={cn(
                              "flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-xs font-semibold transition",
                              on
                                ? "border-brand-teal bg-brand-teal/5 text-foreground"
                                : "border-border bg-surface text-muted-foreground hover:border-brand-teal/40",
                            )}
                            onClick={() => toggleFacility(facility)}
                            type="button"
                          >
                            {facility}
                            {on ? (
                              <CheckCircle2 className="size-4 shrink-0 text-brand-teal" />
                            ) : (
                              <span className="size-4 shrink-0 rounded-full border border-border" />
                            )}
                          </button>
                        );
                      })}
                    </div>

                    {/*
                      The presets are the common cases, not the whole world. A
                      hostel with a rooftop, a temple room or a music room had no
                      way to say so, and the list of things students actually ask
                      about is longer than any grid we would ship.
                    */}
                    {customFacilities.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {customFacilities.map((facility) => (
                          <span
                            className="inline-flex items-center gap-1.5 rounded-lg border border-brand-teal bg-brand-teal/5 px-3 py-1.5 text-xs font-semibold text-foreground"
                            key={facility}
                          >
                            {facility}
                            <button
                              aria-label={`Remove ${facility}`}
                              className="rounded text-muted-foreground transition hover:text-destructive"
                              onClick={() => toggleFacility(facility)}
                              type="button"
                            >
                              <X className="size-3.5" />
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : null}

                    <div className="mt-3 flex flex-wrap items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <input
                          className="input-field w-full"
                          maxLength={80}
                          onChange={(event) => {
                            setCustomFacility(event.target.value);
                            setFacilityError("");
                          }}
                          /*
                           * Enter adds the facility rather than submitting the
                           * form. Without this the one key somebody naturally
                           * presses after typing would post a half-filled
                           * registration.
                           */
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              addCustomFacility();
                            }
                          }}
                          placeholder="Something else? e.g. Rooftop, Music room"
                          value={customFacility}
                        />
                        {facilityError ? (
                          <p className="mt-1 text-xs font-medium text-destructive">
                            {facilityError}
                          </p>
                        ) : null}
                      </div>
                      <button
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-4 py-2.5 text-xs font-semibold text-foreground transition hover:border-brand-teal hover:bg-brand-teal/5 disabled:opacity-40"
                        disabled={!customFacility.trim()}
                        onClick={addCustomFacility}
                        type="button"
                      >
                        <Plus className="size-3.5" /> Add
                      </button>
                    </div>
                  </div>

                  <div className="mt-6 grid gap-6 border-t border-border pt-5 md:grid-cols-2">
                    <div>
                      <h3 className="text-sm font-bold text-foreground">
                        Food Availability
                      </h3>
                      <p className="mb-3 text-xs text-muted-foreground">
                        Select food availability option.
                      </p>
                      <div className="space-y-2.5">
                        {(
                          [
                            ["included", "Meals included"],
                            ["extra", "Meals available (at extra charge)"],
                            ["none", "No meals"],
                          ] as const
                        ).map(([value, label]) => (
                          <label
                            className="flex cursor-pointer items-center gap-2.5 text-sm font-medium text-foreground"
                            key={value}
                          >
                            <input
                              checked={foodAvailability === value}
                              className="size-4 text-brand-teal"
                              name="food-availability"
                              onChange={() => setFoodAvailability(value)}
                              type="radio"
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-foreground">
                        Hostel Rules Summary
                      </h3>
                      <p className="mb-3 text-xs text-muted-foreground">
                        Add a short summary of your hostel rules.
                      </p>
                      <textarea
                        className="input-field min-h-24 w-full py-2.5"
                        maxLength={250}
                        onChange={(e) => setRules(e.target.value)}
                        placeholder="E.g. No smoking, No alcohol, Visitors not allowed, Silence after 10 PM…"
                        value={rules}
                      />
                      <p className="mt-1 text-right text-[11px] text-muted-foreground">
                        {rules.length} / 250
                      </p>
                    </div>
                  </div>
                </section>
              ) : null}

              {/* STEP 3 — ROOMS & PRICING */}
              {step === 3 ? (
                <section className="app-card p-6" ref={roomsSectionRef}>
                  <h2 className="text-lg font-bold text-foreground">
                    Rooms &amp; Pricing
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Add all room types, capacity, and pricing details. You can edit these
                    anytime later.
                  </p>

                  <div className="mt-5 max-w-xs">
                    <Field label="How many floors does the building have?">
                      <input
                        className="input-field"
                        min={1}
                        max={50}
                        onChange={(e) => setTotalFloors(e.target.value)}
                        type="number"
                        value={totalFloors}
                      />
                    </Field>
                  </div>

                  <div className="mt-6 rounded-xl border border-border">
                    <div className="flex items-center justify-between border-b border-border px-4 py-3">
                      <div>
                        <h3 className="text-sm font-bold text-foreground">Room Types</h3>
                        <p className="text-xs text-muted-foreground">
                          Add each room type available across your hostel.
                        </p>
                      </div>
                      <button
                        className="inline-flex items-center gap-1.5 rounded-lg border border-brand-teal px-3 py-1.5 text-xs font-bold text-brand-teal transition hover:bg-brand-teal/5"
                        onClick={() =>
                          setRooms((prev) => [...prev, createRoom("Single Room")])
                        }
                        type="button"
                      >
                        <Plus className="size-3.5" /> Add Room Type
                      </button>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[820px] text-sm">
                        <thead>
                          <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            <th className="px-4 py-2.5">Room Type</th>
                            <th className="px-2 py-2.5">No. of Rooms</th>
                            <th className="px-2 py-2.5">Beds / Room</th>
                            <th className="px-2 py-2.5">Vacancy</th>
                            <th className="px-2 py-2.5">Monthly Rent</th>
                            <th className="px-2 py-2.5">Security Deposit</th>
                            <th className="px-2 py-2.5">Meal Inclusion</th>
                            <th className="px-2 py-2.5" />
                          </tr>
                        </thead>
                        <tbody>
                          {rooms.map((room) => {
                            const meta =
                              ROOM_TYPE_META[room.roomType] ??
                              ROOM_TYPE_META["Single Room"];
                            const Icon = meta.icon;
                            return (
                              <tr
                                className="border-b border-border last:border-0"
                                key={room.id}
                              >
                                <td className="px-4 py-3">
                                  <div className="flex items-center gap-2.5">
                                    <span
                                      className={cn(
                                        "flex size-9 shrink-0 items-center justify-center rounded-lg",
                                        meta.tone,
                                      )}
                                    >
                                      <Icon className="size-4.5" />
                                    </span>
                                    <select
                                      className="input-field h-9 w-full min-w-[120px] px-2 text-xs"
                                      onChange={(e) =>
                                        updateRoom(room.id, { roomType: e.target.value })
                                      }
                                      value={room.roomType}
                                    >
                                      {roomTypeOptions.map((t) => (
                                        <option key={t}>{t}</option>
                                      ))}
                                    </select>
                                  </div>
                                </td>
                                <td className="px-2 py-3">
                                  <input
                                    className="input-field h-9 w-16 px-2 text-xs"
                                    min={0}
                                    onChange={(e) =>
                                      updateRoom(room.id, { rooms: e.target.value })
                                    }
                                    placeholder="0"
                                    type="number"
                                    value={room.rooms}
                                  />
                                </td>
                                <td className="px-2 py-3">
                                  <input
                                    className="input-field h-9 w-16 px-2 text-xs"
                                    min={0}
                                    onChange={(e) =>
                                      updateRoom(room.id, { bedsPerRoom: e.target.value })
                                    }
                                    placeholder="0"
                                    type="number"
                                    value={room.bedsPerRoom}
                                  />
                                </td>
                                <td className="px-2 py-3">
                                  <input
                                    className="input-field h-9 w-16 px-2 text-xs font-bold text-brand-teal"
                                    min={0}
                                    onChange={(e) =>
                                      updateRoom(room.id, { vacantBeds: e.target.value })
                                    }
                                    placeholder="0"
                                    type="number"
                                    value={room.vacantBeds}
                                  />
                                </td>
                                <td className="px-2 py-3">
                                  <input
                                    className="input-field h-9 w-24 px-2 text-xs"
                                    min={0}
                                    onChange={(e) =>
                                      updateRoom(room.id, { monthlyRent: e.target.value })
                                    }
                                    placeholder="NPR"
                                    type="number"
                                    value={room.monthlyRent}
                                  />
                                </td>
                                <td className="px-2 py-3">
                                  <input
                                    className="input-field h-9 w-24 px-2 text-xs"
                                    min={0}
                                    onChange={(e) =>
                                      updateRoom(room.id, {
                                        securityDeposit: e.target.value,
                                      })
                                    }
                                    placeholder="NPR"
                                    type="number"
                                    value={room.securityDeposit}
                                  />
                                </td>
                                <td className="px-2 py-3">
                                  <select
                                    className="input-field h-9 w-28 px-2 text-xs"
                                    onChange={(e) =>
                                      updateRoom(room.id, {
                                        mealInclusion: e.target.value as MealInclusion,
                                      })
                                    }
                                    value={room.mealInclusion}
                                  >
                                    <option value="Included">Included</option>
                                    <option value="Optional">Optional</option>
                                    <option value="Not Included">Not Included</option>
                                  </select>
                                </td>
                                <td className="px-2 py-3">
                                  <button
                                    className="rounded-md p-1.5 text-muted-foreground transition hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
                                    disabled={rooms.length === 1}
                                    onClick={() =>
                                      setRooms((prev) =>
                                        prev.filter((r) => r.id !== room.id),
                                      )
                                    }
                                    type="button"
                                  >
                                    <Trash2 className="size-4" />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div className="flex items-start gap-2 border-t border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
                      <Info className="mt-0.5 size-3.5 shrink-0 text-role-platform" />
                      Prices are monthly per bed. You can update pricing anytime from your
                      hostel dashboard.
                    </div>
                  </div>

                  <div className="mt-5 max-w-xs">
                    <Field label="Admission Fee (NPR)">
                      <input
                        className="input-field"
                        min={0}
                        onChange={(e) => setAdmissionFee(e.target.value)}
                        type="number"
                        value={admissionFee}
                      />
                    </Field>
                  </div>

                  <div className="mt-5">
                    <RegistrationShortStays onChange={setShortStays} rooms={rooms} value={shortStays} />
                  </div>
                </section>
              ) : null}

              {/* STEP 4 — DOCUMENTS & VERIFICATION */}
              {step === 4 ? (
                <section className="app-card p-6">
                  <h2 className="text-lg font-bold text-foreground">
                    Documents &amp; Verification
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Upload the required documents to verify your identity and hostel. All
                    documents are secure and confidential.
                  </p>

                  <div className="mt-6 space-y-4">
                    {/* Government ID proof — REQUIRED, with type selection */}
                    <div
                      ref={idProofSectionRef}
                      className="grid gap-4 rounded-xl border-2 border-brand-teal/40 bg-brand-teal/[0.03] p-4 md:grid-cols-[1fr_1.2fr] md:items-start"
                    >
                      <div className="flex items-start gap-3">
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-teal/10 text-brand-teal">
                          <IdCard className="size-5" />
                        </span>
                        <div>
                          <p className="text-sm font-bold text-foreground">
                            Government ID Proof <span className="text-danger">*</span>
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Owner&apos;s valid government-issued identity document. This
                            is mandatory.
                          </p>
                        </div>
                      </div>
                      <div className="space-y-2.5">
                        <div>
                          <label className="mb-1 block text-xs font-semibold text-foreground">
                            ID document type <span className="text-danger">*</span>
                          </label>
                          <select
                            className="input-field"
                            onChange={(e) =>
                              setIdProofType(e.target.value as IdProofType)
                            }
                            value={idProofType}
                          >
                            <option value="">Select ID type…</option>
                            {ID_PROOF_TYPES.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </div>
                        <FileUploadArea
                          files={ownerIdDoc}
                          label={
                            idProofType
                              ? `Upload ${idProofType}`
                              : "Select an ID type first, then upload"
                          }
                          {...docSlot(setOwnerIdDoc, idProofType || "Owner ID proof")}
                        />
                      </div>
                    </div>

                    <p className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <span className="h-px flex-1 bg-border" /> Optional supporting
                      documents <span className="h-px flex-1 bg-border" />
                    </p>

                    <DocRow
                      desc="Property deed / ownership certificate (optional)"
                      icon={FileText}
                      title="Ownership Proof"
                    >
                      <FileUploadArea
                        files={ownershipDoc}
                        label="Upload ownership document"
                        {...docSlot(setOwnershipDoc, "Ownership proof")}
                      />
                    </DocRow>
                    <DocRow
                      desc="PAN card or VAT registration certificate (optional)"
                      icon={CreditCard}
                      title="PAN / VAT Document"
                    >
                      <FileUploadArea
                        files={panDoc}
                        label="Upload PAN / VAT"
                        {...docSlot(setPanDoc, "PAN / VAT document")}
                      />
                    </DocRow>
                    <DocRow
                      desc="Local authority license or registration (optional)"
                      icon={ScrollText}
                      title="Hostel License / Registration"
                    >
                      <FileUploadArea
                        files={licenseDoc}
                        label="Upload license or registration"
                        {...docSlot(setLicenseDoc, "Hostel license")}
                      />
                    </DocRow>
                    <DocRow
                      desc="Bank statement or cancelled cheque (optional)"
                      icon={Landmark}
                      title="Bank Account Details"
                    >
                      <FileUploadArea
                        files={bankDoc}
                        label="Upload bank statement or cheque"
                        {...docSlot(setBankDoc, "Bank document")}
                      />
                    </DocRow>

                    <DocRow
                      desc="Clear photos of the hostel building exterior (optional)"
                      icon={ImageIcon}
                      title="Hostel Exterior Photos"
                    >
                      <FileUploadArea
                        accept={acceptAttribute("image")}
                        files={exteriorPhotos}
                        label="Upload 2–5 exterior photos"
                        maxFiles={5}
                        {...docSlot(setExteriorPhotos, "Exterior photo", "public")}
                      />
                    </DocRow>
                    <DocRow
                      desc="Photos of rooms and common areas (optional)"
                      icon={ImageIcon}
                      title="Room Photos"
                    >
                      <FileUploadArea
                        accept={acceptAttribute("image")}
                        files={roomPhotos}
                        label="Upload 5–10 room photos"
                        maxFiles={10}
                        {...docSlot(setRoomPhotos, "Room photo", "public")}
                      />
                    </DocRow>
                    <p className="flex items-start gap-2 rounded-lg bg-muted/40 px-3 py-2.5 text-[11px] font-medium text-muted-foreground">
                      <Info className="mt-0.5 size-3.5 shrink-0 text-brand-teal" />
                      Photos are optional here — you can add and manage hostel images
                      anytime later from your Hostel Admin portal after approval.
                    </p>

                    {/* Hostel Rules & Policies — REQUIRED, template chooser + editable modal */}
                    <div
                      ref={rulesSectionRef}
                      className="rounded-xl border-2 border-brand-teal/40 bg-brand-teal/[0.03] p-4"
                    >
                      <div className="flex items-start gap-3">
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-teal/10 text-brand-teal">
                          <ScrollText className="size-5" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-foreground">
                            Hostel Rules &amp; Policies{" "}
                            <span className="text-danger">*</span>
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Pick a ready-made policy below (edit if you like), or upload
                            your own. This is mandatory.
                          </p>
                        </div>
                      </div>

                      <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
                        {RULES_TEMPLATES.map((template) => {
                          const active = rulesTemplateId === template.id;
                          return (
                            <button
                              key={template.id}
                              className={cn(
                                "flex flex-col gap-1 rounded-lg border p-3 text-left transition",
                                active
                                  ? "border-brand-teal bg-brand-teal/5 ring-1 ring-brand-teal/30"
                                  : "border-border bg-surface hover:border-brand-teal/40",
                              )}
                              onClick={() => chooseRulesTemplate(template)}
                              type="button"
                            >
                              <span className="flex items-center justify-between gap-2">
                                <span className="text-xs font-bold text-foreground">
                                  {template.name}
                                </span>
                                {active ? (
                                  <CheckCircle2 className="size-4 shrink-0 text-brand-teal" />
                                ) : null}
                              </span>
                              <span className="text-[11px] leading-snug text-muted-foreground">
                                {template.summary}
                              </span>
                            </button>
                          );
                        })}
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          className="inline-flex items-center gap-1.5 rounded-lg border border-brand-teal px-3 py-1.5 text-xs font-bold text-brand-teal transition hover:bg-brand-teal/5 disabled:opacity-40"
                          disabled={!rulesTemplateId}
                          onClick={openRulesEditor}
                          type="button"
                        >
                          <Pencil className="size-3.5" /> Edit selected policy
                        </button>
                        <span className="text-[11px] text-muted-foreground">or</span>
                        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted">
                          <Upload className="size-3.5" /> Upload your own (PDF/TXT)
                          <input
                            accept="application/pdf,text/plain"
                            className="sr-only"
                            onChange={(e) => {
                              setRulesTemplateId("custom");
                              void handleFileSelect(setRulesDoc, "Rules & policies")(e);
                            }}
                            type="file"
                          />
                        </label>
                      </div>

                      {rulesDoc.length > 0 ? (
                        <div className="mt-3">
                          <FileUploadArea
                            accept="application/pdf,text/plain"
                            files={rulesDoc}
                            label="Replace rules & policies file"
                            maxFiles={0}
                            onFileSelect={handleFileSelect(
                              setRulesDoc,
                              "Rules & policies",
                            )}
                            onFilesDropped={uploadIntoSlot(
                              setRulesDoc,
                              "Rules & policies",
                            )}
                            onRemove={(id) => {
                              setRulesDoc((p) => p.filter((x) => x.id !== id));
                              setRulesTemplateId(null);
                            }}
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                </section>
              ) : null}

              {/* STEP 5 — REVIEW & SUBMIT */}
              {step === 5 ? (
                <section className="app-card p-6">
                  <h2 className="text-lg font-bold text-foreground">
                    Review &amp; Submit
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Please review all the information below before submitting your hostel
                    for approval.
                  </p>

                  <div className="mt-6 rounded-lg border border-border p-4">
                    <h3 className="text-sm font-bold text-foreground">
                      Booking payouts <span className="font-normal text-muted-foreground">(optional)</span>
                    </h3>
                    <p className="mb-3 mt-1 text-xs text-muted-foreground">
                      Where we send your share when someone books a bed here. People can book your
                      hostel only once we have checked this account. You can add it later from
                      Payment Setup.
                    </p>
                    <PayoutAccountFields onChange={setPayout} value={payout} />
                  </div>

                  <div className="mt-6 space-y-4">
                    <ReviewCard
                      icon={Building2}
                      onEdit={() => goTo(1)}
                      title="Basic Information"
                    >
                      <p className="text-sm font-semibold text-foreground">
                        {hostelName || "—"}{" "}
                        <span className="text-muted-foreground">· {hostelTypeLabel}</span>
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {[ownerName, phone, email].filter(Boolean).join(" · ") ||
                          "Owner details pending"}
                      </p>
                    </ReviewCard>

                    <ReviewCard
                      icon={MapPin}
                      onEdit={() => goTo(2)}
                      title="Location & Facilities"
                    >
                      <p className="text-sm font-semibold text-foreground">
                        {[area, city, country].filter(Boolean).join(", ") || "—"}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {facilities.slice(0, 5).map((f) => (
                          <span
                            className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground"
                            key={f}
                          >
                            <CheckCircle2 className="size-3 text-brand-teal" /> {f}
                          </span>
                        ))}
                        {facilities.length > 5 ? (
                          <span className="text-[11px] font-medium text-muted-foreground">
                            +{facilities.length - 5} more
                          </span>
                        ) : null}
                      </div>
                    </ReviewCard>

                    <ReviewCard icon={Bed} onEdit={() => goTo(3)} title="Rooms & Pricing">
                      <p className="text-sm font-semibold text-foreground">
                        {rooms.length} room type{rooms.length === 1 ? "" : "s"} ·{" "}
                        {summary.totalBeds} beds · {totalFloors} floor
                        {Number(totalFloors) === 1 ? "" : "s"}
                      </p>
                      {rentValues.length > 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Starting from NPR {Math.min(...rentValues).toLocaleString()} /
                          month
                        </p>
                      ) : null}
                    </ReviewCard>

                    <ReviewCard icon={FileText} onEdit={() => goTo(4)} title="Documents">
                      <p className="text-sm font-semibold text-foreground">
                        {uploadedCount} document{uploadedCount === 1 ? "" : "s"} uploaded
                      </p>
                    </ReviewCard>
                  </div>

                  <label className="mt-6 flex items-start gap-3 rounded-xl border border-border bg-muted/20 p-4">
                    <input
                      checked={agreed}
                      className="mt-0.5 size-4 rounded text-brand-teal"
                      onChange={(e) => setAgreed(e.target.checked)}
                      type="checkbox"
                    />
                    <span className="text-sm text-foreground">
                      I confirm that all the information provided is accurate and
                      complete. I agree to <SiteName />&apos;s{" "}
                      <Link
                        className="font-semibold text-brand-teal hover:underline"
                        href="/terms"
                      >
                        Terms of Service
                      </Link>{" "}
                      and{" "}
                      <Link
                        className="font-semibold text-brand-teal hover:underline"
                        href="/privacy"
                      >
                        Privacy Policy
                      </Link>
                      .
                    </span>
                  </label>

                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                    <button
                      className="rounded-lg border border-border px-5 py-2.5 text-sm font-semibold text-foreground transition hover:bg-muted"
                      onClick={() => goTo(4)}
                      type="button"
                    >
                      Back to Edit
                    </button>
                    <button
                      className="inline-flex items-center gap-2 rounded-lg bg-brand-teal px-6 py-3 text-sm font-bold text-white shadow-lg shadow-brand-teal/20 transition hover:brightness-110 disabled:opacity-50"
                      disabled={isSubmitting || uploadingFiles > 0 || !agreed}
                      type="submit"
                    >
                      <Send className="size-4" />
                      {isSubmitting
                        ? "Submitting…"
                        : uploadingFiles > 0
                          ? "Waiting for uploads…"
                          : "Submit for Approval"}
                    </button>
                  </div>
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Info className="size-3.5" /> Your application will go for review
                    before publishing.
                  </p>
                </section>
              ) : null}
            </StepFlow>

            {/*
              RIGHT ASIDE — changes per step.

              Full width on `lg`, its own column from `xl`. The grid only has a
              third column at `xl`, so between the two breakpoints this was a
              third child flowing onto a second row underneath the rail — a
              340px card orphaned under the step list. Spanning both columns
              there keeps the content without the orphan.
            */}
            <aside className="min-w-0 space-y-4 lg:col-span-2 xl:sticky xl:top-24 xl:col-span-1">
              {step === 1 ? <PortalsCard /> : null}

              {step === 2 ? (
                <>
                  <div className="app-card overflow-hidden">
                    <div className="px-5 pt-5">
                      <h3 className="text-sm font-bold text-foreground">
                        Live Listing Preview
                      </h3>
                      <p className="text-[11px] text-muted-foreground">
                        This is how your hostel will appear to students.
                      </p>
                    </div>
                    <div className="p-5">
                      <div className="rounded-xl border border-border">
                        <div className="relative flex h-36 items-center justify-center rounded-t-xl bg-muted">
                          <Building2 className="size-10 text-muted-foreground/50" />
                          <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                            <Clock className="size-3" /> Verification Pending
                          </span>
                        </div>
                        <div className="p-4">
                          <div className="flex items-center justify-between">
                            <h4 className="text-sm font-bold text-foreground">
                              {hostelName || "Your Hostel Name"}
                            </h4>
                            <span className="inline-flex items-center gap-0.5 text-xs font-bold text-foreground">
                              <Star className="size-3.5 fill-warning text-warning" /> New
                            </span>
                          </div>
                          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                            <MapPin className="size-3" />{" "}
                            {[area, city].filter(Boolean).join(", ") ||
                              "Location pending"}
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {facilities.slice(0, 6).map((f) => (
                              <span
                                className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[10px] font-medium text-foreground"
                                key={f}
                              >
                                {FACILITY_MINI[f] ?? <Wifi className="size-3" />} {f}
                              </span>
                            ))}
                            {facilities.length > 6 ? (
                              <span className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground">
                                +{facilities.length - 6} more
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                      <div className="mt-4 flex items-start gap-2 rounded-lg bg-brand-teal/5 p-3">
                        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand-teal" />
                        <div>
                          <p className="text-xs font-bold text-brand-teal">
                            Verification Pending
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            Our team will verify your hostel details before it goes live.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                  <WhatHappensNext />
                </>
              ) : null}

              {step === 3 ? (
                <div className="app-card p-5">
                  {/*
                    Two figures and a meter, in one shape.

                    This was three different layouts stacked — an icon beside a
                    three-line block, the same again, then a bar — across four
                    type sizes, which is what made a panel of three numbers read
                    as clutter. The icons went with them: a card headed "Pricing
                    Summary" does not need a picture of a card to say that the
                    money figure is money.
                  */}
                  <h3 className="text-sm font-bold text-foreground">Pricing summary</h3>

                  <dl className="mt-4 space-y-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="min-w-0 text-xs text-muted-foreground">
                        Monthly revenue
                      </dt>
                      <dd className="shrink-0 text-base font-bold tabular-nums text-foreground">
                        NPR {summary.revenue.toLocaleString()}
                      </dd>
                    </div>

                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="min-w-0 text-xs text-muted-foreground">
                        Capacity
                      </dt>
                      <dd className="shrink-0 text-base font-bold tabular-nums text-foreground">
                        {summary.totalBeds}{" "}
                        <span className="text-xs font-medium text-muted-foreground">
                          beds in {summary.totalRooms} rooms
                        </span>
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-4 border-t border-border pt-4">
                    <div className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="text-muted-foreground">Occupancy</span>
                      <span className="font-semibold tabular-nums text-foreground">
                        {occupiedBeds} / {summary.totalBeds}
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-brand-teal transition-all"
                        style={{ width: `${occupancyPct}%` }}
                      />
                    </div>
                  </div>

                  {/*
                    Muted, not brand-coloured. It is a footnote explaining where
                    a number came from — painting it in the accent on an accent
                    wash made the quietest sentence on the card the loudest
                    thing in the column.
                  */}
                  <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
                    Revenue assumes current occupancy at the monthly rent per bed.
                  </p>
                </div>
              ) : null}

              {step === 4 ? (
                <div className="app-card p-5">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="size-5 text-brand-teal" />
                    <h3 className="text-sm font-bold text-foreground">
                      Verification Guidelines
                    </h3>
                  </div>
                  <div className="mt-4 space-y-4">
                    {[
                      {
                        desc: `Verification helps us ensure trust, safety, and quality across ${siteName}.`,
                        icon: BadgeCheck,
                        title: "Why We Verify",
                      },
                      {
                        desc: "Our team reviews your documents, photos, and information for authenticity.",
                        icon: Search,
                        title: "What We Check",
                      },
                      {
                        desc: "We check for duplicate or similar listings to keep the platform clean.",
                        icon: Copy,
                        title: "Duplicate Listing Check",
                      },
                      {
                        desc: "All submissions are reviewed manually by our verification team.",
                        icon: FileText,
                        title: "Manual Review",
                      },
                      {
                        desc: "You will typically receive an update within 1–2 business days.",
                        icon: Clock,
                        title: "Approval Timeline",
                      },
                    ].map((item) => (
                      <div className="flex items-start gap-3" key={item.title}>
                        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-brand-teal">
                          <item.icon className="size-3.5" />
                        </span>
                        <div>
                          <p className="text-xs font-bold text-foreground">
                            {item.title}
                          </p>
                          <p className="text-[11px] leading-snug text-muted-foreground">
                            {item.desc}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 flex items-start gap-2 rounded-lg bg-brand-teal/5 p-3">
                    <Lock className="mt-0.5 size-4 shrink-0 text-brand-teal" />
                    <div>
                      <p className="text-xs font-bold text-brand-teal">
                        Your Information is Secure
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        All uploaded documents are encrypted and used only for
                        verification.
                      </p>
                    </div>
                  </div>
                </div>
              ) : null}

              {step === 5 ? (
                <>
                  {/*
                    * The plan picker and its billing estimate used to sit here.
                    *
                    * Both are gone, and neither is coming back to this step. The
                    * picker offered three plans hardcoded in this file, at prices
                    * that had already drifted from what /plans-pricing quoted; the
                    * estimate added a "Platform Fee (10%)" that exists nowhere in
                    * the pricing model at all. An owner was being shown a total
                    * they would never be charged.
                    *
                    * Choosing now also asked for a decision at the wrong moment —
                    * before anyone had confirmed the hostel would be accepted. The
                    * choice moves to the progress page, against the live
                    * catalogue, where it can be made during the wait and changed
                    * right up until the invoice is raised.
                    */}
                  <div className="app-card p-5">
                    <h3 className="text-sm font-bold text-foreground">
                      What happens next
                    </h3>
                    <ol className="mt-3 space-y-3 text-xs">
                      {[
                        "You submit — we email you to confirm we have everything.",
                        "We check your details and documents, usually within 1–2 business days.",
                        "Pick your plan any time from this page while you wait.",
                        "Once verified, pay for the plan and your listing goes live immediately.",
                      ].map((line, index) => (
                        <li className="flex gap-2.5" key={line}>
                          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-teal/10 text-[10px] font-bold text-brand-teal">
                            {index + 1}
                          </span>
                          <span className="leading-relaxed text-muted-foreground">
                            {line}
                          </span>
                        </li>
                      ))}
                    </ol>
                    <p className="mt-4 flex items-start gap-1.5 text-[11px] text-muted-foreground">
                      <Info className="mt-0.5 size-3 shrink-0" /> Nothing is charged
                      until your hostel is verified.
                    </p>
                  </div>

                  <div className="app-card p-5">
                    <h3 className="text-sm font-bold text-foreground">
                      Submission Checklist
                    </h3>
                    <div className="mt-3 space-y-2 text-xs">
                      {[
                        [
                          "Basic information completed",
                          Boolean(hostelName && ownerName && phone),
                        ],
                        [
                          "Location and facilities added",
                          Boolean(area && city && facilities.length),
                        ],
                        ["Rooms and pricing configured", summary.totalBeds > 0],
                        ["Documents uploaded", uploadedCount > 0],
                        ["Terms and policies accepted", agreed],
                      ].map(([label, ok]) => (
                        <p className="flex items-center gap-2" key={label as string}>
                          <CheckCircle2
                            className={cn(
                              "size-3.5",
                              ok ? "text-brand-teal" : "text-muted-foreground/40",
                            )}
                          />
                          <span
                            className={ok ? "text-foreground" : "text-muted-foreground"}
                          >
                            {label}
                          </span>
                        </p>
                      ))}
                    </div>
                  </div>

                  <PortalsCard />
                </>
              ) : null}
            </aside>
          </div>
        )}

        {/* Bottom navigation (steps 1–4) */}
        {!submitted && step < 5 ? (
          <div className="mt-8 flex items-center justify-between gap-3">
            <button
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2.5 sm:px-5 text-sm font-semibold text-foreground transition hover:bg-muted disabled:opacity-40"
              disabled={step === 1}
              onClick={() => goTo(step - 1)}
              type="button"
            >
              <ArrowLeft className="size-4" /> Back
            </button>
            <div className="flex items-center gap-2 sm:gap-3">
              <button
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 sm:px-5 text-sm font-semibold text-foreground transition hover:bg-muted"
                onClick={saveDraft}
                type="button"
              >
                <Save className="size-4" /> Save Draft
              </button>
              <button
                className="inline-flex items-center gap-2 rounded-lg bg-brand-teal px-4 py-2.5 sm:px-6 text-sm font-bold text-white shadow-sm transition hover:brightness-105"
                onClick={() => goTo(step + 1)}
                type="button"
              >
                Continue <ArrowRight className="size-4" />
              </button>
            </div>
          </div>
        ) : null}
      </form>

      {rulesModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setRulesModalOpen(false)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-surface shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div className="flex items-center gap-2">
                <Pencil className="size-4 text-brand-teal" />
                <h3 className="text-sm font-bold text-foreground">
                  Edit Rules &amp; Policies
                </h3>
              </div>
              <button
                className="rounded-md p-1 text-muted-foreground transition hover:bg-muted"
                onClick={() => setRulesModalOpen(false)}
                type="button"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              <p className="mb-2 text-xs text-muted-foreground">
                Edit the policy text below. When you save, we generate a rules file for
                your hostel.
              </p>
              <textarea
                autoFocus
                className="input-field min-h-[340px] w-full py-2.5 font-mono text-xs leading-relaxed"
                onChange={(e) => setRulesDraft(e.target.value)}
                value={rulesDraft}
              />
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
              <button
                className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted"
                onClick={() => setRulesModalOpen(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="inline-flex items-center gap-2 rounded-lg bg-brand-teal px-5 py-2 text-sm font-bold text-white transition hover:brightness-110"
                onClick={saveRulesEditor}
                type="button"
              >
                <Save className="size-4" /> Save policy
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </PublicShell>
  );
}

const FACILITY_MINI: Record<string, React.ReactNode> = {
  CCTV: <ShieldCheck className="size-3" />,
  "Hot Water": <Utensils className="size-3" />,
  Meals: <Utensils className="size-3" />,
  Parking: <MapPin className="size-3" />,
  "Wi-Fi": <Wifi className="size-3" />,
};

function Field({
  children,
  label,
  required,
}: {
  children: React.ReactNode;
  label: string;
  required?: boolean;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-sm font-semibold text-foreground">
        {label} {required ? <span className="text-danger">*</span> : null}
      </span>
      {children}
    </label>
  );
}

function ReviewCard({
  children,
  icon: Icon,
  onEdit,
  title,
}: {
  children: React.ReactNode;
  icon: LucideIcon;
  onEdit: () => void;
  title: string;
}) {
  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-brand-teal">
            <Icon className="size-5" />
          </span>
          <div>
            <p className="text-sm font-bold text-foreground">{title}</p>
            <div className="mt-1">{children}</div>
          </div>
        </div>
        <button
          className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted"
          onClick={onEdit}
          type="button"
        >
          <Pencil className="size-3" /> Edit
        </button>
      </div>
    </div>
  );
}

function WhatHappensNext() {
  return (
    <div className="app-card p-5">
      <h3 className="text-sm font-bold text-foreground">What happens next?</h3>
      <div className="mt-3 space-y-2.5 text-xs text-muted-foreground">
        {[
          "Our team will review your information",
          "We may contact you for additional verification",
          "Once verified, your hostel will go live",
          "You'll be able to manage bookings and listings",
        ].map((line) => (
          <p className="flex items-start gap-2" key={line}>
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-brand-teal" /> {line}
          </p>
        ))}
      </div>
    </div>
  );
}

export function HostelStatusView({
  application,
  onRegisterAnother,
  onResubmitted,
}: {
  application: OwnerApplication;
  onRegisterAnother: () => void;
  onResubmitted: () => Promise<void> | void;
}) {
  const needsInfo = application.status === "NEEDS_MORE_INFO";
  const [files, setFiles] = useState<Record<number, UploadedFile>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleUpload(index: number, e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const id = crypto.randomUUID();
    const label =
      application.requestedDocuments[index]?.documentType ?? "Requested document";
    setError("");
    setFiles((prev) => ({
      ...prev,
      [index]: { id, name: file.name, url: "", uploading: true },
    }));
    try {
      const uploaded = await uploadRegistrationDocument(file, label);
      setFiles((prev) => ({
        ...prev,
        [index]: { id, name: file.name, url: "", ...uploaded, uploading: false },
      }));
    } catch {
      setFiles((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      // The toaster already explains why; this keeps the inline form honest too.
      setError("Upload failed. Please try again.");
    }
    input.value = "";
  }

  const anyUploading = Object.values(files).some((f) => f.uploading);
  const uploadedCount = application.requestedDocuments.filter((_, i) => {
    const file = files[i];
    return Boolean(file && isUploadedFile(file));
  }).length;
  const canResubmit = uploadedCount > 0 && !anyUploading && !submitting;

  async function resubmit() {
    setSubmitting(true);
    setError("");
    try {
      const documents = application.requestedDocuments.flatMap((doc, i) => {
        const file = files[i];
        return file ? submittedDocuments(doc.documentType, [file]) : [];
      });
      await browserApi(
        `/api/v1/public/hostel-applications/${application.hostelId}/resubmit-documents`,
        {
          body: JSON.stringify({ documents }),
          method: "POST",
        },
      );
      setFiles({});
      await onResubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resubmit documents.");
    } finally {
      setSubmitting(false);
    }
  }

  /*
   * The status card, the three-stage timeline and the "approved, go log in"
   * copy that used to live here are gone.
   *
   * They described a journey that ended at approval, and the journey no longer
   * does: approval is the *middle* of it now, after which a plan is chosen and
   * paid for before anything is published. `HostelRegistrationProgress` owns
   * that whole arc, so this component keeps only the one thing it was doing
   * that the new page cannot do for itself — collecting the documents a
   * reviewer asked for — and hands it over as a slot.
   */
  return (
    <>
      <HostelRegistrationProgress
        application={{
          hostelId: application.hostelId,
          hostelName: application.hostelName,
          status: application.status,
        }}
        documentSlot={
          needsInfo ? (
            <div>
              {application.infoRequestNote ? (
                <p className="mb-4 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                  {application.infoRequestNote}
                </p>
              ) : null}

              <div className="space-y-3">
                {application.requestedDocuments.map((doc, index) => {
                  const uploaded = files[index];

                  return (
                    <div
                      className="rounded-lg border border-border bg-surface p-3"
                      key={`${doc.documentType}-${index}`}
                    >
                      <p className="text-sm font-semibold text-foreground">
                        {doc.documentType}
                      </p>
                      {doc.note ? (
                        <p className="text-xs text-muted-foreground">{doc.note}</p>
                      ) : null}
                      <div className="mt-2">
                        {uploaded ? (
                          <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2">
                            <div className="flex min-w-0 items-center gap-2.5">
                              {uploaded.uploading ? (
                                <Loader2 className="size-5 shrink-0 animate-spin text-muted-foreground" />
                              ) : (
                                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-teal/10 text-brand-teal">
                                  <FileText className="size-4" />
                                </div>
                              )}
                              <p className="truncate text-xs font-semibold text-foreground">
                                {uploaded.name}
                              </p>
                            </div>
                            <button
                              className="ml-2 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              onClick={() =>
                                setFiles((prev) => {
                                  const next = { ...prev };

                                  delete next[index];

                                  return next;
                                })
                              }
                              type="button"
                            >
                              <X className="size-4" />
                            </button>
                          </div>
                        ) : (
                          <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 py-3 text-center text-xs font-semibold text-foreground transition hover:border-brand-teal hover:bg-brand-teal/5">
                            <Upload className="size-4 text-muted-foreground" /> Upload
                            document
                            <input
                              accept="image/jpeg,image/png,image/webp,application/pdf,text/plain"
                              className="sr-only"
                              onChange={(event) => handleUpload(index, event)}
                              type="file"
                            />
                          </label>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {error ? (
                <p className="mt-3 text-xs font-medium text-destructive">{error}</p>
              ) : null}

              <button
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand-teal px-6 py-3 text-sm font-bold text-white shadow-sm transition hover:brightness-110 disabled:opacity-50"
                disabled={!canResubmit}
                onClick={resubmit}
                type="button"
              >
                <Send className="size-4" />
                {submitting
                  ? "Submitting…"
                  : anyUploading
                    ? "Waiting for uploads…"
                    : "Resubmit documents"}
              </button>
            </div>
          ) : null
        }
        onRefresh={onResubmitted}
      />

      <div className="mx-auto max-w-3xl px-4 pb-10 md:px-6">
        {application.status === "REJECTED" && application.rejectionReason ? (
          <div className="mb-5 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            <p className="font-semibold">Your application was not approved</p>
            <p className="mt-1">{application.rejectionReason}</p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-teal hover:underline"
            href="/"
          >
            <ArrowLeft className="size-4" /> Back to Homepage
          </Link>
          <button
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted"
            onClick={onRegisterAnother}
            type="button"
          >
            <Plus className="size-4" /> Register another hostel
          </button>
        </div>
      </div>
    </>
  );
}

function SubmittedView() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="app-card p-6 text-center sm:p-10">
        <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-emerald-100 text-success">
          <Check className="size-10" />
        </div>
        <h2 className="mt-5 text-2xl font-bold text-foreground">
          Registration received
        </h2>
        {/*
          * Says what actually happens next, and only through channels we
          * actually use. The old copy promised a reply "via email and WhatsApp"
          * — there is no WhatsApp integration anywhere in this product — and
          * named the plan the owner had supposedly chosen, at a point where
          * choosing one is no longer part of this form.
          */}
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
          We have your details and have emailed you to confirm. Our team checks
          everything within 1–2 business days, and this page will show you where
          it has got to — you can choose your plan here in the meantime.
        </p>
        <Link
          className="mt-6 inline-flex rounded-lg bg-brand-teal px-6 py-2.5 text-sm font-semibold text-white shadow transition hover:brightness-105"
          href="/"
        >
          Return to Homepage
        </Link>
      </div>
      <PortalsCard />
    </div>
  );
}
