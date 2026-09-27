import {
  AlertCircle,
  Briefcase,
  Camera,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  CreditCard,
  Download,
  Edit2,
  FileText,
  GraduationCap,
  Home,
  Loader2,
  MapPin,
  PenTool,
  Phone,
  Plus,
  QrCode,
  RotateCw,
  Shield,
  ShieldCheck,
  Sliders,
  Trash2,
  Upload,
  User,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { DotLottieReact } from "@lottiefiles/dotlottie-react";

import { PhotoCropper } from "@/components/photo-cropper";
import { SignaturePad } from "@/components/signature-pad";
import { useSiteConfig } from "@/components/site-config-provider";
import { WebCameraModal } from "@/components/web-camera-modal";
import { refreshSession } from "@/lib/auth-refresh";
import { acceptAttribute, uploadHint } from "@/lib/uploads/accepts";
import { uploadFile } from "@/lib/uploads/uploader";
import { ApiRequestError, browserApi } from "@/lib/browser-api";
import {
  loadCardImage,
  paintIdCard,
  idCardNoun,
  renderIdCardSheet,
  type IdCardData,
  type PlatformIdCardType,
} from "@/lib/platform-id-card";
import {
  IDENTITY_STEPS,
  draftFromProfile,
  firstIncompleteIdentityStep,
  validateIdentity,
  validateIdentityStep,
  type IdentityDraft,
  type IdentityErrors,
  type IdentityStep,
} from "@/lib/id-card-steps";
import { isSignatureComplete, SIGNATURE_HEIGHT, SIGNATURE_WIDTH } from "@/lib/signature";
import { isResidentPhone } from "@/modules/users/resident-identity.validation";
import { toast } from "@/stores/toast-store";
import { cn } from "@/lib/utils";

/*
 * The resident identity is the "fill it once" personal profile behind a user's
 * QR code / resident ID. Two surfaces live here:
 *
 *   - the ID card modal, opened from the header account menu
 *   - the profile form, opened either from the QR modal or by a prompt after a
 *     visitor sends an inquiry / browses several hostels
 *
 * Any component can open either one without prop-drilling, via the two request*
 * helpers below. Both modals portal to document.body so a transformed or
 * overflow-hidden ancestor cannot clip them.
 */

const QR_EVENT = "hh:resident-qr";
const FORM_EVENT = "hh:resident-profile-form";
/** Fired whenever the identity modal writes — lets embedded views refresh. */
const CHANGED_EVENT = "hh:resident-identity-changed";
const SNOOZE_KEY = "hh:resident-profile-prompt-until";
const SNOOZE_DAYS = 7;

export type ProfilePromptReason = "BROWSING" | "INQUIRY" | "MANUAL";

export function requestResidentQr() {
  window.dispatchEvent(new CustomEvent(QR_EVENT));
}

function broadcastIdentityChange() {
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
}

export function requestResidentProfileForm(reason: ProfilePromptReason = "MANUAL") {
  window.dispatchEvent(new CustomEvent(FORM_EVENT, { detail: { reason } }));
}

/**
 * Opens the profile prompt unless the visitor dismissed one in the last week.
 * Use this for automatic triggers; `requestResidentProfileForm` for taps.
 */
export function maybePromptForResidentProfile(reason: ProfilePromptReason) {
  try {
    const until = Number(window.localStorage.getItem(SNOOZE_KEY) ?? 0);

    if (Number.isFinite(until) && until > Date.now()) {
      return;
    }
  } catch {
    // Private mode / storage disabled — prompting is still the right default.
  }

  requestResidentProfileForm(reason);
}

function snoozePrompt() {
  try {
    window.localStorage.setItem(
      SNOOZE_KEY,
      String(Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000),
    );
  } catch {
    // Non-fatal: the prompt will simply appear again next time.
  }
}

/* ── Types mirroring /api/v1/users/resident-identity ── */

type ResidentIdentity = {
  accountEmail: string | null;
  accountName: string;
  /** Which card variant this account holds — derived by the server. */
  cardType?: PlatformIdCardType;
  /** Printed under the name. Null for residents, who use their own profile. */
  cardRole?: string | null;
  hasPhoto: boolean;
  hasProfile: boolean;
  hasSignatureImage?: boolean;
  signatureUpdatedAt?: string | null;
  lastSharedAt: string | null;
  photoUpdatedAt: string | null;
  residentId: string | null;
  shareCount: number;
  shareUrl: string | null;
  sharingEnabled: boolean;
  updatedAt: string | null;
};

type ResidentProfile = {
  age?: number | null;
  alternatePhone?: string;
  backupEmail?: string;
  bloodGroup: string;
  budgetRange?: string;
  city?: string;
  courseOrDesignation?: string;
  dateOfBirth?: string;
  dietaryPreference: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  emergencyContactRelation?: string;
  fullName: string;
  gender: string;
  governmentIdNumber?: string;
  governmentIdType?: string;
  guardianEmail?: string;
  guardianName: string;
  guardianPhone: string;
  guardianRelation: string;
  institution?: string;
  interests: string[];
  medicalNotes?: string;
  occupation: string;
  permanentAddress?: string;
  primaryEmail: string;
  primaryPhone: string;
  province?: string;
  secondGuardianEmail?: string;
  secondGuardianName?: string;
  secondGuardianPhone?: string;
  secondGuardianRelation?: string;
  /** Stroke data (lib/signature.ts). Absent on profiles saved before it existed. */
  signature?: string;
};

type IdentityResponse = {
  identity: ResidentIdentity;
  profile: ResidentProfile | null;
};

/* ── Small building blocks (public-site styling: brand-teal) ── */

function Modal({
  children,
  onClose,
  subtitle,
  title,
  toolbar,
  wide,
}: {
  children: ReactNode;
  onClose: () => void;
  subtitle?: string;
  title: string;
  /** Pinned under the header, outside the scroll — the step meter. */
  toolbar?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-slate-950/60 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div aria-hidden className="absolute inset-0" onClick={onClose} />
      <div
        aria-modal
        className={cn(
          "relative flex max-h-[96vh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-background font-sans shadow-2xl sm:rounded-2xl",
          wide ? "h-[96vh] sm:h-[94vh] sm:max-w-6xl" : "sm:max-w-md",
        )}
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4 sm:px-8 sm:py-5">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {title}
            </h2>
            {subtitle ? (
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {subtitle}
              </p>
            ) : null}
          </div>
          <button
            aria-label="Close"
            className="rounded-md p-1.5 text-foreground transition hover:bg-muted"
            onClick={onClose}
            type="button"
          >
            <X className="size-4" />
          </button>
        </div>
        {toolbar ? (
          <div className="border-b border-border px-6 py-3 sm:px-8">{toolbar}</div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-5 sm:px-8 sm:py-6">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The app's step artwork (`apps/mobile/assets/lottie`), served from `public/lottie`. */
const STEP_ART: Partial<Record<IdentityStep, string>> = {
  about: "/lottie/about.lottie",
  address: "/lottie/address.lottie",
  guardian: "/lottie/guardian.lottie",
  review: "/lottie/id-card.lottie",
  work: "/lottie/work.lottie",
};

/**
 * The picture at the left of a step's heading: its animation where the app has
 * one, otherwise the step's icon on a green tile. Reduce-motion shows the first
 * frame and plays nothing, as the app's `Lottie` does.
 */
function StepArt({ children, step }: { children: ReactNode; step: IdentityStep }) {
  const [reduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const src = STEP_ART[step];

  if (!src) {
    return (
      <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-brand-teal text-white">
        {children}
      </div>
    );
  }

  return (
    <div className="size-24 shrink-0">
      <DotLottieReact autoplay={!reduced} loop={!reduced} src={src} />
    </div>
  );
}

/*
 * Autosave, as the app's `identity-draft` does: a second after the last change
 * the form goes to this browser, keyed by account so two people on one machine
 * never see each other's half-filled KYC. Uploaded photo and signature keep
 * their asset handles and a data-URL preview. Cleared once the server accepts
 * the save.
 */
type IdentityDraftSnapshot = {
  draft: IdentityDraft;
  email: string;
  photoAssetId: string | null;
  photoPreview: string | null;
  showSecondGuardian: boolean;
  signatureAssetId: string | null;
  signatureMode: "draw" | "photo";
  signaturePreview: string | null;
  stepKey: IdentityStep;
};

function identityDraftKey(identity: ResidentIdentity) {
  return `hh_identity_draft_${identity.accountEmail ?? identity.accountName}`;
}

function readIdentityDraft(identity: ResidentIdentity): IdentityDraftSnapshot | null {
  try {
    const raw = window.localStorage.getItem(identityDraftKey(identity));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed !== null &&
      typeof parsed === "object" &&
      "draft" in parsed &&
      typeof (parsed as IdentityDraftSnapshot).stepKey === "string"
      ? (parsed as IdentityDraftSnapshot)
      : null;
  } catch {
    return null;
  }
}

function writeIdentityDraft(identity: ResidentIdentity, snapshot: IdentityDraftSnapshot | null) {
  try {
    if (snapshot) {
      window.localStorage.setItem(identityDraftKey(identity), JSON.stringify(snapshot));
    } else {
      window.localStorage.removeItem(identityDraftKey(identity));
    }
  } catch {
    // Storage full or blocked: the form on screen is still intact.
  }
}

function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function Field({
  defaultValue,
  hint,
  hintTone,
  label,
  max,
  name,
  onChange,
  placeholder,
  readOnly,
  required,
  type = "text",
}: {
  defaultValue?: string;
  hint?: string;
  /** Colours the hint and the border — the live email check's verdict. */
  hintTone?: "danger" | "success";
  label: string;
  max?: string;
  name: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  required?: boolean;
  type?: string;
}) {
  return (
    <label className="block text-xs font-medium text-foreground">
      {label}
      {required ? <span className="text-destructive"> *</span> : null}
      <input
        aria-invalid={hintTone === "danger" || undefined}
        className={cn(
          "mt-1.5 h-11 w-full rounded-lg border border-border bg-background px-3 text-sm font-normal text-foreground outline-none transition placeholder:text-foreground/45 focus:border-brand-teal focus:ring-2 focus:ring-brand-teal/15",
          readOnly && "cursor-not-allowed bg-muted/50",
          hintTone === "danger" &&
            "border-destructive ring-2 ring-destructive/20 focus:border-destructive focus:ring-destructive/25",
        )}
        defaultValue={defaultValue}
        max={max}
        name={name}
        onChange={onChange ? (event) => onChange(event.currentTarget.value) : undefined}
        placeholder={placeholder}
        readOnly={readOnly}
        required={required}
        type={type}
      />
      {hint ? (
        <span
          aria-live="polite"
          className={cn(
            "mt-1 block text-xs font-medium text-foreground/75",
            hintTone === "danger" && "text-destructive",
            hintTone === "success" && "text-brand-teal",
          )}
        >
          {hint}
        </span>
      ) : null}
    </label>
  );
}

type EmailCheck = "idle" | "checking" | "AVAILABLE" | "TAKEN" | "YOURS";

/**
 * Asks the server whether an email or phone is free once typing pauses. Each
 * new keystroke cancels the pending ask, so only the value the person settled
 * on is ever checked — and an answer is kept with the value it was for, so a
 * slow one for an older value can never show against a newer one. The save
 * re-checks; this only makes the refusal arrive early.
 */
function useContactCheck(kind: "email" | "phone", raw: string, enabled: boolean): EmailCheck {
  const value = kind === "email" ? raw.trim().toLowerCase() : raw.trim();
  const checkable =
    enabled &&
    (kind === "email" ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) : isResidentPhone(value));
  const [answer, setAnswer] = useState<{ status: EmailCheck; value: string } | null>(null);

  useEffect(() => {
    if (!checkable) {
      return;
    }

    let current = true;

    const timer = window.setTimeout(async () => {
      try {
        const result = await browserApi<{ status: Exclude<EmailCheck, "idle" | "checking"> }>(
          `/api/v1/users/resident-identity/${kind}-check?${kind}=${encodeURIComponent(value)}`,
        );

        if (current) {
          setAnswer({ status: result.status, value });
        }
      } catch {
        // Rate limited or offline: say nothing rather than guess. The save decides.
        if (current) {
          setAnswer({ status: "idle", value });
        }
      }
    }, 600);

    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [checkable, kind, value]);

  if (!checkable) {
    return "idle";
  }

  return answer?.value === value ? answer.status : "checking";
}

type CheckHint = { text?: string; tone?: "danger" | "success" };

const EMAIL_CHECK_HINTS: Record<EmailCheck, CheckHint> = {
  AVAILABLE: { text: "✓ Available", tone: "success" },
  checking: { text: "Checking…" },
  idle: {},
  TAKEN: { text: "Already used by another account. Use a different email.", tone: "danger" },
  YOURS: { text: "✓ This is your account's email", tone: "success" },
};

const PHONE_CHECK_HINTS: Record<EmailCheck, CheckHint> = {
  AVAILABLE: { text: "✓ Available", tone: "success" },
  checking: { text: "Checking…" },
  idle: {},
  TAKEN: { text: "Already used by another account. Use your own number.", tone: "danger" },
  YOURS: { text: "✓ This is your account's phone", tone: "success" },
};

function SelectField({
  children,
  defaultValue,
  invalid,
  label,
  name,
  onChange,
  required,
}: {
  children: ReactNode;
  defaultValue?: string;
  invalid?: boolean;
  label: string;
  name: string;
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
  required?: boolean;
}) {
  return (
    <label className="block text-xs font-medium text-foreground">
      {label}
      {required ? <span className="text-destructive"> *</span> : null}
      <select
        aria-invalid={invalid || undefined}
        className={cn(
          "mt-1.5 h-11 w-full cursor-pointer rounded-lg border border-border bg-background px-3 text-sm font-normal text-foreground outline-none transition focus:border-brand-teal focus:ring-2 focus:ring-brand-teal/15",
          invalid &&
            "border-destructive ring-2 ring-destructive/20 focus:border-destructive focus:ring-destructive/25",
        )}
        defaultValue={defaultValue}
        name={name}
        onChange={onChange}
        required={required}
      >
        {children}
      </select>
    </label>
  );
}

function SectionTitle({
  hint,
  icon: Icon,
  label,
}: {
  hint?: string;
  icon?: LucideIcon;
  label: string;
}) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border pb-2 text-xs font-semibold text-foreground">
      {Icon ? <Icon className="size-3.5 text-brand-teal" /> : null}
      {label}
      {hint ? (
        <span className="font-medium normal-case tracking-normal text-foreground/55">
          {hint}
        </span>
      ) : null}
    </p>
  );
}

/**
 * A 422 from the API carries `details` = ZodError.flatten(). Surfacing the field
 * name matters: "Could not save your details" on a form this long leaves the
 * user hunting through nine sections for the problem.
 */
function describeSaveError(error: unknown) {
  const fallback = "Could not save your details.";

  if (!(error instanceof ApiRequestError)) {
    return error instanceof Error ? error.message : fallback;
  }

  const details = error.details as
    | { formErrors?: string[]; issues?: { message: string; path: string }[] }
    | undefined;

  const problems = [
    ...(details?.formErrors ?? []),
    ...(details?.issues ?? []).map((issue) => {
      // Paths arrive as `profile.backupEmail`; the leaf is the input name.
      const field = issue.path.split(".").filter(Boolean).pop() ?? "";
      const label = FIELD_LABELS[field];

      // Cross-field rules (the two-email check) already read as full sentences,
      // so a label prefix would only make them clumsier.
      return label && field !== "profile" ? `${label}: ${issue.message}` : issue.message;
    }),
  ];

  return problems.length > 0
    ? Array.from(new Set(problems)).join(" · ")
    : error.message || fallback;
}

/** Maps schema keys back to the labels shown on the form. */
const FIELD_LABELS: Record<string, string> = {
  backupEmail: "Backup email",
  bloodGroup: "Blood group",
  dateOfBirth: "Date of birth",
  fullName: "Full name",
  gender: "Gender",
  governmentIdNumber: "ID number",
  governmentIdType: "ID type",
  guardianEmail: "Guardian email",
  guardianName: "Guardian name",
  guardianPhone: "Guardian phone",
  guardianRelation: "Guardian relation",
  interests: "Interests",
  medicalNotes: "Allergies or medical notes",
  primaryEmail: "Account email",
  primaryPhone: "Phone",
  profile: "Profile",
  secondGuardianEmail: "Second guardian email",
  secondGuardianPhone: "Second guardian phone",
  signature: "Signature",
};

/* ── The one-time profile form ── */

const PROMPT_COPY: Record<ProfilePromptReason, { subtitle: string; title: string }> = {
  BROWSING: {
    subtitle:
      "You have looked at a few hostels. Save your details once and every hostel you apply to can fill their form by scanning your code — you never type this again.",
    title: "Set up your resident ID",
  },
  INQUIRY: {
    subtitle:
      "Your inquiry is on its way. Save your details once now and the hostel can complete your registration by scanning your code instead of asking you to fill another form.",
    title: "Save your details once",
  },
  MANUAL: {
    subtitle:
      "Stored encrypted and shared only when you show your QR code or give someone your resident ID.",
    title: "Your resident details",
  },
};

function ProfileForm({
  identity,
  onClose,
  onSaved,
  profile,
  reason,
}: {
  identity: ResidentIdentity;
  onClose: () => void;
  onSaved: (next: IdentityResponse) => void;
  profile: ResidentProfile | null;
  reason: ProfilePromptReason;
}) {
  const [stored] = useState(() => readIdentityDraft(identity));
  const [draft, setDraft] = useState<IdentityDraft>(
    () => stored?.draft ?? draftFromProfile(profile),
  );

  const [stepKey, setStepKey] = useState<IdentityStep>(
    () => stored?.stepKey ?? (identity.hasProfile ? "review" : "about"),
  );

  const [stepErrors, setStepErrors] = useState<IdentityErrors>({});
  // The terms are agreed once, on the first save — editing later does not re-ask.
  const isFirstSave = !identity.hasProfile;
  const [agreed, setAgreed] = useState(false);
  const [sharingEnabled, setSharingEnabled] = useState(identity.sharingEnabled);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [showSecondGuardian, setShowSecondGuardian] = useState(
    stored?.showSecondGuardian ?? Boolean(profile?.secondGuardianName),
  );
  const errorRef = useRef<HTMLDivElement>(null);
  const copy = PROMPT_COPY[reason];

  const emailLocked = Boolean(identity.accountEmail);
  const [email, setEmail] = useState(
    identity.accountEmail ?? stored?.email ?? profile?.primaryEmail ?? "",
  );
  const emailCheck = useContactCheck("email", email, !emailLocked);
  const emailHint = emailLocked
    ? { text: "Your sign-in email — filled in for you.", tone: undefined }
    : EMAIL_CHECK_HINTS[emailCheck];
  // Only a number being set or changed is checked — the save applies the same rule.
  const phoneCheck = useContactCheck(
    "phone",
    draft.primaryPhone,
    draft.primaryPhone.trim() !== (profile?.primaryPhone ?? "").trim(),
  );
  const phoneHint = PHONE_CHECK_HINTS[phoneCheck];

  // Signature state
  const [signatureMode, setSignatureMode] = useState<"draw" | "photo">(
    stored?.signatureMode ?? (identity.hasSignatureImage ? "photo" : "draw"),
  );
  const [signatureAssetId, setSignatureAssetId] = useState<string | null>(
    stored?.signatureAssetId ?? null,
  );
  const [signaturePreview, setSignaturePreview] = useState<string | null>(
    stored?.signaturePreview ??
      (identity.hasSignatureImage ? identitySignatureUrl(identity) : null),
  );
  const [uploadingSignature, setUploadingSignature] = useState(false);
  const signatureInputRef = useRef<HTMLInputElement>(null);

  // Photo state
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [photoAssetId, setPhotoAssetId] = useState<string | null>(
    stored?.photoAssetId ?? null,
  );
  const [photoPreview, setPhotoPreview] = useState<string | null>(
    stored?.photoPreview ?? (identity.hasPhoto ? identityPhotoUrl(identity) : null),
  );
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // Camera modal state
  const [cameraModal, setCameraModal] = useState<{
    aspectRatio: number;
    facingMode: "environment" | "user";
    target: "photo" | "signature";
    title: string;
  } | null>(null);

  const stepIndex = IDENTITY_STEPS.findIndex((s) => s.key === stepKey);
  const stepInfo = IDENTITY_STEPS[stepIndex] ?? IDENTITY_STEPS[0];
  // Direction is fixed when the step changes, not recomputed per render — a
  // class flip mid-step would replay the slide on every keystroke.
  const [stepMotion, setStepMotion] = useState({ forward: true, key: stepKey });
  if (stepMotion.key !== stepKey) {
    setStepMotion({
      forward: stepIndex > IDENTITY_STEPS.findIndex((s) => s.key === stepMotion.key),
      key: stepKey,
    });
  }

  function updateField<K extends keyof IdentityDraft>(key: K, value: IdentityDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    // A flagged field stays red until what is in it actually passes — not
    // merely until the first keystroke.
    if (stepErrors[key]) {
      const still = validateIdentityStep(stepKey, { ...draft, [key]: value })[key];
      setStepErrors((prev) => {
        const copyErrs = { ...prev };
        if (still) copyErrs[key] = still;
        else delete copyErrs[key];
        if (Object.keys(copyErrs).length === 0) setError("");
        return copyErrs;
      });
    }
  }

  function handlePhotoPicked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) {
      setError("");
      setPendingPhoto(file);
    }
  }

  async function handleCroppedPhoto(cropped: File) {
    setPendingPhoto(null);
    // A data URL rather than a blob URL, so the autosaved draft can show it again.
    setPhotoPreview(await readAsDataUrl(cropped));
    setUploadingPhoto(true);

    try {
      const uploaded = await uploadFile(cropped, {
        accessLevel: "PRIVATE",
        kind: "image",
        label: "ID card photo",
        silent: true,
        target: "asset",
      });

      if (uploaded?.assetId) {
        setPhotoAssetId(uploaded.assetId);
      } else {
        setPhotoPreview(identity.hasPhoto ? identityPhotoUrl(identity) : null);
        setError("That photo could not be uploaded. Please try another one.");
      }
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function handleCroppedSignature(cropped: File) {
    const preview = await readAsDataUrl(cropped);
    setSignaturePreview(preview);
    updateField("signatureImageUri", preview);
    updateField("signature", "");
    setUploadingSignature(true);

    try {
      const uploaded = await uploadFile(cropped, {
        accessLevel: "PRIVATE",
        kind: "image",
        label: "ID card signature",
        silent: true,
        target: "asset",
      });

      if (uploaded?.assetId) {
        setSignatureAssetId(uploaded.assetId);
      } else {
        setError("That signature photo could not be uploaded. Please try another one.");
      }
    } finally {
      setUploadingSignature(false);
    }
  }

  function handleCameraCapture(file: File) {
    if (!cameraModal) return;
    const target = cameraModal.target;
    setCameraModal(null);

    if (target === "photo") {
      void handleCroppedPhoto(file);
    } else {
      void handleCroppedSignature(file);
    }
  }

  function handleNext() {
    setError("");
    if (stepKey === "contact") {
      updateField("primaryEmail", email);
    }

    const currentErrors = validateIdentityStep(stepKey, draft);
    // A taken email or number is refused here, not after the whole form.
    if (stepKey === "contact" && emailCheck === "TAKEN" && !currentErrors.primaryEmail) {
      currentErrors.primaryEmail = EMAIL_CHECK_HINTS.TAKEN.text;
    }
    if (stepKey === "contact" && phoneCheck === "TAKEN" && !currentErrors.primaryPhone) {
      currentErrors.primaryPhone = PHONE_CHECK_HINTS.TAKEN.text;
    }
    if (Object.keys(currentErrors).length > 0) {
      setStepErrors(currentErrors);
      setError("Please fix the highlighted fields to continue.");
      return;
    }

    setStepErrors({});
    const nextIdx = Math.min(IDENTITY_STEPS.length - 1, stepIndex + 1);
    setStepKey(IDENTITY_STEPS[nextIdx].key);
  }

  function handleSkip() {
    setError("");
    setStepErrors({});
    const nextIdx = Math.min(IDENTITY_STEPS.length - 1, stepIndex + 1);
    setStepKey(IDENTITY_STEPS[nextIdx].key);
  }

  function handleBack() {
    setError("");
    setStepErrors({});
    const prevIdx = Math.max(0, stepIndex - 1);
    setStepKey(IDENTITY_STEPS[prevIdx].key);
  }

  async function handleSubmit(event?: FormEvent) {
    if (event) event.preventDefault();
    setError("");

    const hasPhoto = Boolean(photoAssetId || identity.hasPhoto);
    const hasSignatureImage = Boolean(signatureAssetId || identity.hasSignatureImage);

    if (!hasPhoto) {
      setError("Add a photo of yourself — it goes on the front of your card.");
      setStepKey("photo");
      return;
    }

    if (
      !hasSignatureImage &&
      !draft.signatureImageUri.trim() &&
      !isSignatureComplete(draft.signature)
    ) {
      setError("Sign your card — draw it, or photograph it on paper.");
      setStepKey("signature");
      return;
    }

    const allErrors = validateIdentity(draft);
    if (Object.keys(allErrors).length > 0) {
      const firstBad = firstIncompleteIdentityStep(draft, { hasPhoto, hasSignatureImage });
      if (firstBad) {
        setStepKey(firstBad);
        setStepErrors(validateIdentityStep(firstBad, draft));
      }
      setError("Please fix the highlighted details before saving.");
      return;
    }

    setSaving(true);

    try {
      const profileData = {
        alternatePhone: draft.alternatePhone.trim() || undefined,
        backupEmail: draft.backupEmail.trim() || undefined,
        bloodGroup: draft.bloodGroup,
        budgetRange: draft.budgetRange.trim() || undefined,
        city: draft.city.trim() || undefined,
        courseOrDesignation: draft.courseOrDesignation.trim() || undefined,
        dateOfBirth: draft.dateOfBirth.trim() || undefined,
        dietaryPreference: draft.dietaryPreference,
        emergencyContactName: draft.emergencyContactName.trim() || undefined,
        emergencyContactPhone: draft.emergencyContactPhone.trim() || undefined,
        emergencyContactRelation: draft.emergencyContactRelation.trim() || undefined,
        fullName: draft.fullName.trim(),
        gender: draft.gender,
        governmentIdNumber: draft.governmentIdNumber.trim() || undefined,
        governmentIdType: draft.governmentIdType || undefined,
        guardianEmail: draft.guardianEmail.trim() || undefined,
        guardianName: draft.guardianName.trim(),
        guardianPhone: draft.guardianPhone.trim(),
        guardianRelation: draft.guardianRelation.trim(),
        institution: draft.institution.trim() || undefined,
        interests: draft.interests.map((i) => i.trim()).filter(Boolean).slice(0, 12),
        medicalNotes: draft.medicalNotes.trim() || undefined,
        occupation: draft.occupation,
        permanentAddress: draft.permanentAddress.trim() || undefined,
        primaryEmail: (email || draft.primaryEmail).trim().toLowerCase(),
        primaryPhone: draft.primaryPhone.trim(),
        province: draft.province.trim() || undefined,
        secondGuardianEmail: draft.secondGuardianEmail.trim() || undefined,
        secondGuardianName: draft.secondGuardianName.trim() || undefined,
        secondGuardianPhone: draft.secondGuardianPhone.trim() || undefined,
        secondGuardianRelation: draft.secondGuardianRelation.trim() || undefined,
        ...(signatureAssetId ? {} : { signature: draft.signature }),
        ...(signatureAssetId ? { signatureAssetId } : {}),
      };

      const next = await browserApi<IdentityResponse>("/api/v1/users/resident-identity", {
        body: JSON.stringify({
          profile: profileData,
          ...(photoAssetId ? { photoAssetId } : {}),
          sharingEnabled,
        }),
        method: "PUT",
      });

      savedRef.current = true;
      writeIdentityDraft(identity, null);
      onSaved(next);
    } catch (saveError) {
      setError(describeSaveError(saveError));
    } finally {
      setSaving(false);
    }
  }

  const hasPhotoAsset = Boolean(photoAssetId || identity.hasPhoto);
  const hasSignatureAsset = Boolean(signatureAssetId || identity.hasSignatureImage);

  const snapshotJson = JSON.stringify({
    draft,
    email,
    photoAssetId,
    photoPreview: photoPreview?.startsWith("data:") ? photoPreview : null,
    showSecondGuardian,
    signatureAssetId,
    signatureMode,
    signaturePreview: signaturePreview?.startsWith("data:") ? signaturePreview : null,
    stepKey,
  } satisfies IdentityDraftSnapshot);
  // Opening and leaving is not a draft: nothing is written until the form
  // differs from how it opened. `savedRef` stops a pending timer re-writing a
  // draft the successful save just cleared.
  const openedJson = useRef(snapshotJson);
  const savedRef = useRef(false);

  useEffect(() => {
    if (snapshotJson === openedJson.current) return;
    const timer = window.setTimeout(() => {
      if (!savedRef.current) {
        writeIdentityDraft(identity, JSON.parse(snapshotJson) as IdentityDraftSnapshot);
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [identity, snapshotJson]);

  return (
    <Modal
      onClose={onClose}
      subtitle={copy.subtitle}
      title={copy.title}
      toolbar={
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs font-medium text-foreground">
            <span className="font-semibold text-brand-teal">
              Step {stepIndex + 1} of {IDENTITY_STEPS.length} — {stepInfo.title}
            </span>
            <span>{Math.round(((stepIndex + 1) / IDENTITY_STEPS.length) * 100)}% Complete</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-brand-teal transition-all duration-300 ease-out"
              style={{ width: `${((stepIndex + 1) / IDENTITY_STEPS.length) * 100}%` }}
            />
          </div>
        </div>
      }
      wide
    >
      {stored ? (
        <p className="mb-4 text-xs text-muted-foreground">Picked up where you left off.</p>
      ) : null}
      {cameraModal ? (
        <WebCameraModal
          aspectRatio={cameraModal.aspectRatio}
          facingMode={cameraModal.facingMode}
          onCapture={handleCameraCapture}
          onClose={() => setCameraModal(null)}
          title={cameraModal.title}
        />
      ) : null}

      {pendingPhoto ? (
        <PhotoCropper
          file={pendingPhoto}
          onCancel={() => setPendingPhoto(null)}
          onCropped={handleCroppedPhoto}
        />
      ) : null}

      <div className="space-y-6">
        {error ? (
          <div
            aria-live="assertive"
            className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm font-semibold text-destructive outline-none"
            ref={errorRef}
            role="alert"
            tabIndex={-1}
          >
            {error}
          </div>
        ) : null}

        {/* Step Contents */}
        <div
          className={stepMotion.forward ? "animate-step-from-right" : "animate-step-from-left"}
          key={stepKey}
        >
        {stepKey === "about" && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 p-3">
              <StepArt step={stepKey}><User className="size-5" /></StepArt>
              <div>
                <h4 className="text-sm font-semibold text-foreground">Personal Profile</h4>
                <p className="text-xs text-muted-foreground">Enter your name exactly as shown on your citizenship or government ID.</p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Field
                  defaultValue={draft.fullName || identity.accountName}
                  hint={stepErrors.fullName}
                  hintTone={stepErrors.fullName ? "danger" : undefined}
                  label="Full name"
                  name="fullName"
                  onChange={(val) => updateField("fullName", val)}
                  placeholder="As written on your ID"
                  required
                />
              </div>
              <div>
                <Field
                  defaultValue={draft.dateOfBirth}
                  hint={stepErrors.dateOfBirth || "Used to display your age on your resident card."}
                  hintTone={stepErrors.dateOfBirth ? "danger" : undefined}
                  label="Date of birth"
                  max={new Date().toISOString().slice(0, 10)}
                  name="dateOfBirth"
                  onChange={(val) => updateField("dateOfBirth", val)}
                  required
                  type="date"
                />
              </div>
              <div>
                <SelectField
                  defaultValue={draft.gender}
                  invalid={Boolean(stepErrors.gender)}
                  label="Gender"
                  name="gender"
                  onChange={(e) => updateField("gender", e.target.value)}
                  required
                >
                  <option disabled value="">
                    Select gender
                  </option>
                  <option value="MALE">Male</option>
                  <option value="FEMALE">Female</option>
                  <option value="OTHER">Other</option>
                  <option value="PREFER_NOT_TO_SAY">Prefer not to say</option>
                </SelectField>
                {stepErrors.gender ? (
                  <p className="mt-1 text-xs font-semibold text-destructive">{stepErrors.gender}</p>
                ) : null}
              </div>
              <div>
                <SelectField
                  defaultValue={draft.bloodGroup || "UNKNOWN"}
                  label="Blood group"
                  name="bloodGroup"
                  onChange={(e) => updateField("bloodGroup", e.target.value)}
                >
                  {["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((group) => (
                    <option key={group} value={group}>
                      {group}
                    </option>
                  ))}
                  <option value="UNKNOWN">I do not know</option>
                </SelectField>
              </div>
            </div>
          </div>
        )}

        {stepKey === "contact" && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 p-3">
              <StepArt step={stepKey}><Phone className="size-5" /></StepArt>
              <div>
                <h4 className="text-sm font-semibold text-foreground">Contact Methods</h4>
                <p className="text-xs text-muted-foreground">Hostels and emergency services use this phone and email to reach you.</p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Field
                  defaultValue={draft.primaryPhone}
                  hint={stepErrors.primaryPhone || phoneHint.text}
                  hintTone={stepErrors.primaryPhone ? "danger" : phoneHint.tone}
                  label="Phone number"
                  name="primaryPhone"
                  onChange={(val) => updateField("primaryPhone", val)}
                  placeholder="98XXXXXXXX"
                  required
                  type="tel"
                />
              </div>
              <div>
                <Field
                  defaultValue={draft.alternatePhone}
                  hint={stepErrors.alternatePhone}
                  hintTone={stepErrors.alternatePhone ? "danger" : undefined}
                  label="Alternate phone"
                  name="alternatePhone"
                  onChange={(val) => updateField("alternatePhone", val)}
                  placeholder="Optional"
                  type="tel"
                />
              </div>
              <div>
                <Field
                  defaultValue={email}
                  hint={stepErrors.primaryEmail || emailHint.text}
                  hintTone={stepErrors.primaryEmail ? "danger" : emailHint.tone}
                  label="Account email"
                  name="primaryEmail"
                  onChange={(val) => {
                    setEmail(val);
                    updateField("primaryEmail", val);
                  }}
                  readOnly={emailLocked}
                  required
                  type="email"
                />
              </div>
              <div>
                <Field
                  defaultValue={draft.backupEmail}
                  hint={stepErrors.backupEmail || "Second email in case primary is unreachable."}
                  hintTone={stepErrors.backupEmail ? "danger" : undefined}
                  label="Backup email"
                  name="backupEmail"
                  onChange={(val) => updateField("backupEmail", val)}
                  placeholder="Optional"
                  type="email"
                />
              </div>
            </div>
          </div>
        )}

        {stepKey === "address" && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 p-3">
              <StepArt step={stepKey}><MapPin className="size-5" /></StepArt>
              <div>
                <h4 className="text-sm font-semibold text-foreground">Permanent Residence</h4>
                <p className="text-xs text-muted-foreground">Your permanent home address recorded for residency verification.</p>
              </div>
            </div>

            <Field
              defaultValue={draft.permanentAddress}
              hint={stepErrors.permanentAddress}
              hintTone={stepErrors.permanentAddress ? "danger" : undefined}
              label="Permanent address"
              name="permanentAddress"
              onChange={(val) => updateField("permanentAddress", val)}
              placeholder="Street / tole, ward, house number"
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                defaultValue={draft.city}
                label="City / Municipality"
                name="city"
                onChange={(val) => updateField("city", val)}
                placeholder="e.g. Kathmandu, Pokhara"
              />
              <Field
                defaultValue={draft.province}
                label="Province / State"
                name="province"
                onChange={(val) => updateField("province", val)}
                placeholder="e.g. Bagmati Province"
              />
            </div>
          </div>
        )}

        {stepKey === "work" && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 p-3">
              <StepArt step={stepKey}><Briefcase className="size-5" /></StepArt>
              <div>
                <h4 className="text-sm font-semibold text-foreground">Occupation & Institution</h4>
                <p className="text-xs text-muted-foreground">Select your current status for resident profiling.</p>
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-foreground">I am a</label>
              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  { desc: "College or university student", icon: GraduationCap, key: "STUDENT", title: "Student" },
                  { desc: "Working professional or employee", icon: Briefcase, key: "WORKING_PROFESSIONAL", title: "Working Professional" },
                  { desc: "Staying for personal reasons or travel", icon: Home, key: "OTHER", title: "Neither (Personal Stay)" },
                ].map((opt) => {
                  const IconC = opt.icon;
                  const isSelected = (draft.occupation || "STUDENT") === opt.key;
                  return (
                    <button
                      key={opt.key}
                      className={cn(
                        "flex flex-col items-start rounded-xl border p-3.5 text-left transition",
                        isSelected
                          ? "border-brand-teal bg-brand-teal/10 shadow-sm ring-2 ring-brand-teal/20"
                          : "border-border bg-surface hover:bg-muted/40",
                      )}
                      onClick={() => updateField("occupation", opt.key)}
                      type="button"
                    >
                      <div className="flex w-full items-center justify-between">
                        <IconC className={cn("size-5", isSelected ? "text-brand-teal" : "text-foreground/60")} />
                        {isSelected ? <CheckCircle2 className="size-4 text-brand-teal" /> : null}
                      </div>
                      <span className="mt-2 text-xs font-semibold text-foreground">{opt.title}</span>
                      <span className="mt-0.5 text-[11px] text-muted-foreground leading-tight">{opt.desc}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 pt-2">
              <Field
                defaultValue={draft.institution}
                hint="College or company name"
                label="College / Company"
                name="institution"
                onChange={(val) => updateField("institution", val)}
                placeholder="e.g. Apex College / Nabil Bank"
              />
              <Field
                defaultValue={draft.courseOrDesignation}
                label="Course / Job title"
                name="courseOrDesignation"
                onChange={(val) => updateField("courseOrDesignation", val)}
                placeholder="e.g. BBA / Software Engineer"
              />
            </div>
          </div>
        )}

        {stepKey === "guardian" && (
          <div className="space-y-5">
            <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 p-3">
              <StepArt step={stepKey}><Shield className="size-5" /></StepArt>
              <div>
                <h4 className="text-sm font-semibold text-foreground">Guardian & Emergency Contacts</h4>
                <p className="text-xs text-muted-foreground">At least one reachable adult contact is required for your safety.</p>
              </div>
            </div>

            <div className="space-y-3">
              <SectionTitle label="Primary Guardian" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  defaultValue={draft.guardianName}
                  hint={stepErrors.guardianName}
                  hintTone={stepErrors.guardianName ? "danger" : undefined}
                  label="Guardian name"
                  name="guardianName"
                  onChange={(val) => updateField("guardianName", val)}
                  required
                />
                <Field
                  defaultValue={draft.guardianRelation}
                  hint={stepErrors.guardianRelation}
                  hintTone={stepErrors.guardianRelation ? "danger" : undefined}
                  label="Relation"
                  name="guardianRelation"
                  onChange={(val) => updateField("guardianRelation", val)}
                  placeholder="Father, mother, uncle…"
                  required
                />
                <Field
                  defaultValue={draft.guardianPhone}
                  hint={stepErrors.guardianPhone}
                  hintTone={stepErrors.guardianPhone ? "danger" : undefined}
                  label="Guardian phone"
                  name="guardianPhone"
                  onChange={(val) => updateField("guardianPhone", val)}
                  required
                  type="tel"
                />
                <Field
                  defaultValue={draft.guardianEmail}
                  hint={stepErrors.guardianEmail || "For guardian portal access."}
                  hintTone={stepErrors.guardianEmail ? "danger" : undefined}
                  label="Guardian email"
                  name="guardianEmail"
                  onChange={(val) => updateField("guardianEmail", val)}
                  type="email"
                />
              </div>
            </div>

            {showSecondGuardian ? (
              <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
                <SectionTitle label="Second Guardian (Optional)" />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    defaultValue={draft.secondGuardianName}
                    label="Second guardian name"
                    name="secondGuardianName"
                    onChange={(val) => updateField("secondGuardianName", val)}
                  />
                  <Field
                    defaultValue={draft.secondGuardianRelation}
                    label="Relation"
                    name="secondGuardianRelation"
                    onChange={(val) => updateField("secondGuardianRelation", val)}
                  />
                  <Field
                    defaultValue={draft.secondGuardianPhone}
                    label="Phone"
                    name="secondGuardianPhone"
                    onChange={(val) => updateField("secondGuardianPhone", val)}
                    type="tel"
                  />
                  <Field
                    defaultValue={draft.secondGuardianEmail}
                    label="Email"
                    name="secondGuardianEmail"
                    onChange={(val) => updateField("secondGuardianEmail", val)}
                    type="email"
                  />
                </div>
              </div>
            ) : (
              <button
                className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-teal hover:underline"
                onClick={() => setShowSecondGuardian(true)}
                type="button"
              >
                <Plus className="size-3.5" />
                Add a second guardian
              </button>
            )}

            <div className="space-y-3 border-t border-border pt-3">
              <SectionTitle hint="Leave blank to use primary guardian" label="Emergency Contact" />
              <div className="grid gap-4 sm:grid-cols-3">
                <Field
                  defaultValue={draft.emergencyContactName}
                  label="Name"
                  name="emergencyContactName"
                  onChange={(val) => updateField("emergencyContactName", val)}
                />
                <Field
                  defaultValue={draft.emergencyContactRelation}
                  label="Relation"
                  name="emergencyContactRelation"
                  onChange={(val) => updateField("emergencyContactRelation", val)}
                />
                <Field
                  defaultValue={draft.emergencyContactPhone}
                  label="Phone"
                  name="emergencyContactPhone"
                  onChange={(val) => updateField("emergencyContactPhone", val)}
                  type="tel"
                />
              </div>
            </div>
          </div>
        )}

        {stepKey === "preferences" && (
          <div className="space-y-5">
            <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 p-3">
              <StepArt step={stepKey}><Sliders className="size-5" /></StepArt>
              <div>
                <h4 className="text-sm font-semibold text-foreground">Preferences & Identification</h4>
                <p className="text-xs text-muted-foreground">Select your dietary preferences and specify your government proof of identity.</p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                defaultValue={draft.dietaryPreference || "NO_PREFERENCE"}
                label="Food preference"
                name="dietaryPreference"
                onChange={(e) => updateField("dietaryPreference", e.target.value)}
              >
                <option value="NO_PREFERENCE">No preference</option>
                <option value="VEG">Vegetarian</option>
                <option value="NON_VEG">Non-vegetarian</option>
                <option value="EGGETARIAN">Eggetarian</option>
                <option value="VEGAN">Vegan</option>
              </SelectField>
              <Field
                defaultValue={draft.budgetRange}
                hint="Prefills inquiry forms"
                label="Monthly budget range"
                name="budgetRange"
                onChange={(val) => updateField("budgetRange", val)}
                placeholder="e.g. 8000-12000"
              />
            </div>

            <Field
              defaultValue={draft.interests?.join(", ")}
              hint="Comma separated. Used for roommate suggestions."
              label="Interests & Hobbies"
              name="interests"
              onChange={(val) =>
                updateField(
                  "interests",
                  val.split(",").map((i) => i.trim()).filter(Boolean),
                )
              }
              placeholder="e.g. Football, Music, Coding"
            />

            <label className="block text-xs font-medium text-foreground">
              Medical Notes / Allergies
              <textarea
                className="mt-1.5 min-h-20 w-full rounded-lg border border-border bg-background p-3 text-sm font-normal text-foreground outline-none focus:border-brand-teal focus:ring-2 focus:ring-brand-teal/15"
                defaultValue={draft.medicalNotes}
                maxLength={500}
                onChange={(e) => updateField("medicalNotes", e.target.value)}
                placeholder="Anything the hostel warden should know in an emergency."
              />
            </label>

            {/* Visual Government ID Selector Cards */}
            <div className="border-t border-border pt-4 space-y-3">
              <SectionTitle label="Government Proof of Identity" />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">Select the type of government document you hold:</p>
                <button
                  aria-pressed={!draft.governmentIdType}
                  className={cn(
                    "shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition",
                    draft.governmentIdType
                      ? "border-border text-foreground hover:bg-muted"
                      : "border-brand-teal bg-brand-teal/10 text-brand-teal",
                  )}
                  onClick={() => {
                    updateField("governmentIdType", "");
                    updateField("governmentIdNumber", "");
                  }}
                  type="button"
                >
                  Not now
                </button>
              </div>
              
              <div className="grid gap-2.5 sm:grid-cols-3">
                {[
                  { icon: CreditCard, key: "CITIZENSHIP", label: "Citizenship Card" },
                  { icon: ShieldCheck, key: "NATIONAL_ID", label: "National ID" },
                  { icon: FileText, key: "PASSPORT", label: "Passport" },
                  { icon: CreditCard, key: "DRIVING_LICENSE", label: "Driving License" },
                  { icon: GraduationCap, key: "STUDENT_ID", label: "Student ID" },
                  { icon: FileText, key: "OTHER", label: "Other Document" },
                ].map((doc) => {
                  const DocIcon = doc.icon;
                  const isSel = (draft.governmentIdType || "") === doc.key;
                  return (
                    <button
                      key={doc.key}
                      className={cn(
                        "flex items-center gap-2.5 rounded-xl border p-3 text-left transition",
                        isSel
                          ? "border-brand-teal bg-brand-teal/10 shadow-sm ring-2 ring-brand-teal/20"
                          : "border-border bg-surface hover:bg-muted/40",
                      )}
                      onClick={() => updateField("governmentIdType", doc.key)}
                      type="button"
                    >
                      <DocIcon className={cn("size-4 shrink-0", isSel ? "text-brand-teal" : "text-foreground/60")} />
                      <span className="text-xs font-medium text-foreground truncate flex-1">{doc.label}</span>
                      {isSel ? <CheckCircle2 className="size-4 text-brand-teal shrink-0" /> : null}
                    </button>
                  );
                })}
              </div>

              {draft.governmentIdType ? (
                <div className="pt-2">
                  <Field
                    defaultValue={draft.governmentIdNumber}
                    hint="Document / Certificate number"
                    label={`${draft.governmentIdType.replace(/_/g, " ")} Number`}
                    name="governmentIdNumber"
                    onChange={(val) => updateField("governmentIdNumber", val)}
                    placeholder="Enter document number"
                  />
                </div>
              ) : null}
            </div>
          </div>
        )}

        {stepKey === "photo" && (
          <div className="space-y-5 text-center">
            <div className="flex items-center justify-center gap-3 rounded-xl border border-border bg-muted/30 p-3 text-left">
              <StepArt step={stepKey}><Camera className="size-5" /></StepArt>
              <div>
                <h4 className="text-sm font-semibold text-foreground">Front-Facing Passport Photo</h4>
                <p className="text-xs text-muted-foreground">Align your face in the middle frame. Printed on the front of your ID card.</p>
              </div>
            </div>

            {/* Passport Frame Preview */}
            <div className="relative mx-auto flex size-40 items-center justify-center overflow-hidden rounded-2xl border-2 border-brand-teal bg-slate-900 shadow-xl">
              {photoPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img alt="Card photo" className="size-full object-cover" src={photoPreview} />
              ) : (
                <div className="flex flex-col items-center gap-2 p-4 text-center">
                  <Camera className="size-10 text-white/50 animate-pulse" />
                  <span className="text-[11px] font-medium text-white/70">Align face in box</span>
                </div>
              )}

              <div className="pointer-events-none absolute inset-2 rounded-xl border border-dashed border-white/40" />

              {uploadingPhoto ? (
                <span className="absolute inset-0 grid place-items-center bg-slate-950/70 backdrop-blur-xs">
                  <Loader2 className="size-8 animate-spin text-brand-teal" />
                </span>
              ) : null}
            </div>

            {/* Photo Guidelines Checklist */}
            <div className="mx-auto max-w-sm rounded-xl border border-border bg-muted/30 p-3 text-left space-y-1.5 text-xs text-foreground/80">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <CheckCircle2 className="size-3.5 text-brand-teal" />
                <span>Face centered with good lighting</span>
              </div>
              <div className="flex items-center gap-2 font-medium text-foreground">
                <CheckCircle2 className="size-3.5 text-brand-teal" />
                <span>Plain background, no sunglasses or hats</span>
              </div>
            </div>

            <input
              accept="image/*"
              className="hidden"
              onChange={handlePhotoPicked}
              ref={photoInputRef}
              type="file"
            />

            <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
              <button
                className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand-teal px-5 text-xs font-semibold text-white shadow-lg transition hover:brightness-110 disabled:opacity-60"
                disabled={uploadingPhoto}
                onClick={() =>
                  setCameraModal({
                    aspectRatio: 1,
                    facingMode: "user",
                    target: "photo",
                    title: "Take photo for ID card",
                  })
                }
                type="button"
              >
                <Camera className="size-4" />
                Take Photo with Camera
              </button>

              <button
                className="inline-flex h-11 items-center gap-2 rounded-xl border border-border bg-surface px-5 text-xs font-semibold text-foreground transition hover:bg-muted disabled:opacity-60"
                disabled={uploadingPhoto}
                onClick={() => photoInputRef.current?.click()}
                type="button"
              >
                <Upload className="size-4" />
                {photoPreview ? "Upload Different File" : "Upload Photo File"}
              </button>
            </div>
          </div>
        )}

        {stepKey === "signature" && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 p-3">
              <StepArt step={stepKey}><PenTool className="size-5" /></StepArt>
              <div>
                <h4 className="text-sm font-semibold text-foreground">Official Card Signature</h4>
                <p className="text-xs text-muted-foreground">Draw on screen or photograph your signature on white paper.</p>
              </div>
            </div>

            <div className="flex rounded-xl border border-border bg-muted p-1">
              <button
                className={cn(
                  "flex-1 rounded-lg py-2.5 text-xs font-semibold transition",
                  signatureMode === "draw"
                    ? "bg-surface text-brand-teal shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setSignatureMode("draw")}
                type="button"
              >
                <PenTool className="inline-block size-3.5 mr-1.5" />
                Draw Signature
              </button>
              <button
                className={cn(
                  "flex-1 rounded-lg py-2.5 text-xs font-semibold transition",
                  signatureMode === "photo"
                    ? "bg-surface text-brand-teal shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setSignatureMode("photo")}
                type="button"
              >
                <Camera className="inline-block size-3.5 mr-1.5" />
                Photograph on Paper
              </button>
            </div>

            {signatureMode === "draw" ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-foreground flex items-center justify-between">
                  <span>Draw your signature inside the grid box:</span>
                  {draft.signature ? <span className="text-brand-teal font-semibold">Signature captured ✓</span> : null}
                </p>
                <SignaturePad
                  onChange={(val) => {
                    updateField("signature", val);
                    updateField("signatureImageUri", "");
                    setSignatureAssetId(null);
                    setSignaturePreview(null);
                  }}
                  value={draft.signature}
                />
              </div>
            ) : (
              <div className="space-y-4 text-center">
                <div className="mx-auto flex h-32 w-80 max-w-full items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-border bg-background p-3 shadow-inner">
                  {signaturePreview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img alt="Signature" className="max-h-full object-contain" src={signaturePreview} />
                  ) : (
                    <div className="flex flex-col items-center gap-1.5 text-muted-foreground">
                      <Camera className="size-8 opacity-40" />
                      <p className="text-xs font-semibold">Photograph signature on clean white paper</p>
                    </div>
                  )}
                </div>

                <input
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.currentTarget.files?.[0];
                    e.currentTarget.value = "";
                    if (f) void handleCroppedSignature(f);
                  }}
                  ref={signatureInputRef}
                  type="file"
                />

                <div className="flex flex-wrap items-center justify-center gap-3">
                  <button
                    className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-teal px-4 text-xs font-medium text-white shadow transition hover:brightness-110 disabled:opacity-60"
                    disabled={uploadingSignature}
                    onClick={() =>
                      setCameraModal({
                        aspectRatio: 3,
                        facingMode: "environment",
                        target: "signature",
                        title: "Photograph signature on paper",
                      })
                    }
                    type="button"
                  >
                    <Camera className="size-4" />
                    Photograph Signature
                  </button>

                  <button
                    className="inline-flex h-10 items-center gap-2 rounded-xl border border-border px-4 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-60"
                    disabled={uploadingSignature}
                    onClick={() => signatureInputRef.current?.click()}
                    type="button"
                  >
                    <Upload className="size-4" />
                    Upload Image File
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {stepKey === "review" && (
          <div className="space-y-5">
            {/* Top Verification Status Banner */}
            <div className="rounded-2xl border border-brand-teal/20 bg-gradient-to-br from-brand-teal/5 via-background to-brand-teal/10 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <StepArt step={stepKey}><ShieldCheck className="size-5" /></StepArt>
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">KYC Verification Summary</h4>
                    <p className="text-xs text-muted-foreground">Review documents and profile accuracy before saving</p>
                  </div>
                </div>
                <span
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-semibold",
                    hasPhotoAsset && (hasSignatureAsset || Boolean(draft.signatureImageUri.trim()) || isSignatureComplete(draft.signature))
                      ? "bg-brand-teal/15 text-brand-teal"
                      : "bg-warning/15 text-warning",
                  )}
                >
                  {hasPhotoAsset && (hasSignatureAsset || Boolean(draft.signatureImageUri.trim()) || isSignatureComplete(draft.signature))
                    ? "Ready to Issue ✓"
                    : "Action Needed"}
                </span>
              </div>

              <div className="grid gap-2 sm:grid-cols-3 pt-1">
                <div className="flex items-center gap-2 rounded-xl border border-brand-teal/30 bg-brand-teal/10 p-2.5 text-xs font-semibold text-brand-teal">
                  <CheckCircle2 className="size-4 shrink-0" />
                  <span>1. Details & Contact Verified</span>
                </div>
                <div className={cn("flex items-center gap-2 rounded-xl border p-2.5 text-xs font-semibold transition", hasPhotoAsset ? "border-brand-teal/30 bg-brand-teal/10 text-brand-teal" : "border-warning/40 bg-warning/10 text-warning")}>
                  <Camera className="size-4 shrink-0" />
                  <span>2. Photo ({hasPhotoAsset ? "Attached ✓" : "Missing"})</span>
                </div>
                <div className={cn("flex items-center gap-2 rounded-xl border p-2.5 text-xs font-semibold transition", hasSignatureAsset || Boolean(draft.signatureImageUri.trim()) || isSignatureComplete(draft.signature) ? "border-brand-teal/30 bg-brand-teal/10 text-brand-teal" : "border-warning/40 bg-warning/10 text-warning")}>
                  <PenTool className="size-4 shrink-0" />
                  <span>3. Signature ({hasSignatureAsset || Boolean(draft.signatureImageUri.trim()) || isSignatureComplete(draft.signature) ? "Signed ✓" : "Missing"})</span>
                </div>
              </div>
            </div>

            {(!hasPhotoAsset ||
              (!hasSignatureAsset &&
                !draft.signatureImageUri.trim() &&
                !isSignatureComplete(draft.signature))) && (
              <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3.5 text-xs font-medium text-warning">
                <AlertCircle className="size-5 shrink-0" />
                <div>
                  <p>Some details need fixing before creating your ID card.</p>
                  <button
                    className="mt-1 underline font-semibold"
                    onClick={() => {
                      const firstBad = firstIncompleteIdentityStep(draft, {
                        hasPhoto: hasPhotoAsset,
                        hasSignatureImage: hasSignatureAsset,
                      });
                      if (firstBad) setStepKey(firstBad);
                    }}
                    type="button"
                  >
                    Go to incomplete step →
                  </button>
                </div>
              </div>
            )}

            {/* Fact Cards */}
            <div className="grid gap-3.5 sm:grid-cols-2">
              <ReviewFactCard
                title="About you"
                onEdit={() => setStepKey("about")}
                rows={[
                  ["Full Name", draft.fullName || identity.accountName],
                  ["Date of Birth", draft.dateOfBirth || "—"],
                  ["Gender", draft.gender || "—"],
                  ["Blood Group", draft.bloodGroup || "—"],
                ]}
              />

              <ReviewFactCard
                title="Contact"
                onEdit={() => setStepKey("contact")}
                rows={[
                  ["Phone", draft.primaryPhone || "—"],
                  ["Alternate", draft.alternatePhone || "—"],
                  ["Account Email", email || "—"],
                  ["Backup Email", draft.backupEmail || "—"],
                ]}
              />

              <ReviewFactCard
                title="Address"
                onEdit={() => setStepKey("address")}
                rows={[
                  ["Permanent Address", draft.permanentAddress || "—"],
                  ["City", draft.city || "—"],
                  ["Province", draft.province || "—"],
                ]}
              />

              <ReviewFactCard
                title="Study or work"
                onEdit={() => setStepKey("work")}
                rows={[
                  ["Occupation", draft.occupation || "—"],
                  ["College / Company", draft.institution || "—"],
                  ["Course / Title", draft.courseOrDesignation || "—"],
                ]}
              />

              <ReviewFactCard
                title="Guardian & Emergency"
                onEdit={() => setStepKey("guardian")}
                rows={[
                  ["Guardian", `${draft.guardianName} (${draft.guardianRelation || "—"})`],
                  ["Phone", draft.guardianPhone || "—"],
                  ["Emergency Contact", draft.emergencyContactName ? `${draft.emergencyContactName} (${draft.emergencyContactPhone})` : "Guardian"],
                ]}
              />

              <ReviewFactCard
                title="Preferences & ID"
                onEdit={() => setStepKey("preferences")}
                rows={[
                  ["Food Preference", draft.dietaryPreference || "—"],
                  ["Budget", draft.budgetRange || "—"],
                  ["Govt ID", draft.governmentIdType ? `${draft.governmentIdType}: ${draft.governmentIdNumber}` : "—"],
                ]}
              />

              <ReviewAssetCard onEdit={() => setStepKey("photo")} title="Photo">
                {photoPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    alt="Your card photo"
                    className="h-40 w-32 rounded-lg border border-border object-cover"
                    src={photoPreview}
                  />
                ) : null}
              </ReviewAssetCard>

              <ReviewAssetCard onEdit={() => setStepKey("signature")} title="Signature">
                {signatureMode === "draw" && isSignatureComplete(draft.signature) ? (
                  <svg
                    aria-label="Your signature"
                    className="h-24 w-full max-w-72 rounded-lg border border-border bg-white text-slate-900"
                    role="img"
                    viewBox={`0 0 ${SIGNATURE_WIDTH} ${SIGNATURE_HEIGHT}`}
                  >
                    <path
                      d={draft.signature}
                      fill="none"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={5}
                    />
                  </svg>
                ) : signaturePreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    alt="Your signature"
                    className="h-24 w-full max-w-72 rounded-lg border border-border bg-white object-contain p-2"
                    src={signaturePreview}
                  />
                ) : null}
              </ReviewAssetCard>
            </div>

            {isFirstSave ? (
              <label className="flex items-start gap-2.5 rounded-xl border border-border bg-muted/20 p-3.5">
                <input
                  checked={agreed}
                  className="mt-0.5 size-4 cursor-pointer rounded border-border accent-brand-teal"
                  onChange={(e) => setAgreed(e.target.checked)}
                  type="checkbox"
                />
                <span className="text-xs font-medium leading-relaxed text-foreground">
                  By creating your resident ID you agree to our{" "}
                  <Link className="text-brand-teal hover:underline" href="/terms" target="_blank">
                    Terms
                  </Link>{" "}
                  and{" "}
                  <Link className="text-brand-teal hover:underline" href="/privacy" target="_blank">
                    Privacy Policy
                  </Link>
                  .
                </span>
              </label>
            ) : null}

            <label className="flex items-start gap-2.5 rounded-xl border border-border bg-muted/20 p-3.5">
              <input
                className="mt-0.5 size-4 cursor-pointer rounded border-border"
                checked={sharingEnabled}
                onChange={(e) => setSharingEnabled(e.target.checked)}
                type="checkbox"
              />
              <span className="text-xs leading-relaxed text-foreground font-medium">
                Let a hostel load these details when I show them my QR code or give them my
                resident ID. You can turn this off later.
              </span>
            </label>
          </div>
        )}
        </div>

        {/* Footer controls */}
        <div className="flex items-center justify-between border-t border-border pt-4">
          <div>
            {stepIndex > 0 && (
              <button
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2.5 text-xs font-medium text-foreground transition hover:bg-muted"
                onClick={handleBack}
                type="button"
              >
                <ChevronLeft className="size-4" />
                Back
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {stepKey === "work" && (
              <button
                className="inline-flex items-center justify-center rounded-lg border border-border px-4 py-2.5 text-xs font-medium text-foreground transition hover:bg-muted"
                onClick={handleSkip}
                type="button"
              >
                Skip
              </button>
            )}

            {stepKey !== "review" ? (
              <button
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-teal px-5 py-2.5 text-xs font-medium text-white shadow transition hover:brightness-110"
                onClick={handleNext}
                type="button"
              >
                Continue
                <ChevronRight className="size-4" />
              </button>
            ) : (
              <button
                // Looks off until the terms are ticked, but still answers a click with why — as the app does.
                className={cn(
                  "inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-brand-teal px-6 text-sm font-medium text-white shadow transition hover:brightness-110 disabled:opacity-60",
                  isFirstSave && !agreed && "opacity-50 hover:brightness-100",
                )}
                disabled={saving}
                onClick={() => {
                  if (isFirstSave && !agreed) {
                    toast.error({
                      description: "Tick the Terms and Privacy Policy box above.",
                      title: "Agree to the terms first",
                    });
                    return;
                  }
                  void handleSubmit();
                }}
                type="button"
              >
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {saving ? "Saving…" : "Save my details"}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** A review card that shows the uploaded image itself rather than a "Provided ✓" line. */
function ReviewAssetCard({
  children,
  onEdit,
  title,
}: {
  children: ReactNode;
  onEdit: () => void;
  title: string;
}) {
  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface p-3.5 shadow-sm">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-foreground">{title}</h4>
        <button
          className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-teal hover:underline"
          onClick={onEdit}
          type="button"
        >
          <Edit2 className="size-3" />
          Edit
        </button>
      </div>
      {children ?? (
        <p className="text-xs font-medium text-destructive">Missing — add it before saving.</p>
      )}
    </div>
  );
}

function ReviewFactCard({
  onEdit,
  rows,
  title,
}: {
  onEdit: () => void;
  rows: [string, string][];
  title: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3.5 shadow-sm space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-foreground">
          {title}
        </h4>
        <button
          className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-teal hover:underline"
          onClick={onEdit}
          type="button"
        >
          <Edit2 className="size-3" />
          Edit
        </button>
      </div>
      <div className="space-y-1 text-xs">
        {rows.map(([label, val]) => (
          <div className="flex justify-between gap-2" key={label}>
            <span className="text-muted-foreground font-semibold">{label}:</span>
            <span className="font-medium text-foreground truncate">{val}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── The ID card modal ── */

const OCCUPATION_LABELS: Record<string, string> = {
  OTHER: "Resident",
  STUDENT: "Student",
  WORKING_PROFESSIONAL: "Working professional",
};

function formatCardDate(value?: string | null) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
}

/**
 * The card's field mapping, shared by the modal and the in-portal preview so
 * the two can never drift into printing different cards for the same person.
 */
function buildIdCardData(
  identity: ResidentIdentity,
  profile: ResidentProfile | null,
  images: {
    photo: HTMLImageElement | null;
    qr: HTMLImageElement | null;
    signatureImage?: HTMLImageElement | null;
  },
  brandName: string,
): IdCardData {
  return {
    brandName,
    cardType: identity.cardType ?? "RESIDENT",
    // "UNKNOWN" is the schema's placeholder, not something to print on a card
    // that a paramedic might read.
    bloodGroup:
      profile?.bloodGroup && profile.bloodGroup !== "UNKNOWN" ? profile.bloodGroup : null,
    dateOfBirth: formatCardDate(profile?.dateOfBirth),
    email: identity.accountEmail ?? profile?.primaryEmail,
    fullName: profile?.fullName ?? identity.accountName,
    issuedOn: formatCardDate(identity.updatedAt ?? new Date().toISOString()),
    phone: profile?.primaryPhone,
    photo: images.photo,
    qr: images.qr,
    residentId: identity.residentId ?? "—",
    signature: profile?.signature ?? null,
    signatureImage: images.signatureImage ?? null,
    // An approved provider's trade (or "Hostel Owner") outranks the resident
    // profile's course/occupation — it is what the card is now for.
    role:
      identity.cardRole ||
      profile?.courseOrDesignation ||
      profile?.institution ||
      OCCUPATION_LABELS[profile?.occupation ?? ""] ||
      "Resident",
    siteLabel: typeof window === "undefined" ? "" : window.location.host,
  };
}

/** Same-origin URL of the stored photo, cache-busted by its last write. */
function identityPhotoUrl(identity: ResidentIdentity) {
  return identity.hasPhoto
    ? `/api/v1/users/resident-identity/photo?v=${encodeURIComponent(
        identity.photoUpdatedAt ?? "1",
      )}`
    : null;
}

/** Same-origin URL of the stored signature image, cache-busted by its last write. */
function identitySignatureUrl(identity: ResidentIdentity) {
  return identity.hasSignatureImage
    ? `/api/v1/users/resident-identity/signature?v=${encodeURIComponent(
        identity.signatureUpdatedAt ?? "1",
      )}`
    : null;
}

function IdCardPanel({
  identity,
  onClose,
  onEdit,
  onIdentityChange,
  onSharingChange,
  profile,
}: {
  identity: ResidentIdentity;
  onClose: () => void;
  onEdit: () => void;
  onIdentityChange: (next: IdentityResponse) => void;
  onSharingChange: (enabled: boolean) => void;
  profile: ResidentProfile | null;
}) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [images, setImages] = useState<{
    photo: HTMLImageElement | null;
    qr: HTMLImageElement | null;
    signatureImage?: HTMLImageElement | null;
  }>({ photo: null, qr: null });
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [togglingShare, setTogglingShare] = useState(false);
  const [savingPhoto, setSavingPhoto] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [face, setFace] = useState<"back" | "front">("front");
  const [paused, setPaused] = useState(false);

  const frontRef = useRef<HTMLCanvasElement>(null);
  const backRef = useRef<HTMLCanvasElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  /*
   * The just-cropped bitmap, kept so the card can repaint the instant the user
   * confirms the crop rather than waiting on the upload plus a round trip. It
   * also covers the server copy: if the proxy read fails, the card keeps showing
   * the photo the user actually chose instead of dropping back to initials.
   */
  const localPhotoRef = useRef<HTMLImageElement | null>(null);

  /*
   * The imperative uploader, not the useUploader hook: this field keeps no file
   * list of its own (the photo lives on the profile), and the hook's one-file
   * cap would reject every photo after the first. Progress still renders in the
   * global toaster either way.
   */
  async function uploadPhoto(file: File) {
    // PRIVATE: a resident's face is personal data, so the bytes stay behind the
    // authenticated proxy rather than sitting on a public bucket URL.
    return uploadFile(file, {
      accessLevel: "PRIVATE",
      kind: "image",
      label: "ID card photo",
      silent: true,
      target: "asset",
    });
  }

  const photoUrl = identityPhotoUrl(identity);
  const signatureUrl = identitySignatureUrl(identity);

  useEffect(() => {
    let active = true;

    async function loadQr() {
      try {
        const data = await browserApi<{ qrDataUrl: string | null }>(
          "/api/v1/users/resident-identity/qr",
        );

        if (active) {
          setQrDataUrl(data.qrDataUrl);
        }
      } catch (loadError) {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Could not build your QR code.",
          );
        }
      }
    }

    void loadQr();

    return () => {
      active = false;
    };
  }, []);

  // Both bitmaps have to be decoded, and the webfonts loaded, before the first
  // paint — otherwise the card renders once in a fallback face and again in the
  // real one, which reads as a flicker.
  useEffect(() => {
    let active = true;

    async function loadImages() {
      const [photo, qr, signatureImage] = await Promise.all([
        loadCardImage(photoUrl),
        loadCardImage(qrDataUrl),
        loadCardImage(signatureUrl),
      ]);

      await document.fonts?.ready?.catch?.(() => undefined);

      if (!active) {
        return;
      }

      // A saved photo that will not load is a real fault, not a styling detail —
      // say so instead of quietly rendering initials.
      if (photoUrl && !photo && !localPhotoRef.current) {
        setError("Your saved photo could not be loaded. Try uploading it again.");
      }

      setImages({ photo: photo ?? localPhotoRef.current, qr, signatureImage });
    }

    void loadImages();

    return () => {
      active = false;
    };
  }, [photoUrl, qrDataUrl, signatureUrl]);

  const siteName = useSiteConfig().identity.siteName;
  const cardData = useMemo<IdCardData>(
    () => buildIdCardData(identity, profile, images, siteName),
    [identity, images, profile, siteName],
  );

  useEffect(() => {
    if (frontRef.current) {
      paintIdCard(frontRef.current, cardData, "front");
    }

    if (backRef.current) {
      paintIdCard(backRef.current, cardData, "back");
    }
  }, [cardData]);

  /*
   * The card shows itself off on its own: front for 5s, back for 3s, repeat.
   * Tapping the flip button restarts the cycle from whichever face was chosen,
   * and hovering pauses it so nobody has the back pulled away mid-read.
   */
  useEffect(() => {
    if (paused) {
      return;
    }

    const timer = window.setTimeout(
      () => setFace((current) => (current === "front" ? "back" : "front")),
      face === "front" ? 5000 : 3000,
    );

    return () => window.clearTimeout(timer);
  }, [face, paused]);

  /** Picking a file only opens the cropper — nothing uploads until it is framed. */
  function handlePhotoChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Cleared straight away so re-picking the same file still fires a change.
    input.value = "";

    if (file) {
      setError("");
      setPendingFile(file);
    }
  }

  async function handleCropped(cropped: File) {
    setPendingFile(null);
    setError("");
    setSavingPhoto(true);

    // Paint it first, upload second: the card updates the moment the crop is
    // confirmed, so the upload never looks like it did nothing.
    const preview = await loadCardImage(URL.createObjectURL(cropped));

    if (preview) {
      localPhotoRef.current = preview;
      setImages((current) => ({ ...current, photo: preview }));
    }

    try {
      const uploaded = await uploadPhoto(cropped);

      // A rejected file already surfaced through the global toaster.
      if (!uploaded?.assetId) {
        setError("That photo could not be uploaded. Please try another one.");
        return;
      }

      onIdentityChange(
        await browserApi<IdentityResponse>("/api/v1/users/resident-identity/photo", {
          body: JSON.stringify({ photoAssetId: uploaded.assetId }),
          method: "PUT",
        }),
      );
    } catch (photoError) {
      setError(
        photoError instanceof Error
          ? photoError.message
          : "Could not add that photo to your card.",
      );
    } finally {
      setSavingPhoto(false);
    }
  }

  async function handleRemovePhoto() {
    setError("");
    setSavingPhoto(true);
    localPhotoRef.current = null;
    setImages((current) => ({ ...current, photo: null }));

    try {
      onIdentityChange(
        await browserApi<IdentityResponse>("/api/v1/users/resident-identity/photo", {
          method: "DELETE",
        }),
      );
    } catch (removeError) {
      setError(
        removeError instanceof Error
          ? removeError.message
          : "Could not remove your photo.",
      );
    } finally {
      setSavingPhoto(false);
    }
  }

  async function handleDownload() {
    setError("");
    setDownloading(true);

    try {
      const blob = await renderIdCardSheet(cardData);

      if (!blob) {
        setError("Could not build the image. Please try again.");
        return;
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.download = `hostelpalika-id-card-${identity.residentId ?? "card"}.png`;
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Could not download the card on this browser.");
    } finally {
      setDownloading(false);
    }
  }

  async function handleCopy() {
    if (!identity.residentId) {
      return;
    }

    try {
      await navigator.clipboard.writeText(identity.residentId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy — select the ID and copy it manually.");
    }
  }

  async function handleToggleSharing() {
    setTogglingShare(true);

    try {
      const next = await browserApi<IdentityResponse>("/api/v1/users/resident-identity", {
        body: JSON.stringify({ sharingEnabled: !identity.sharingEnabled }),
        method: "PATCH",
      });

      onSharingChange(next.identity.sharingEnabled);
    } catch (toggleError) {
      setError(
        toggleError instanceof Error ? toggleError.message : "Could not change sharing.",
      );
    } finally {
      setTogglingShare(false);
    }
  }

  return (
    <Modal
      onClose={onClose}
      subtitle={
        cardData.cardType === "RESIDENT"
          ? "Show this to a hostel and they can fill your registration without asking you to write anything down."
          : "Show this at a hostel to confirm who you are. Your ID stays the same as before."
      }
      title={`My ${idCardNoun(cardData.cardType)} ID card`}
    >
      {pendingFile ? (
        <PhotoCropper
          file={pendingFile}
          onCancel={() => setPendingFile(null)}
          onCropped={handleCropped}
        />
      ) : null}

      <div className="space-y-5">
        {error ? (
          <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs font-semibold text-destructive">
            {error}
          </div>
        ) : null}

        <div className="mx-auto w-full max-w-[300px] space-y-3">
          <div
            className="[perspective:1600px]"
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
          >
            <div
              className={cn(
                "relative aspect-[640/1000] w-full transition-transform duration-700 ease-[cubic-bezier(0.4,0,0.2,1)] [transform-style:preserve-3d]",
                face === "back" && "[transform:rotateY(180deg)]",
              )}
            >
              <canvas
                aria-label={`Front of your ${siteName} ${idCardNoun(cardData?.cardType)} ID card`}
                className="absolute inset-0 size-full rounded-2xl shadow-lg [backface-visibility:hidden]"
                ref={frontRef}
                role="img"
              />
              <canvas
                aria-label={`Back of your ${siteName} ${idCardNoun(cardData?.cardType)} ID card`}
                className="absolute inset-0 size-full rounded-2xl shadow-lg [backface-visibility:hidden] [transform:rotateY(180deg)]"
                ref={backRef}
                role="img"
              />
            </div>
          </div>

          <button
            className="mx-auto flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-bold text-foreground transition hover:bg-muted"
            onClick={() => setFace(face === "front" ? "back" : "front")}
            type="button"
          >
            <RotateCw className="size-3.5" />
            {face === "front" ? "Show back" : "Show front"}
          </button>
        </div>

        <div className="divide-y divide-border rounded-xl border border-border">
          <div className="flex items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-foreground">Photo</p>
              <p className="mt-0.5 truncate text-xs text-foreground/70">
                {identity.hasPhoto
                  ? "On your card and your account picture."
                  : uploadHint("image")}
              </p>
            </div>
            <input
              accept={acceptAttribute("image")}
              className="hidden"
              onChange={handlePhotoChange}
              ref={photoInputRef}
              type="file"
            />
            <button
              aria-label={identity.hasPhoto ? "Change photo" : "Add photo"}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-bold text-brand-teal transition hover:bg-muted disabled:opacity-60"
              disabled={savingPhoto}
              onClick={() => photoInputRef.current?.click()}
              type="button"
            >
              {savingPhoto ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Camera className="size-3.5" />
              )}
              {identity.hasPhoto ? "Change" : "Add"}
            </button>
            {identity.hasPhoto ? (
              <button
                aria-label="Remove photo"
                className="rounded-lg p-1.5 text-foreground/70 transition hover:bg-muted hover:text-destructive disabled:opacity-60"
                disabled={savingPhoto}
                onClick={handleRemovePhoto}
                type="button"
              >
                <Trash2 className="size-3.5" />
              </button>
            ) : null}
          </div>

          <div className="flex items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-foreground">Resident ID</p>
              <p className="mt-0.5 select-all font-mono text-sm font-extrabold tracking-widest text-brand-teal">
                {identity.residentId}
              </p>
            </div>
            <button
              aria-label="Copy resident ID"
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-bold text-foreground transition hover:bg-muted"
              onClick={handleCopy}
              type="button"
            >
              {copied ? (
                <Check className="size-3.5 text-success" />
              ) : (
                <Copy className="size-3.5" />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          <div className="flex items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-foreground">Sharing</p>
              <p className="mt-0.5 text-xs text-foreground/70">
                {identity.sharingEnabled
                  ? "Hostels can load your details with this ID."
                  : "Turned off — the ID will not open your details."}
                {identity.shareCount > 0
                  ? ` Used ${identity.shareCount} ${
                      identity.shareCount === 1 ? "time" : "times"
                    }${
                      identity.lastSharedAt
                        ? `, last on ${new Date(identity.lastSharedAt).toLocaleDateString()}`
                        : ""
                    }.`
                  : ""}
              </p>
            </div>
            <button
              className={cn(
                "relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-60",
                identity.sharingEnabled ? "bg-brand-teal" : "bg-muted-foreground/35",
              )}
              disabled={togglingShare}
              onClick={handleToggleSharing}
              role="switch"
              aria-checked={identity.sharingEnabled}
              type="button"
            >
              <span
                className={cn(
                  "absolute top-0.5 size-5 rounded-full bg-white shadow transition-all",
                  identity.sharingEnabled ? "left-[22px]" : "left-0.5",
                )}
              />
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <button
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-brand-teal text-sm font-bold text-white shadow-sm transition hover:brightness-110 disabled:opacity-60"
            disabled={downloading}
            onClick={handleDownload}
            type="button"
          >
            {downloading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            {downloading ? "Preparing…" : "Download card"}
          </button>
          <button
            className="inline-flex h-11 items-center justify-center rounded-lg border border-brand-teal px-5 text-sm font-bold text-brand-teal transition hover:bg-brand-teal/5 sm:flex-none"
            onClick={onEdit}
            type="button"
          >
            Edit my details
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ── Host component: mount once per shell ── */

function SignInPrompt({ onClose }: { onClose: () => void }) {
  const next =
    typeof window === "undefined"
      ? "/"
      : `${window.location.pathname}${window.location.search}`;

  return (
    <Modal
      onClose={onClose}
      subtitle="Sign in first and we will keep your details encrypted against your account, so no hostel ever asks you to fill this form again."
      title="Save your details once"
    >
      <div className="space-y-3">
        <Link
          className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-brand-teal text-sm font-bold text-white shadow-sm transition hover:brightness-110"
          href={`/login?next=${encodeURIComponent(next)}`}
        >
          Sign in
        </Link>
        <Link
          className="inline-flex h-11 w-full items-center justify-center rounded-lg border border-border text-sm font-bold text-foreground transition hover:bg-muted"
          href={`/signup?next=${encodeURIComponent(next)}`}
        >
          Create an account
        </Link>
        <button
          className="w-full py-2 text-sm font-bold text-foreground transition hover:underline"
          onClick={() => {
            snoozePrompt();
            onClose();
          }}
          type="button"
        >
          Not now
        </button>
      </div>
    </Modal>
  );
}

/**
 * Renders the resident-identity modals and listens for open requests. Mount it
 * once, unconditionally, inside a shell present on every page (the public
 * header and the portal account menu both do).
 *
 * It determines sign-in state itself on first open, so it must NOT be gated on
 * the host's session check — doing so meant the modal silently failed to open
 * whenever that check was slow or had failed.
 */
export function ResidentIdentityCenter({
  onProfileSaved,
}: {
  /** Lets the host refresh its own copy of the user once an ID is minted. */
  onProfileSaved?: () => void;
}) {
  const [view, setView] = useState<"closed" | "loading" | "qr" | "form" | "intro" | "signin">(
    "closed",
  );
  const [reason, setReason] = useState<ProfilePromptReason>("MANUAL");
  const [data, setData] = useState<IdentityResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const loadedRef = useRef(false);
  // Mirrors `data` so the loader can read it without taking a dependency on
  // state — the listener effect must not re-register on every fetch.
  const dataRef = useRef<IdentityResponse | null>(null);

  /*
   * Auth is decided here, from this endpoint's own answer, rather than trusted
   * from a prop. The host's session check can still be in flight (or have
   * failed) when the user taps, and gating on it used to mean the modal simply
   * never opened.
   *
   * Deliberately not `browserApi`: that redirects to /login on an unrecoverable
   * 401, which would throw a browsing visitor off the page just for opening the
   * QR modal. A 401 here is an expected answer — "sign in first" — not a fault.
   */
  const loadIdentity = useCallback(async (): Promise<
    | { data: IdentityResponse; status: "ok" }
    | { status: "error" }
    | { status: "unauthenticated" }
  > => {
    if (loadedRef.current && dataRef.current) {
      return { data: dataRef.current, status: "ok" };
    }

    setLoading(true);

    try {
      let response = await fetch("/api/v1/users/resident-identity", {
        credentials: "same-origin",
      });

      // An expired access token is recoverable; a missing session is not.
      if (response.status === 401 && (await refreshSession())) {
        response = await fetch("/api/v1/users/resident-identity", {
          credentials: "same-origin",
        });
      }

      if (response.status === 401) {
        return { status: "unauthenticated" };
      }

      const payload = (await response.json().catch(() => null)) as {
        data: IdentityResponse;
        success: true;
      } | null;

      if (!response.ok || !payload?.success) {
        return { status: "error" };
      }

      loadedRef.current = true;
      dataRef.current = payload.data;
      setData(payload.data);

      return { data: payload.data, status: "ok" };
    } catch {
      return { status: "error" };
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    async function openQr() {
      setView("loading");

      const result = await loadIdentity();

      if (result.status !== "ok") {
        setView(result.status === "unauthenticated" ? "signin" : "closed");
        return;
      }

      setReason("MANUAL");
      // No profile yet, so there is nothing behind the QR — collect it first.
      setView(result.data.identity.hasProfile ? "qr" : "form");
    }

    async function openForm(event: Event) {
      const detail = (event as CustomEvent<{ reason?: ProfilePromptReason }>).detail;
      const requestedReason = detail?.reason ?? "MANUAL";

      setView("loading");

      const result = await loadIdentity();

      if (result.status !== "ok") {
        setView(result.status === "unauthenticated" ? "signin" : "closed");
        return;
      }

      // Never nag someone who already finished it via an automatic trigger.
      if (result.data.identity.hasProfile && requestedReason !== "MANUAL") {
        setView("closed");
        return;
      }

      setReason(requestedReason);
      // Automatic triggers ask first; only a tap goes straight into the form.
      setView(requestedReason === "MANUAL" ? "form" : "intro");
    }

    (window as unknown as Record<string, unknown>).__hhIdentityListenerAttached = true;
    window.addEventListener(QR_EVENT, openQr);
    window.addEventListener(FORM_EVENT, openForm);

    return () => {
      window.removeEventListener(QR_EVENT, openQr);
      window.removeEventListener(FORM_EVENT, openForm);
    };
  }, [loadIdentity]);

  const close = useCallback(() => {
    setView("closed");
    setSaved(false);
  }, []);

  if (view === "closed") {
    return null;
  }

  if (view === "signin") {
    return <SignInPrompt onClose={close} />;
  }

  if (view === "loading" || loading || !data) {
    return (
      <Modal onClose={close} title="Loading your details">
        <div className="flex items-center justify-center py-10 text-foreground">
          <Loader2 className="size-6 animate-spin" />
        </div>
      </Modal>
    );
  }

  if (view === "intro") {
    return (
      <Modal
        onClose={() => {
          snoozePrompt();
          close();
        }}
        subtitle="Save your details once and every hostel you apply to can fill their form by scanning your code."
        title="Get your resident ID"
      >
        <div className="space-y-3">
          <button
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand-teal text-sm font-bold text-white shadow-sm transition hover:brightness-110"
            onClick={() => setView("form")}
            type="button"
          >
            <QrCode className="size-4" />
            Set up my ID
          </button>
          <button
            className="w-full py-2 text-sm font-bold text-foreground transition hover:underline"
            onClick={() => {
              snoozePrompt();
              close();
            }}
            type="button"
          >
            Not now
          </button>
        </div>
      </Modal>
    );
  }

  if (view === "form") {
    if (saved) {
      return (
        <Modal
          onClose={close}
          subtitle="From now on, any hostel can register you by scanning your code or typing your resident ID."
          title="Your resident ID is ready"
        >
          <div className="space-y-4 text-center">
            <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-brand-teal-soft text-brand-teal">
              <Check className="size-7" />
            </div>
            <p className="select-all font-mono text-2xl font-extrabold tracking-widest text-brand-teal">
              {data.identity.residentId}
            </p>
            <button
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand-teal text-sm font-bold text-white transition hover:brightness-110"
              onClick={() => {
                setSaved(false);
                setView("qr");
              }}
              type="button"
            >
              <QrCode className="size-4" />
              Open my ID card
            </button>
          </div>
        </Modal>
      );
    }

    return (
      <ProfileForm
        identity={data.identity}
        onClose={close}
        onSaved={(next) => {
          dataRef.current = next;
          setData(next);
          setSaved(true);
          broadcastIdentityChange();
          onProfileSaved?.();
        }}
        profile={data.profile}
        reason={reason}
      />
    );
  }

  return (
    <IdCardPanel
      identity={data.identity}
      onClose={close}
      onEdit={() => {
        setReason("MANUAL");
        setView("form");
      }}
      onIdentityChange={(next) => {
        dataRef.current = next;
        setData(next);
        broadcastIdentityChange();
      }}
      profile={data.profile}
      onSharingChange={(enabled) => {
        setData((current) =>
          current
            ? { ...current, identity: { ...current.identity, sharingEnabled: enabled } }
            : current,
        );
        broadcastIdentityChange();
      }}
    />
  );
}

/**
 * The ID card, embedded in a portal page rather than shown in the modal.
 *
 * Read-only on purpose: photo, sharing and profile edits all stay in the one
 * place that owns them (the modal, reachable from "Manage card" below), so the
 * identity keeps a single write path no matter which surface you came in
 * through. This view only ever draws what the modal draws — same
 * `buildIdCardData`, same canvas renderer.
 */
export function ResidentIdCard() {
  const [data, setData] = useState<IdentityResponse | null>(null);
  const [images, setImages] = useState<{
    photo: HTMLImageElement | null;
    qr: HTMLImageElement | null;
    signatureImage?: HTMLImageElement | null;
  }>({ photo: null, qr: null });
  const [state, setState] = useState<"error" | "loading" | "ready">("loading");
  const [face, setFace] = useState<"back" | "front">("front");
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const frontRef = useRef<HTMLCanvasElement>(null);
  const backRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let active = true;

    async function loadIdentity() {
      try {
        const next = await browserApi<IdentityResponse>(
          "/api/v1/users/resident-identity",
        );

        if (active) {
          setData(next);
          setState("ready");
        }
      } catch {
        if (active) {
          setState("error");
        }
      }
    }

    void loadIdentity();

    // The modal owns every write; this keeps the embedded copy in step with it.
    window.addEventListener(CHANGED_EVENT, loadIdentity);

    return () => {
      active = false;
      window.removeEventListener(CHANGED_EVENT, loadIdentity);
    };
  }, []);

  const identity = data?.identity ?? null;
  const hasCard = Boolean(identity?.hasProfile && identity.residentId);

  useEffect(() => {
    let active = true;

    async function loadImages() {
      if (!identity || !hasCard) {
        return;
      }

      const [qrPayload, photo, signatureImage] = await Promise.all([
        browserApi<{ qrDataUrl: string | null }>(
          "/api/v1/users/resident-identity/qr",
        ).catch(() => ({ qrDataUrl: null })),
        loadCardImage(identityPhotoUrl(identity)),
        loadCardImage(identitySignatureUrl(identity)),
      ]);
      const qr = await loadCardImage(qrPayload.qrDataUrl);

      // Fonts first, or the card paints once in a fallback face and again in
      // the real one — which reads as a flicker.
      await document.fonts?.ready?.catch?.(() => undefined);

      if (active) {
        setImages({ photo, qr, signatureImage });
      }
    }

    void loadImages();

    return () => {
      active = false;
    };
  }, [hasCard, identity]);

  const siteName = useSiteConfig().identity.siteName;
  const cardData = useMemo<IdCardData | null>(
    () =>
      identity && hasCard
        ? buildIdCardData(identity, data?.profile ?? null, images, siteName)
        : null,
    [data, hasCard, identity, images, siteName],
  );

  useEffect(() => {
    if (!cardData) {
      return;
    }

    if (frontRef.current) {
      paintIdCard(frontRef.current, cardData, "front");
    }

    if (backRef.current) {
      paintIdCard(backRef.current, cardData, "back");
    }
  }, [cardData]);

  async function handleCopy() {
    if (!identity?.residentId) {
      return;
    }

    try {
      await navigator.clipboard.writeText(identity.residentId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Nothing to report — the ID is selectable text beside the button.
    }
  }

  async function handleDownload() {
    if (!cardData) {
      return;
    }

    setDownloading(true);

    try {
      const blob = await renderIdCardSheet(cardData);

      if (!blob) {
        return;
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.download = `hostelpalika-id-card-${identity?.residentId ?? "card"}.png`;
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      // Downloading is a convenience; the card is still on screen either way.
    } finally {
      setDownloading(false);
    }
  }

  if (state === "loading") {
    return (
      <div className="flex items-center justify-center py-10 text-foreground/60">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  if (state === "error") {
    return (
      <p className="py-6 text-center text-sm text-foreground/70">
        Your ID card could not be loaded right now.
      </p>
    );
  }

  if (!hasCard) {
    return (
      <div className="space-y-3 py-2 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-brand-teal-soft text-brand-teal">
          <QrCode className="size-6" />
        </div>
        <p className="text-sm text-foreground/70">
          Fill in your details once and you get a resident ID card with a QR code any
          hostel can scan to register you.
        </p>
        <button
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-brand-teal px-4 text-sm font-bold text-white transition hover:brightness-110"
          onClick={() => requestResidentProfileForm("MANUAL")}
          type="button"
        >
          Create my ID card
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="mx-auto w-full max-w-[260px] space-y-3">
        <div className="[perspective:1600px]">
          <div
            className={cn(
              "relative aspect-[640/1000] w-full transition-transform duration-700 ease-[cubic-bezier(0.4,0,0.2,1)] [transform-style:preserve-3d]",
              face === "back" && "[transform:rotateY(180deg)]",
            )}
          >
            <canvas
              aria-label={`Front of your ${siteName} ${idCardNoun(cardData?.cardType)} ID card`}
              className="absolute inset-0 size-full rounded-2xl shadow-lg [backface-visibility:hidden]"
              ref={frontRef}
              role="img"
            />
            <canvas
              aria-label={`Back of your ${siteName} ${idCardNoun(cardData?.cardType)} ID card`}
              className="absolute inset-0 size-full rounded-2xl shadow-lg [backface-visibility:hidden] [transform:rotateY(180deg)]"
              ref={backRef}
              role="img"
            />
          </div>
        </div>

        <button
          className="mx-auto flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-bold text-foreground transition hover:bg-muted"
          onClick={() => setFace(face === "front" ? "back" : "front")}
          type="button"
        >
          <RotateCw className="size-3.5" />
          {face === "front" ? "Show back" : "Show front"}
        </button>
      </div>

      <div className="rounded-xl border border-border p-3">
        <p className="text-xs font-bold text-foreground">Resident ID</p>
        <div className="mt-0.5 flex items-center gap-2">
          <p className="min-w-0 flex-1 select-all font-mono text-sm font-extrabold tracking-widest text-brand-teal">
            {identity?.residentId}
          </p>
          <button
            aria-label="Copy resident ID"
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-bold text-foreground transition hover:bg-muted"
            onClick={handleCopy}
            type="button"
          >
            {copied ? (
              <Check className="size-3.5 text-success" />
            ) : (
              <Copy className="size-3.5" />
            )}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-brand-teal px-4 text-sm font-bold text-white transition hover:brightness-110"
          onClick={() => requestResidentQr()}
          type="button"
        >
          <QrCode className="size-4" />
          Manage card
        </button>
        <button
          className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-border px-4 text-sm font-bold text-foreground transition hover:bg-muted disabled:opacity-60"
          disabled={downloading}
          onClick={handleDownload}
          type="button"
        >
          {downloading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          Download
        </button>
      </div>
    </div>
  );
}
