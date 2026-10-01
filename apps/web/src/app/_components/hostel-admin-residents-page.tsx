"use client";

import {
  Download,
  FileSpreadsheet,
  Loader2,
  Lock,
  LogOut,
  MoreHorizontal,
  Plus,
  QrCode,
  ScanLine,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import {
  memo,
  useCallback,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  currency,
  EmptyState,
  Input as FormInput,
  LoadingRows,
  Select as FormSelect,
} from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/app/_components/confirm-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useAvailableRoomTypes,
  useResidentContacts,
  useResidents,
} from "@/hooks/use-hostel-admin";
import { useWorkspaceHref } from "@/hooks/use-workspace-href";
import { browserApi } from "@/lib/browser-api";
import { downloadCsv } from "@/lib/downloads/downloader";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { toast } from "@/stores/toast-store";
import { cn } from "@/lib/utils";

import {
  DemoDataBadge,
  field,
  optionalField,
  type Resident,
} from "./hostel-admin-shared";
import {
  type RegisteredInvoice,
  type RegistrationOutcome,
  ResidentRegisteredSummary,
} from "./resident-registered-summary";
import { ResidentMoveOutDialog } from "./resident-move-out-dialog";
import { JoinLinkButton, JoinRequestsPanel } from "./resident-join-panel";
import {
  DataTable,
  EmptyInline,
  InitialsAvatar,
  ListPager,
  PortalPageHeader,
  RoleButton,
  SearchField,
  SectionCard,
  SoftBadge,
  statusToneFromLabel,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./portal-dashboard-ui";

/**
 * The card photo the lookup found, ready for `/hostel-admin/resident-scan/photo`.
 *
 * Null when the holder never uploaded one, which is still most people. The
 * route streams the bytes from the private bucket under the same
 * `registerResidents` grant that loaded the profile, so an `<img src>` on it
 * authenticates on the session cookie like every other call from this page —
 * and `v=` keeps a replaced portrait from being served out of the disk cache.
 */
type PrefillPhoto = { residentId: string; updatedAt: string | null };

/**
 * Where the looked-up person already lives, if anywhere — this hostel or
 * another. The server refuses the registration either way; this is what lets
 * the form say so before anyone fills it in.
 */
type PrefillOccupancy = {
  hostelName: string;
  residentId: string | null;
  sameHostel: boolean;
};

/** Shape returned by /api/v1/hostel-admin/resident-lookup. */
type ResidentPrefill = {
  details: {
    age: number | null;
    alternatePhone: string | null;
    backupEmail: string | null;
    bloodGroup: string;
    budgetRange: string | null;
    city: string | null;
    courseOrDesignation: string | null;
    dateOfBirth: string | null;
    dietaryPreference: string;
    gender: string;
    governmentIdNumber: string | null;
    governmentIdType: string | null;
    institution: string | null;
    interests: string[];
    medicalNotes: string | null;
    permanentAddress: string | null;
    province: string | null;
  };
  emergencyContact: {
    isPrimary: boolean;
    name: string;
    phone: string;
    relation: string;
  };
  guardians: {
    email?: string;
    firstName: string;
    isPrimary: boolean;
    lastName: string;
    phone: string;
    relation: string;
  }[];
  resident: {
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
    residentType: string;
  };
};

type ResidentStatus = "ACTIVE" | "MOVED_OUT" | "PENDING" | "SUSPENDED";

/**
 * Statuses the row menu can switch a resident to, in the order they read.
 * Moving out is not one of them — it settles the deposit too, so it has its own
 * "Move out" item and dialog.
 */
const STATUS_ACTIONS: { label: string; status: ResidentStatus }[] = [
  { label: "Mark as active", status: "ACTIVE" },
  { label: "Mark as pending", status: "PENDING" },
  { label: "Suspend", status: "SUSPENDED" },
];

function humanizeValue(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Read-only view of everything the resident shared that the registration form
 * itself has no field for — blood group, ID, allergies. The warden sees it here
 * and it is carried into the resident's guardian / emergency records on save.
 */
function ImportedProfileSummary({
  photo,
  prefill,
}: {
  photo: PrefillPhoto | null;
  prefill: ResidentPrefill;
}) {
  const { details } = prefill;
  const facts: [string, string][] = [
    ["Gender", humanizeValue(details.gender)],
    ["Age", details.age ? `${details.age} years` : "—"],
    ["Blood group", details.bloodGroup === "UNKNOWN" ? "—" : details.bloodGroup],
    ["Food", humanizeValue(details.dietaryPreference)],
    [
      details.governmentIdType
        ? humanizeValue(details.governmentIdType)
        : "Government ID",
      details.governmentIdNumber ?? "—",
    ],
    ["Institution", details.institution ?? "—"],
    ["Course / role", details.courseOrDesignation ?? "—"],
    [
      "Home",
      [details.permanentAddress, details.city, details.province]
        .filter(Boolean)
        .join(", ") || "—",
    ],
  ];

  const people: { name: string; phone: string; role: string }[] = [
    ...prefill.guardians.map((guardian) => ({
      name: `${guardian.firstName} ${guardian.lastName}`.trim(),
      phone: guardian.phone,
      role: `${guardian.isPrimary ? "Guardian" : "Second guardian"} · ${guardian.relation}`,
    })),
    {
      name: prefill.emergencyContact.name,
      phone: prefill.emergencyContact.phone,
      role: `Emergency · ${prefill.emergencyContact.relation}`,
    },
  ];

  return (
    <div className="overflow-hidden rounded-xl border border-role-admin/25 bg-role-admin-soft/15">
      <p className="flex items-center gap-2 border-b border-role-admin/20 bg-role-admin-soft/40 px-4 py-2.5 text-xs font-extrabold uppercase tracking-wide text-role-admin">
        <ShieldCheck className="size-3.5" />
        Shared by the resident
      </p>

      <div className="space-y-4 p-4">
        {/* Stacked label-over-value reads far better than a wall of
            left/right rows once there are eight of them. */}
        <div className="flex flex-col gap-4 sm:flex-row">
          {photo ? (
            /*
             * Their face, beside the facts they shared, because this block is
             * where the person at the desk is checked against the profile that
             * is about to become a tenancy. Plain <img>: next/image would want
             * this private, per-resident route in its loader config and would
             * cache a face at the edge.
             */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              alt={`Photo on ${photo.residentId}'s ID card`}
              className="size-28 shrink-0 rounded-xl border border-role-admin/25 bg-background object-cover"
              src={`/api/v1/hostel-admin/resident-scan/photo?residentId=${encodeURIComponent(
                photo.residentId,
              )}&v=${encodeURIComponent(photo.updatedAt ?? "1")}`}
            />
          ) : null}

          <dl className="grid flex-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {label}
                </dt>
                <dd className="mt-0.5 break-words text-sm font-medium text-foreground">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="grid gap-2 border-t border-role-admin/15 pt-4 sm:grid-cols-2 lg:grid-cols-3">
          {people.map((person) => (
            <div
              className="rounded-lg border border-border bg-background/70 px-3 py-2"
              key={`${person.role}-${person.phone}`}
            >
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {person.role}
              </p>
              <p className="text-sm font-medium text-foreground">{person.name}</p>
              <p className="text-xs text-muted-foreground">{person.phone}</p>
            </div>
          ))}
        </div>

        {details.medicalNotes ? (
          <p className="rounded-lg border border-amber-300/50 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/25 dark:text-amber-200">
            <span className="font-bold">Medical notes: </span>
            {details.medicalNotes}
          </p>
        ) : null}

        <p className="text-[11px] text-muted-foreground">
          Guardian and emergency contact records are created automatically when you save
          this resident.
        </p>
      </div>
    </div>
  );
}

/** One titled block of the registration form. */
function FormSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h4 className="text-sm font-bold text-foreground">{title}</h4>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}

/**
 * One labelled block of the resident panel. The panel scrolls as a single
 * column rather than hiding two thirds of a resident behind tabs.
 */
function PanelSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="space-y-2 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-xs font-extrabold uppercase tracking-wide text-role-admin">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Read-only card for a guardian / emergency contact. The hostel never edits
 * these — they belong to the resident's own profile, so the panel only mirrors
 * what the resident entered.
 */
function ContactCard({ rows, title }: { rows: [string, string][]; title: string }) {
  return (
    <div className="rounded-xl border border-border bg-muted/15 p-3">
      <p className="mb-2 text-xs font-extrabold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <dl className="space-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div className="flex justify-between gap-3" key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right font-medium text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export const HostelAdminResidentsPage = memo(function HostelAdminResidentsPage() {
  const residentsQuery = useResidents();
  const roomTypesQuery = useAvailableRoomTypes();
  const residents = useMemo(
    () => residentsQuery.data?.residents ?? [],
    [residentsQuery.data],
  );
  const roomTypeOptions = useMemo(
    () => roomTypesQuery.data?.roomTypes ?? [],
    [roomTypesQuery.data],
  );
  const isPending =
    residentsQuery.state === "loading" || roomTypesQuery.state === "loading";
  const isError = residentsQuery.state === "error" || roomTypesQuery.state === "error";

  const [selectedResidentId, setSelectedResidentId] = useState("");
  const [activationCode, setActivationCode] = useState("");
  const [message, setMessage] = useState("");
  /*
   * What the last registration actually produced — reference codes, the amount
   * due and how this hostel takes it. Held rather than folded into `message`
   * because the resident is standing at the desk and has to read a code off the
   * screen; a sentence that scrolls away with the next toast cannot do that.
   */
  const [registered, setRegistered] = useState<RegistrationOutcome | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [showAddForm, setShowAddForm] = useState(false);
  const [lookupId, setLookupId] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [prefill, setPrefill] = useState<ResidentPrefill | null>(null);
  const [prefillPhoto, setPrefillPhoto] = useState<PrefillPhoto | null>(null);
  const [prefillOccupancy, setPrefillOccupancy] = useState<PrefillOccupancy | null>(null);
  /** The confirmed booking this card holds here — registering them closes it (docs/BOOKINGS.md item 8). */
  const [cardBooking, setCardBooking] = useState<{
    code: string;
    guestName: string;
    holdEndsAt: string | null;
    roomType: string;
  } | null>(null);
  /** "identify" asks for the resident ID first; "form" is the actual registration. */
  const [addStep, setAddStep] = useState<"identify" | "form">("identify");
  /** Room type drives the monthly rent, so both are controlled in the form. */ const [
    roomType,
    setRoomType,
  ] = useState("");
  const [monthlyFee, setMonthlyFee] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [moveOutResident, setMoveOutResident] = useState<Resident | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  const workspaceHref = useWorkspaceHref();
  const [saveBusy, setSaveBusy] = useState(false);

  const selectedResident =
    residents.find((resident) => resident.id === selectedResidentId) ?? residents[0];
  const activeResidentId = selectedResident?.id ?? "";

  const contactsQuery = useResidentContacts(activeResidentId);
  // Registering from a resident ID already wrote these, so the tabs show the
  // resident's own records rather than asking the hostel to retype them.
  const guardians = useMemo(
    () => contactsQuery.data?.guardians ?? [],
    [contactsQuery.data],
  );
  const emergencyContacts = useMemo(
    () => contactsQuery.data?.emergencyContacts ?? [],
    [contactsQuery.data],
  );

  const [exporting, setExporting] = useState(false);

  /** Every resident, not the page on screen — the list is paginated server-side. */
  async function exportResidents() {
    setExporting(true);

    try {
      const all: Resident[] = [];

      // ponytail: 100 × 50 pages = 5,000 residents; far past any one hostel.
      for (let page = 1; page <= 50; page += 1) {
        const { residents } = await browserApi<{ residents: Resident[] }>(
          `${hostelAdminEndpoints.residents}?page=${page}&pageSize=100`,
        );

        all.push(...residents);

        if (residents.length < 100) break;
      }

      downloadCsv(
        "residents",
        [
          { key: "name", label: "Name" },
          { key: "phone", label: "Phone" },
          { key: "email", label: "Email" },
          { key: "roomType", label: "Room type" },
          { key: "residentType", label: "Type" },
          { key: "status", label: "Status" },
          { key: "moveInDate", label: "Move-in" },
          { key: "monthlyFee", label: "Monthly fee" },
          { key: "depositAmount", label: "Deposit" },
        ],
        all.map((resident) => ({
          ...resident,
          moveInDate: resident.moveInDate?.slice(0, 10) ?? "",
          name: resident.fullName ?? `${resident.firstName} ${resident.lastName}`.trim(),
        })),
      );
    } catch {
      toast.error({ title: "Could not export residents." });
    } finally {
      setExporting(false);
    }
  }

  const filteredResidents = useMemo(() => {
    const query = search.trim().toLowerCase();
    return residents.filter((resident) => {
      if (statusFilter !== "ALL" && resident.status !== statusFilter) {
        return false;
      }
      if (typeFilter !== "ALL" && (resident.residentType ?? "STUDENT") !== typeFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = [
        resident.firstName,
        resident.lastName,
        resident.phone,
        resident.email,
        resident.roomType,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [residents, search, statusFilter, typeFilter]);

  const handleResidentLookup = useCallback(async () => {
    const query = lookupId.trim();

    if (!query) {
      return;
    }

    setLookupBusy(true);
    setLookupError("");

    try {
      const result = await browserApi<{
        occupancy?: PrefillOccupancy | null;
        photo: { hasPhoto: boolean; updatedAt: string | null };
        prefill: ResidentPrefill;
        residentId: string;
      }>(`/api/v1/hostel-admin/resident-lookup?residentId=${encodeURIComponent(query)}`);

      setPrefill(result.prefill);
      setPrefillOccupancy(result.occupancy ?? null);
      // Beside the lookup, not inside it: a booking check that fails must never stop a registration.
      browserApi<{ booking: typeof cardBooking }>(
        `/api/v1/hostel-admin/bookings/card?card=${encodeURIComponent(query)}`,
      )
        .then((data) => setCardBooking(data.booking))
        .catch(() => setCardBooking(null));
      setPrefillPhoto(
        result.photo.hasPhoto
          ? { residentId: result.residentId, updatedAt: result.photo.updatedAt }
          : null,
      );
      setShowAddForm(true);
      setAddStep("form");
      setMessage("");
    } catch (error) {
      setPrefill(null);
      setPrefillPhoto(null);
      setPrefillOccupancy(null);
      setLookupError(
        error instanceof Error ? error.message : "Could not load that resident ID.",
      );
    } finally {
      setLookupBusy(false);
    }
  }, [lookupId]);

  const clearPrefill = useCallback(() => {
    setPrefill(null);
    setPrefillPhoto(null);
    setPrefillOccupancy(null);
    setCardBooking(null);
    setLookupId("");
    setLookupError("");
  }, []);

  /**
   * Picking a room type fills in that type's rent. The fee field is read-only —
   * rent is a property of the room type, not something typed per resident.
   */
  const handleRoomTypeChange = useCallback(
    (value: string) => {
      setRoomType(value);
      const option = roomTypeOptions.find((entry) => entry.roomType === value);
      setMonthlyFee(option ? String(option.monthlyRent) : "");
    },
    [roomTypeOptions],
  );

  const handleDeleteResident = useCallback(
    async (resident: Resident) => {
      const fullName = `${resident.firstName} ${resident.lastName}`.trim();

      const confirmed = await confirm({
        actionLabel: "Remove resident",
        description: `${fullName}'s bed is freed and they disappear from every list in this hostel.`,
        title: "Remove this resident?",
        tone: "destructive",
      });

      if (!confirmed) {
        return;
      }

      setDeleteBusy(true);

      try {
        await browserApi(`/api/v1/hostel-admin/residents/${resident.id}`, {
          method: "DELETE",
        });
        setSelectedResidentId("");
        setActivationCode("");
        setMessage(`${fullName} was removed from this hostel.`);
        // The freed bed changes vacancy, so the room-type dropdown refetches too.
        await Promise.all([residentsQuery.refreshAsync(), roomTypesQuery.refreshAsync()]);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not remove resident.");
      } finally {
        setDeleteBusy(false);
      }
    },
    [confirm, residentsQuery, roomTypesQuery],
  );

  const handleStatusChange = useCallback(
    async (resident: Resident, status: ResidentStatus) => {
      const fullName = `${resident.firstName} ${resident.lastName}`.trim();

      try {
        const result = await browserApi<{
          accountLink: { linked: boolean; reason?: string };
        }>(`/api/v1/hostel-admin/residents/${resident.id}/status`, {
          body: JSON.stringify({ status }),
          method: "PATCH",
        });
        // Activating is also the moment their login becomes a resident login,
        // so say whether that worked rather than only echoing the status.
        const accountNote =
          status !== "ACTIVE"
            ? ""
            : result.accountLink.linked
              ? " They can sign in with their own email and land on their resident dashboard."
              : " Their account could not be linked — generate an activation code for them.";
        setMessage(
          `${fullName} is now ${status.replaceAll("_", " ").toLowerCase()}.${accountNote}`,
        );
        await Promise.all([residentsQuery.refreshAsync(), roomTypesQuery.refreshAsync()]);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not update status.");
      }
    },
    [residentsQuery, roomTypesQuery],
  );

  const handleCreateResident = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);

      setSaveBusy(true);

      try {
        const created = await browserApi<{
          /** Optional for the same reason `firstMonth` is — see below. */
          accountLink?: { linked: boolean; reason?: string };
          /**
           * Admission fee less any referral discount, plus the security deposit,
           * on one invoice under one reference code (`raiseAdmissionInvoice`).
           * `raised: false` is ordinary — a hostel that charges neither invoices
           * nothing at the door.
           */
          admission?:
            | { amount: number; raised: true; referenceCode: string }
            | { raised: false; reason: string };
          /**
           * How this hostel takes money, resolved server-side at the moment of
           * registration. Null when the lookup failed; empty `methods` when the
           * owner has not set a payment profile up at all, which the summary
           * says out loud rather than showing an empty list.
           */
          howToPay?: RegistrationOutcome["howToPay"];
          /**
           * The move-in month's rent, raised by the intake itself and pro-rated
           * from the move-in day. `raised: false` is ordinary — a `PENDING`
           * resident is not billable until somebody admits them, and a hostel
           * with no rate card cannot be billed at all.
           *
           * Optional because this page can be newer than the API answering it,
           * and a sentence about the invoice must not be able to report a
           * registration that succeeded as one that failed.
           */
          firstMonth?:
            | { amount: number; period: string; raised: true; referenceCode: string }
            | { period: string; raised: false; reason: string };
          referral: { code: string } | null;
          resident: { id: string };
        }>("/api/v1/hostel-admin/residents", {
          body: JSON.stringify({
            // No `monthlyFee`. Intake does not set a rent — the rate card does,
            // and the field above is a read-only quote of it. Sending zero for a
            // blank box wrote a permanent free-stay override on every resident
            // registered here, which is what `Resident.monthlyFee` warns about.
            depositAmount: Number(field(form, "depositAmount") || 0),
            email: optionalField(form, "email"),
            firstName: field(form, "firstName"),
            lastName: field(form, "lastName"),
            moveInDate: field(form, "moveInDate"),
            phone: field(form, "phone"),
            referralCode: optionalField(form, "referralCode"),
            residentType: field(form, "residentType"),
            // The server decrements this room type's vacant-bed count.
            roomType: field(form, "roomType"),
            // The ID this intake was loaded from, when it was loaded from one.
            // It is how the server knows which account to turn into a resident
            // login — the email on the form is their profile address, which is
            // not necessarily the one they sign in with.
            userResidentId: prefill ? lookupId.trim() : undefined,
          }),
          method: "POST",
        });

        // The whole point of scanning a resident ID: the guardian and emergency
        // records the hostel would otherwise re-type get written for them.
        let attachedContacts = 0;

        if (prefill) {
          const residentId = created.resident.id;
          const contactRequests = [
            ...prefill.guardians.map((guardian) =>
              browserApi(`/api/v1/hostel-admin/residents/${residentId}/guardians`, {
                body: JSON.stringify(guardian),
                method: "POST",
              }),
            ),
            browserApi(
              `/api/v1/hostel-admin/residents/${residentId}/emergency-contacts`,
              { body: JSON.stringify(prefill.emergencyContact), method: "POST" },
            ),
          ];

          const outcomes = await Promise.allSettled(contactRequests);
          attachedContacts = outcomes.filter(
            (outcome) => outcome.status === "fulfilled",
          ).length;
        }

        formElement.reset();
        setRoomType("");
        setMonthlyFee("");
        setShowAddForm(false);
        setAddStep("identify");
        const referralNote = created.referral
          ? ` Credited to referral code ${created.referral.code}.`
          : "";
        setMessage(
          (prefill
            ? `Resident created from ID ${lookupId.trim().toUpperCase()} — ${attachedContacts} contact record(s) added automatically.`
            : "Resident created.") + referralNote,
        );

        /*
         * Everything the desk needs while the resident is still in front of it.
         *
         * The invoices are collected in the order they are owed rather than the
         * order the server happens to return them: joining first, because it is
         * the payment being asked for right now, then the move-in month's rent.
         * Only the ones actually raised appear — an invoice that was skipped is
         * explained in `rentNote`, and a card reading "not raised" is a card
         * somebody would try to read a reference code off.
         */
        const invoices: RegisteredInvoice[] = [];

        if (created.admission?.raised) {
          invoices.push({
            amount: created.admission.amount,
            period: null,
            referenceCode: created.admission.referenceCode,
            title: "Joining — admission & deposit",
          });
        }

        if (created.firstMonth?.raised) {
          invoices.push({
            amount: created.firstMonth.amount,
            period: created.firstMonth.period,
            referenceCode: created.firstMonth.referenceCode,
            title: "Rent —",
          });
        }

        setRegistered({
          accountLinked: Boolean(created.accountLink?.linked),
          accountLinkReason: created.accountLink?.reason,
          dueNow: invoices.reduce((total, invoice) => total + invoice.amount, 0),
          howToPay: created.howToPay ?? null,
          invoices,
          /*
           * The case an owner has to know about: a pending resident owes nothing
           * until somebody marks them as living here, so the missing rent line is
           * explained rather than left as an absence.
           */
          rentNote:
            created.firstMonth && !created.firstMonth.raised
              ? "No rent is due yet — it is invoiced when they are marked as living here."
              : null,
          residentId: created.resident.id,
          residentName: `${field(form, "firstName")} ${field(form, "lastName")}`.trim(),
        });
        clearPrefill();
        // Vacancy just changed, so the room-type dropdown has to be refetched
        // alongside the resident list.
        await Promise.all([residentsQuery.refreshAsync(), roomTypesQuery.refreshAsync()]);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not create resident.");
      } finally {
        setSaveBusy(false);
      }
    },
    [clearPrefill, lookupId, prefill, residentsQuery, roomTypesQuery],
  );

  const handleGenerateActivation = useCallback(async (residentId: string) => {
    if (!residentId) {
      return;
    }

    // The code lands in the side panel, so make sure that panel is showing the
    // resident it belongs to — the row menu can target any row.
    setSelectedResidentId(residentId);

    try {
      const result = await browserApi<{
        activation: { code?: string };
        delivery: { sent: boolean; to?: string };
      }>(`/api/v1/hostel-admin/residents/${residentId}/activation-code`, {
        // Expiry is left to the platform's qrActivationExpiryDays setting.
        body: JSON.stringify({}),
        method: "POST",
      });

      setActivationCode(result.activation.code ?? "");
      setMessage(
        result.delivery.sent
          ? `Activation code generated and emailed to ${result.delivery.to}.`
          : "Activation code generated. No email was sent — share the code below with the resident.",
      );
    } catch (error) {
      setActivationCode("");
      setMessage(
        error instanceof Error ? error.message : "Could not generate activation code.",
      );
    }
  }, []);

  return (
    <div className="mx-auto max-w-[1448px] space-y-6">
      {confirmDialog}
      <ResidentMoveOutDialog
        onClose={() => setMoveOutResident(null)}
        onMovedOut={(note) => {
          setMoveOutResident(null);
          setMessage(note);
          // The freed bed changes vacancy, so the room-type dropdown refetches too.
          void Promise.all([residentsQuery.refreshAsync(), roomTypesQuery.refreshAsync()]);
        }}
        resident={moveOutResident}
      />
      <ResidentRegisteredSummary
        onClose={() => setRegistered(null)}
        onGenerateActivation={(residentId) => {
          setRegistered(null);
          void handleGenerateActivation(residentId);
        }}
        outcome={registered}
      />
      <PortalPageHeader
        actions={
          <>
            <JoinLinkButton />
            <RoleButton asChild tone="admin" variant="outline">
              <Link href={workspaceHref("/hostel-admin/existing-residents")}>
                <FileSpreadsheet className="size-4" />
                Add existing residents
              </Link>
            </RoleButton>
            <RoleButton
              onClick={() => handleGenerateActivation(activeResidentId)}
              tone="admin"
              type="button"
              variant="outline"
            >
              <QrCode className="size-4" />
              Generate Activation Code
            </RoleButton>
            <RoleButton
              onClick={() => {
                // Always reopen on the "ask for the resident ID" step — that is
                // the fast path, and typing everything by hand is the fallback.
                clearPrefill();
                setAddStep("identify");
                setShowAddForm((value) => !value);
              }}
              tone="admin"
              type="button"
            >
              <Plus className="size-4" />
              Add Resident
            </RoleButton>
          </>
        }
        description="Manage hostel residents, their details, and status."
        title="Residents"
      />

      {message ? (
        <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
          {message}
        </div>
      ) : null}

      <JoinRequestsPanel />

      {showAddForm ? (
        <SectionCard
          actions={
            <Button
              className="size-8"
              onClick={() => setShowAddForm(false)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <X className="size-4" />
            </Button>
          }
          description={
            addStep === "identify"
              ? "Start with the resident's ID — their saved details fill the form for you."
              : "Review the details, assign a room, then save."
          }
          title="Register New Resident"
        >
          {addStep === "identify" ? (
            <div className="space-y-4 rounded-xl border border-dashed border-role-admin/40 bg-role-admin-soft/15 p-5">
              <div>
                <p className="flex items-center gap-2 text-base font-bold text-foreground">
                  <ScanLine className="size-4 text-role-admin" />
                  Ask for their resident ID
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  They open their account menu, tap &quot;Show resident QR code&quot; and
                  read out the ID printed under it — or you scan the QR in the mobile app.
                  Everything they already filled in loads here, so nothing gets typed
                  twice.
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  aria-label="Resident ID"
                  autoFocus
                  className="h-12 flex-1 rounded-lg border border-border bg-background px-3 font-mono text-base uppercase tracking-widest text-foreground outline-none transition placeholder:font-sans placeholder:normal-case placeholder:tracking-normal placeholder:text-muted-foreground focus:border-role-admin"
                  onChange={(event) => setLookupId(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleResidentLookup();
                    }
                  }}
                  placeholder="HH-4K7M-9XQ2"
                  value={lookupId}
                />
                <RoleButton
                  className="h-12"
                  disabled={lookupBusy || !lookupId.trim()}
                  onClick={handleResidentLookup}
                  tone="admin"
                  type="button"
                >
                  {lookupBusy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ScanLine className="size-4" />
                  )}
                  {lookupBusy ? "Loading…" : "Load their details"}
                </RoleButton>
              </div>
              {lookupError ? (
                <p className="text-xs font-semibold text-danger">{lookupError}</p>
              ) : null}
              <button
                className="text-xs font-bold text-muted-foreground underline-offset-4 transition hover:text-foreground hover:underline"
                onClick={() => {
                  clearPrefill();
                  setAddStep("form");
                }}
                type="button"
              >
                They do not have one — enter the details manually
              </button>
            </div>
          ) : null}

          {addStep === "form" && prefill ? (
            <div className="mb-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SoftBadge tone="green">
                  <ShieldCheck className="size-3" />
                  Loaded from {lookupId.trim().toUpperCase()}
                </SoftBadge>
                <Button
                  onClick={() => {
                    clearPrefill();
                    setAddStep("identify");
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Use a different ID
                </Button>
              </div>
              {prefillOccupancy ? (
                <p
                  className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm font-semibold text-danger"
                  role="alert"
                >
                  {prefillOccupancy.sameHostel
                    ? `${prefill.resident.firstName} already lives in your hostel. Open their record instead of adding them again.`
                    : `${prefill.resident.firstName} already lives at ${prefillOccupancy.hostelName}. They can't be added here until ${prefillOccupancy.hostelName} moves them out.`}
                </p>
              ) : null}
              {cardBooking && !prefillOccupancy ? (
                <p className="rounded-xl border border-brand-teal/30 bg-brand-teal/10 px-4 py-3 text-sm text-foreground">
                  <strong>This card holds booking {cardBooking.code}.</strong> One {cardBooking.roomType} bed is held for{" "}
                  {cardBooking.guestName}
                  {cardBooking.holdEndsAt
                    ? ` until ${new Date(cardBooking.holdEndsAt).toLocaleString("en-GB", {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: "Asia/Kathmandu",
                      })}`
                    : ""}
                  . Registering them uses that bed and completes the booking; choosing another room type moves it.
                </p>
              ) : null}
              <ImportedProfileSummary photo={prefillPhoto} prefill={prefill} />
            </div>
          ) : null}

          <form
            className={cn("space-y-6", addStep === "identify" && "hidden")}
            key={prefill ? `prefill-${lookupId}` : "blank"}
            onSubmit={handleCreateResident}
          >
            <FormSection
              description="Who is moving in and how to reach them."
              title="Resident"
            >
              <FormInput
                defaultValue={prefill?.resident.firstName}
                label="First name"
                name="firstName"
                required
              />
              <FormInput
                defaultValue={prefill?.resident.lastName}
                label="Last name"
                name="lastName"
                required
              />
              <FormSelect
                defaultValue={prefill?.resident.residentType ?? "STUDENT"}
                label="Resident type"
                name="residentType"
              >
                <option value="STUDENT">Student</option>
                <option value="WORKING_PROFESSIONAL">Working professional</option>
                <option value="OTHER">Other</option>
              </FormSelect>
              <FormInput
                defaultValue={prefill?.resident.phone}
                label="Phone"
                name="phone"
                required
              />
              <FormInput
                defaultValue={prefill?.resident.email}
                label="Email"
                name="email"
                type="email"
              />
            </FormSection>

            <FormSection
              description="Picking a room type sets that type's monthly rent automatically."
              title="Room & stay"
            >
              <div className="grid gap-1">
                <FormSelect
                  label="Room type"
                  name="roomType"
                  onChange={(event) => handleRoomTypeChange(event.target.value)}
                  required
                  value={roomType}
                >
                  <option value="">
                    {roomTypeOptions.length > 0
                      ? "Select room type"
                      : "No room types available"}
                  </option>
                  {roomTypeOptions.map((option) => (
                    <option key={option.roomType} value={option.roomType}>
                      {option.roomType} ({option.vacantBeds} vacant ·{" "}
                      {currency(option.monthlyRent)}/mo)
                    </option>
                  ))}
                </FormSelect>
                {/* Only room types with a free bed are listed, so an empty
                    dropdown means the hostel is full or has no types set up. */}
                {roomTypeOptions.length === 0 && roomTypesQuery.state !== "loading" ? (
                  <p className="text-[11px] font-normal text-amber-700 dark:text-amber-300">
                    {roomTypesQuery.state === "error"
                      ? "Room types could not be loaded."
                      : "No vacant beds left. Add or update room types in Rooms & Beds."}
                  </p>
                ) : null}
              </div>
              {/* The rent belongs to the room type, so it is never typed by
                  hand — change it in Rooms & Beds and every resident follows. */}
              <FormInput
                hint={
                  roomType
                    ? "Set by the room type. Change it in Rooms & Beds."
                    : "Select a room type to fill this in."
                }
                label={
                  <span className="flex items-center gap-1.5">
                    Monthly fee
                    <Lock className="size-3 text-muted-foreground" />
                  </span>
                }
                min="0"
                name="monthlyFee"
                placeholder="—"
                readOnly
                type="number"
                value={monthlyFee}
              />
              <FormInput label="Move-in date" name="moveInDate" required type="date" />
              <FormInput label="Deposit" name="depositAmount" required type="number" />
              {/* Optional: credits the resident whose code brought this person
                  in. A wrong code is rejected before the bed is taken. */}
              <FormInput
                hint="If another resident referred them, enter their referral code."
                label="Referral code"
                name="referralCode"
                placeholder="Optional"
              />
            </FormSection>

            <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-end">
              <p className="mr-auto text-xs text-muted-foreground">
                {roomType
                  ? `${roomType} · ${currency(Number(monthlyFee || 0))}/month`
                  : "Pick a room type to see the monthly rent."}
              </p>
              <Button
                onClick={() => {
                  setShowAddForm(false);
                  setAddStep("identify");
                  clearPrefill();
                }}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <RoleButton
                disabled={saveBusy || Boolean(prefill && prefillOccupancy)}
                tone="admin"
                type="submit"
              >
                {saveBusy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <UserPlus className="size-4" />
                )}
                {saveBusy ? "Saving…" : "Save Resident"}
              </RoleButton>
            </div>
          </form>
        </SectionCard>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <SectionCard>
          <div className="mb-4 space-y-3">
            <SearchField
              onChange={setSearch}
              placeholder="Search by name, phone, room..."
              value={search}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Select onValueChange={setStatusFilter} value={statusFilter}>
                <SelectTrigger className="h-10 w-[160px] rounded-xl">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All statuses</SelectItem>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="PENDING">Pending</SelectItem>
                  <SelectItem value="SUSPENDED">Suspended</SelectItem>
                  <SelectItem value="MOVED_OUT">Moved out</SelectItem>
                </SelectContent>
              </Select>
              <Select onValueChange={setTypeFilter} value={typeFilter}>
                <SelectTrigger className="h-10 w-[190px] rounded-xl">
                  <SelectValue placeholder="Resident type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All types</SelectItem>
                  <SelectItem value="STUDENT">Student</SelectItem>
                  <SelectItem value="WORKING_PROFESSIONAL">
                    Working professional
                  </SelectItem>
                  <SelectItem value="OTHER">Other</SelectItem>
                </SelectContent>
              </Select>
              <SoftBadge tone="cyan">
                <Users className="size-3" />
                {/* The server total, not the page — the badge is the one place
                    an admin checks "how many residents do I have". The filters
                    below still narrow only the current page; pushing them into
                    the query is tracked in TODO.md B1. */}
                Total Residents:{" "}
                {residentsQuery.pagination?.total ?? filteredResidents.length}
              </SoftBadge>
              <Button
                className="ml-auto h-10 gap-2 rounded-xl"
                disabled={exporting}
                onClick={() => void exportResidents()}
                type="button"
                variant="outline"
              >
                <Download className="size-4" />
                {exporting ? "Exporting…" : "Export"}
              </Button>
            </div>
          </div>

          {isPending ? <LoadingRows /> : null}
          {isError ? <EmptyState label="Residents could not be loaded." /> : null}
          {!isPending && !isError && filteredResidents.length === 0 ? (
            <EmptyInline label="No residents match your filters." />
          ) : null}

          {!isPending && !isError && filteredResidents.length > 0 ? (
            <DataTable className="min-w-[720px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-10">
                    <span className="sr-only">Select</span>
                  </TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Resident
                  </TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Room type
                  </TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Phone
                  </TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Deposit
                  </TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Status
                  </TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredResidents.map((resident) => {
                  const fullName = `${resident.firstName} ${resident.lastName}`.trim();
                  const selected = activeResidentId === resident.id;

                  return (
                    <TableRow
                      className={cn(
                        "cursor-pointer",
                        selected &&
                          "bg-role-admin-soft/50 data-[state=selected]:bg-role-admin-soft/50",
                      )}
                      data-state={selected ? "selected" : undefined}
                      key={resident.id}
                      onClick={() => {
                        setSelectedResidentId(resident.id);
                        setActivationCode("");
                      }}
                    >
                      <TableCell onClick={(event) => event.stopPropagation()}>
                        <Checkbox
                          checked={selected}
                          onCheckedChange={() => {
                            setSelectedResidentId(resident.id);
                            setActivationCode("");
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <InitialsAvatar
                            image={resident.account?.image}
                            name={fullName}
                            size="sm"
                            tone="admin"
                          />
                          <div className="min-w-0">
                            <p className="font-semibold text-foreground">{fullName}</p>
                            {resident.isDemoData ? (
                              <DemoDataBadge label={resident.demoDataLabel} />
                            ) : (
                              <p className="text-xs text-muted-foreground">
                                {resident.roomType}
                              </p>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {resident.roomType}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {resident.phone}
                      </TableCell>
                      <TableCell className="font-medium text-foreground">
                        {currency(resident.depositAmount)}
                      </TableCell>
                      <TableCell>
                        <SoftBadge tone={statusToneFromLabel(resident.status)}>
                          {resident.status.replaceAll("_", " ")}
                        </SoftBadge>
                      </TableCell>
                      {/* The row itself selects on click, so the menu has to
                          keep its own clicks to itself. */}
                      <TableCell onClick={(event) => event.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              className="size-8"
                              size="icon"
                              type="button"
                              variant="ghost"
                            >
                              <MoreHorizontal className="size-4" />
                              <span className="sr-only">Actions for {fullName}</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-56">
                            <DropdownMenuLabel>{fullName}</DropdownMenuLabel>
                            <DropdownMenuItem
                              onSelect={() => void handleGenerateActivation(resident.id)}
                            >
                              <QrCode className="size-4" />
                              Generate activation code
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {STATUS_ACTIONS.filter(
                              (action) => action.status !== resident.status,
                            ).map((action) => (
                              <DropdownMenuItem
                                key={action.status}
                                onSelect={() =>
                                  void handleStatusChange(resident, action.status)
                                }
                              >
                                {action.label}
                              </DropdownMenuItem>
                            ))}
                            {resident.status !== "MOVED_OUT" ? (
                              <DropdownMenuItem
                                onSelect={() => setMoveOutResident(resident)}
                                variant="destructive"
                              >
                                <LogOut className="size-4" />
                                Move out
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={deleteBusy}
                              onSelect={() => void handleDeleteResident(resident)}
                              variant="destructive"
                            >
                              <Trash2 className="size-4" />
                              Delete resident
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </DataTable>
          ) : null}

          {residentsQuery.pagination && residentsQuery.pagination.totalPages > 1 ? (
            <ListPager
              onPageChange={residentsQuery.setPage}
              page={residentsQuery.pagination.page}
              pageSize={residentsQuery.pagination.pageSize}
              tone="admin"
              total={residentsQuery.pagination.total}
              unit="residents"
            />
          ) : null}
        </SectionCard>

        <div className="space-y-5">
          <SectionCard>
            {selectedResident ? (
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <InitialsAvatar
                    image={selectedResident.account?.image}
                    name={`${selectedResident.firstName} ${selectedResident.lastName}`}
                    size="lg"
                    tone="admin"
                  />
                  <div className="min-w-0">
                    <p className="text-lg font-bold text-foreground">
                      {selectedResident.firstName} {selectedResident.lastName}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {selectedResident.roomType}
                    </p>
                    <div className="mt-2">
                      <SoftBadge tone={statusToneFromLabel(selectedResident.status)}>
                        {selectedResident.status.replaceAll("_", " ")}
                      </SoftBadge>
                    </div>
                  </div>
                  {selectedResident.status !== "MOVED_OUT" ? (
                    <Button
                      className="ml-auto shrink-0"
                      onClick={() => setMoveOutResident(selectedResident)}
                      size="sm"
                      type="button"
                      variant="destructive"
                    >
                      <LogOut className="size-4" />
                      Move out
                    </Button>
                  ) : null}
                </div>

                <PanelSection title="Details">
                  <dl className="space-y-2 rounded-xl border border-border bg-muted/15 p-3 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Full Name</dt>
                      <dd className="font-medium text-foreground">
                        {selectedResident.firstName} {selectedResident.lastName}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Phone</dt>
                      <dd className="font-medium text-foreground">
                        {selectedResident.phone}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Email</dt>
                      <dd className="font-medium text-foreground">
                        {selectedResident.email || "—"}
                      </dd>
                    </div>
                    {/*
                      Whether this person can actually sign in, which nothing on
                      this screen used to say. Registering somebody is supposed
                      to turn their existing account into a resident login; when
                      that does not happen they are on the roll, billed, and
                      unable to reach their own portal — and the only cure is an
                      activation code nobody knew to issue.
                    */}
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Account</dt>
                      <dd
                        className={cn(
                          "font-medium",
                          selectedResident.account ? "text-foreground" : "text-warning",
                        )}
                      >
                        {selectedResident.account
                          ? selectedResident.account.email || "Linked"
                          : "No login yet"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Deposit</dt>
                      <dd className="font-medium text-foreground">
                        {currency(selectedResident.depositAmount)}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Monthly fee</dt>
                      <dd className="font-medium text-foreground">
                        {currency(selectedResident.monthlyFee ?? 0)}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Move-in</dt>
                      <dd className="font-medium text-foreground">
                        {selectedResident.moveInDate
                          ? new Date(selectedResident.moveInDate).toLocaleDateString()
                          : "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Room type</dt>
                      <dd className="font-medium text-foreground">
                        {selectedResident.roomType}
                      </dd>
                    </div>
                  </dl>
                </PanelSection>

                <PanelSection title="Guardian">
                  {contactsQuery.state === "loading" ? <LoadingRows /> : null}
                  {contactsQuery.state === "error" ? (
                    <EmptyInline label="Guardian details could not be loaded." />
                  ) : null}
                  {guardians.map((guardian) => (
                    <ContactCard
                      key={guardian.id}
                      rows={[
                        ["Name", `${guardian.firstName} ${guardian.lastName}`.trim()],
                        ["Phone", guardian.phone],
                        ["Relation", guardian.relation],
                        ["Email", guardian.email || "—"],
                      ]}
                      title={guardian.isPrimary ? "Primary guardian" : "Guardian"}
                    />
                  ))}
                  {contactsQuery.state !== "loading" &&
                  contactsQuery.state !== "error" &&
                  guardians.length === 0 ? (
                    <EmptyInline label="This resident has not added a guardian yet." />
                  ) : null}
                </PanelSection>

                <PanelSection title="Emergency">
                  {contactsQuery.state === "loading" ? <LoadingRows /> : null}
                  {contactsQuery.state === "error" ? (
                    <EmptyInline label="Emergency contacts could not be loaded." />
                  ) : null}
                  {emergencyContacts.map((contact) => (
                    <ContactCard
                      key={contact.id}
                      rows={[
                        ["Name", contact.name],
                        ["Phone", contact.phone],
                        ["Relation", contact.relation],
                      ]}
                      title={contact.isPrimary ? "Primary contact" : "Emergency contact"}
                    />
                  ))}
                  {contactsQuery.state !== "loading" &&
                  contactsQuery.state !== "error" &&
                  emergencyContacts.length === 0 ? (
                    <EmptyInline label="This resident has not added an emergency contact yet." />
                  ) : null}
                </PanelSection>

                {/*
                  Offered where it is the answer, and explained where it is not.
                  A resident who already has a login does not need a code, and a
                  button standing next to a linked account invites an admin to
                  issue one and then wonder why nothing changed. A fresh code is
                  still reachable for the real case — setting the account up
                  again on a new phone — behind a plainer control.
                */}
                <PanelSection title="Activation">
                  {activationCode ? (
                    <div className="rounded-xl border border-role-admin/30 bg-role-admin-soft/50 p-4">
                      <p className="text-sm font-semibold text-foreground">
                        Activation Code
                      </p>
                      <p className="mt-2 font-mono text-2xl font-bold tracking-widest text-role-admin">
                        {activationCode}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Emailed to them if they have an address on file. It is used
                        once, and only after they sign in to their own account.
                      </p>
                    </div>
                  ) : selectedResident.account ? (
                    <div className="space-y-3">
                      <p className="text-xs text-muted-foreground">
                        They sign in as{" "}
                        <span className="font-medium text-foreground">
                          {selectedResident.account.email || "their linked account"}
                        </span>{" "}
                        and land on their resident dashboard. No code is needed.
                      </p>
                      <Button
                        className="w-full gap-2"
                        onClick={() => handleGenerateActivation(activeResidentId)}
                        type="button"
                        variant="outline"
                      >
                        <QrCode className="size-4" />
                        Issue a new code anyway
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-xs text-muted-foreground">
                        This resident has no login yet. The code is how they claim
                        one — they sign in to their own account, enter it, and their
                        resident portal opens.
                      </p>
                      <RoleButton
                        className="w-full"
                        onClick={() => handleGenerateActivation(activeResidentId)}
                        tone="admin"
                        type="button"
                        variant="outline"
                      >
                        <QrCode className="size-4" />
                        Generate Activation Code
                      </RoleButton>
                    </div>
                  )}
                </PanelSection>

                <Button
                  className="w-full gap-2 border-danger/40 text-danger hover:bg-danger/10 hover:text-danger"
                  disabled={deleteBusy}
                  onClick={() => handleDeleteResident(selectedResident)}
                  type="button"
                  variant="outline"
                >
                  {deleteBusy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  {deleteBusy ? "Removing…" : "Delete Resident"}
                </Button>
              </div>
            ) : (
              <EmptyInline label="Select a resident to view details." />
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
});
