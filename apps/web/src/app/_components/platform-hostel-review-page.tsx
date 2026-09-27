"use client";

import {
  CircleCheck,
  Check,
  Clock3,
  ExternalLink,
  EyeOff,
  FileText,
  Globe,
  History,
  ImageOff,
  Mail,
  MapPin,
  Maximize2,
  Phone,
  ShieldQuestion,
  X,
} from "lucide-react";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";

import { currency, EmptyState, LoadingRows } from "@/app/_components/shared-ui";
import {
  DataTable,
  InitialsAvatar,
  PortalPageHeader,
  RoleButton,
  SectionCard,
  SoftBadge,
  TabBar,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  Th,
  statusToneFromLabel,
} from "@/app/_components/portal-dashboard-ui";
import { MediaLightbox, type LightboxItem } from "@/components/media-lightbox";
import { ReviewPayoutAccount } from "@/components/bookings/review-payout-account";
import { browserApi } from "@/lib/browser-api";
import { platformEndpoints } from "@/lib/platform-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";
import { Hostel, Message } from "./core-portal-shared";

type PlatformHostelDocument = {
  createdAt: string | null;
  documentType: string;
  fileAssetId: string | null;
  /** From the FileAsset — empty on legacy rows that only kept a raw URL. */
  fileName?: string;
  fileUrl: string;
  id: string;
  mimeType?: string;
  rejectionReason: string;
  status: string;
};

type PlatformApplication = {
  id: string;
  infoRequestNote: string;
  infoRequestedAt: string | null;
  notes: string;
  rejectionReason: string;
  requestedDocuments: Array<{ documentType: string; note: string }>;
  reviewedAt: string | null;
  snapshot: Record<string, unknown>;
  status: string;
  submittedAt: string | null;
} | null;

type Contact = {
  email: string;
  id: string;
  name: string;
  phone: string;
  registeredAt: string | null;
  role: string;
} | null;

type RoomConfiguration = {
  bedsPerRoom: number;
  mealInclusion: string;
  monthlyRent: number;
  rooms: number;
  roomType: string;
  vacantBeds: number;
};

type PlatformHostelDetail = {
  applicant: Contact;
  application: PlatformApplication;
  /** Set on a branch: the main hostel it must match. */
  branchOf?: {
    id: string;
    name: string;
    panNumber: string | null;
    payoutHolder: string | null;
    payoutVerified: boolean;
    phone: string;
    slug: string;
  } | null;
  documents: PlatformHostelDocument[];
  hostel: Hostel & { roomConfigurations?: RoomConfiguration[] };
  owner: Contact;
  submitter: Contact;
};

/**
 * Approve/reject/publish are one-way transitions, so which header buttons make
 * sense depends on the hostel's current status — mirrors actionsForHostel() in
 * platform-hostels-page.tsx (the list view's detail panel already gates on this;
 * this full-page review previously did not, so a PUBLISHED hostel still showed
 * "Approve").
 */
function headerActionsForStatus(
  status: string,
): Array<"approve" | "reject" | "request-documents"> {
  switch (status) {
    case "DRAFT":
    case "PENDING_APPROVAL":
      return ["approve", "request-documents", "reject"];
    case "APPROVED":
      return ["reject"];
    case "REJECTED":
      return ["approve", "request-documents"];
    default:
      return [];
  }
}

/**
 * A FileAsset id routes through the secure, auth-gated presign endpoint, which
 * 302-redirects the reviewer to a short-lived R2 URL. Legacy records that only
 * stored a raw fileUrl fall back to that URL directly.
 */
function assetHref(fileAssetId?: string | null, fileUrl?: string) {
  if (fileAssetId) {
    return `/api/v1/files/${fileAssetId}/url`;
  }
  return fileUrl || null;
}

/** The presign URL carries no extension, so the asset's own type decides. */
function documentKind(document: PlatformHostelDocument): "image" | "pdf" | "file" {
  const mime = document.mimeType ?? "";
  const name = document.fileName || (document.fileUrl.split(/[?#]/)[0] ?? "");
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|avif)$/i.test(name)) {
    return "image";
  }
  // Legacy rows with neither were always photos of paperwork.
  return mime ? "file" : "image";
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function humanizeKey(key: string) {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^./, (character) => character.toUpperCase());
}

function humanizeEnum(value: string) {
  return humanizeKey(value.toLowerCase());
}

// ── Original submission ───────────────────────────────────────────────

/** Asset ids and the like are plumbing, not something the owner typed. */
const HIDDEN_SNAPSHOT_KEY = /id$/i;
const MONEY_KEY = /rent|fee|price|amount/i;

type SnapshotCell = { now?: string; value: string };
type SnapshotGroup =
  | { cells: Array<SnapshotCell & { label: string }>; kind: "fields"; title: string }
  | {
      columns: Array<{ key: string; label: string }>;
      kind: "table";
      rows: SnapshotCell[][];
      title: string;
    };

function displayValue(value: unknown, key = ""): string {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" && MONEY_KEY.test(key)) return currency(value);
  if (Array.isArray(value)) {
    return value.length ? value.map((item) => displayValue(item)).join(", ") : "—";
  }
  if (typeof value === "object") {
    return Object.values(value).map((item) => displayValue(item)).join(", ");
  }
  return String(value);
}

/**
 * The submitted value, plus what the live listing holds at the same path when
 * that differs. Paths the listing doesn't store (applicant, chosen plan) have
 * nothing to compare against and are left alone.
 */
function snapshotCell(
  submitted: unknown,
  live: unknown,
  path: Array<string | number>,
): SnapshotCell {
  const key = String(path.at(-1));
  const value = displayValue(submitted, key);
  const current = path.reduce<unknown>(
    (node, step) =>
      node != null && typeof node === "object"
        ? (node as Record<string, unknown>)[step]
        : undefined,
    live,
  );
  if (current === undefined || (current !== null && typeof current === "object")) {
    return { value };
  }
  const now = displayValue(current, key);
  return now === value ? { value } : { now, value };
}

/**
 * Groups the stored registration snapshot the way the form asked for it: loose
 * fields together, each nested object as its own card, lists of objects (room
 * configurations, documents) as tables.
 */
function snapshotGroups(snapshot: Record<string, unknown>, live: unknown) {
  const general: Array<SnapshotCell & { label: string }> = [];
  const groups: SnapshotGroup[] = [];

  for (const [key, value] of Object.entries(snapshot)) {
    if (HIDDEN_SNAPSHOT_KEY.test(key)) continue;
    const title = humanizeKey(key);

    if (Array.isArray(value) && value.some((item) => item && typeof item === "object")) {
      const items = value as Array<Record<string, unknown>>;
      const columns = [...new Set(items.flatMap((item) => Object.keys(item ?? {})))]
        .filter((column) => !HIDDEN_SNAPSHOT_KEY.test(column))
        .map((column) => ({ key: column, label: humanizeKey(column) }));
      groups.push({
        columns,
        kind: "table",
        rows: items.map((item, index) =>
          columns.map((column) =>
            snapshotCell(item?.[column.key], live, [key, index, column.key]),
          ),
        ),
        title,
      });
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      groups.push({
        cells: Object.entries(value)
          .filter(([field]) => !HIDDEN_SNAPSHOT_KEY.test(field))
          .map(([field, nested]) => ({
            label: humanizeKey(field),
            ...snapshotCell(nested, live, [key, field]),
          })),
        kind: "fields",
        title,
      });
    } else {
      general.push({ label: title, ...snapshotCell(value, live, [key]) });
    }
  }

  return general.length > 0
    ? [{ cells: general, kind: "fields" as const, title: "General" }, ...groups]
    : groups;
}

function SnapshotValue({ cell }: { cell: SnapshotCell }) {
  if (!cell.now) return <>{cell.value}</>;
  return (
    <>
      <span className="text-muted-foreground line-through">{cell.value}</span>
      <span className="block text-[11.5px] font-semibold text-amber-600 dark:text-amber-400">
        Now {cell.now}
      </span>
    </>
  );
}

// ── Layout pieces ─────────────────────────────────────────────────────

/** Label-over-value pairs: short eye travel, unlike a full-width label ··· value row. */
function Facts({
  columns = 2,
  items,
}: {
  columns?: 2 | 3;
  items: Array<{ label: string; value: ReactNode }>;
}) {
  return (
    <dl
      className={cn(
        "grid grid-cols-2 gap-x-4 gap-y-3",
        columns === 3 && "sm:grid-cols-3",
      )}
    >
      {items.map((item) => (
        <div className="min-w-0" key={item.label}>
          <dt className="text-[11px] text-muted-foreground">{item.label}</dt>
          <dd className="mt-0.5 break-words text-[13px] font-medium text-foreground">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-border/70 bg-card px-3 py-2.5 shadow-sm">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-[16px] font-bold tracking-tight text-foreground">
        {value}
      </p>
    </div>
  );
}

function PersonRow({ contact, label }: { contact: NonNullable<Contact>; label: string }) {
  return (
    <div className="flex items-start gap-3 border-b border-border/60 py-3 first:pt-0 last:border-0 last:pb-0">
      <InitialsAvatar name={contact.name} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[13.5px] font-semibold text-foreground">{contact.name}</p>
          <SoftBadge>{humanizeEnum(contact.role)}</SoftBadge>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {label} · joined {formatTimestamp(contact.registeredAt)}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {contact.email ? (
            <RoleButton asChild tone="platform" variant="outline">
              <a href={`mailto:${contact.email}`}>
                <Mail className="size-3.5" />
                {contact.email}
              </a>
            </RoleButton>
          ) : null}
          {contact.phone ? (
            <RoleButton asChild tone="platform" variant="outline">
              <a href={`tel:${contact.phone}`}>
                <Phone className="size-3.5" />
                {contact.phone}
              </a>
            </RoleButton>
          ) : (
            <span className="self-center text-[11.5px] text-muted-foreground">
              No phone on the account
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

const PHOTO_KIND_ORDER = { EXTERIOR: 0, INTERIOR: 1, ROOM: 2 } as const;

export const PlatformHostelReviewPageContent = memo(
  function PlatformHostelReviewPageContent() {
    const params = useParams<{ id: string }>();
    const [actionMessage, setActionMessage] = useState("");
    const [busy, setBusy] = useState(false);
    const [tab, setTab] = useState("overview");
    const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
    const [lightboxItems, setLightboxItems] = useState<LightboxItem[]>([]);

    const invalidate = useInvalidateResources();
    // Same cache entry the Hostels list opens its detail panel from, so arriving
    // here from that screen paints immediately.
    const detailResource = usePortalResource<PlatformHostelDetail>(
      platformEndpoints.hostel(params.id),
      { errorMessage: "Could not load hostel." },
    );

    const detail = detailResource.data ?? null;
    const message = actionMessage || detailResource.message;

    const action = useCallback(
      async (nextAction: string) => {
        let body = JSON.stringify({});

        if (nextAction === "reject") {
          const reason = window.prompt("Rejection reason")?.trim();
          if (!reason) return;
          body = JSON.stringify({ reason });
        } else if (nextAction === "request-documents") {
          const raw = window.prompt(
            "Which documents are needed? Separate multiple with commas.\ne.g. Citizenship (clearer scan), Hostel license",
          );
          if (!raw) return;
          const documents = raw
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
            .map((documentType) => ({ documentType }));
          if (documents.length === 0) return;
          const note =
            window.prompt("Optional message to the owner (leave blank to skip):") ||
            undefined;
          body = JSON.stringify({ documents, note });
        } else if (nextAction === "unpublish") {
          // Required: the owner is emailed this reason verbatim.
          const reason = window
            .prompt(
              "Why is this listing being unpublished? The owner will see this reason.",
            )
            ?.trim();
          if (!reason) return;
          body = JSON.stringify({ reason });
        }

        setBusy(true);
        try {
          const result = await browserApi<{
            notification?: { reason?: string; sent: boolean; to?: string };
          }>(`${platformEndpoints.hostel(params.id)}/${nextAction}`, {
            body,
            method: "PATCH",
          });

          // The request is saved either way, but the owner only finds out if the
          // email actually left — say so rather than reporting a flat success.
          const notification = result?.notification;

          setActionMessage(
            notification && !notification.sent
              ? `Documents requested, but the owner was NOT emailed (${notification.reason ?? "unknown error"}). Contact ${notification.to ?? "the owner"} manually.`
              : `Hostel ${nextAction} action completed.`,
          );
          invalidate(platformEndpoints.hostel(params.id), platformEndpoints.hostels);
        } catch (error) {
          setActionMessage(error instanceof Error ? error.message : "Action failed.");
        } finally {
          setBusy(false);
        }
      },
      [invalidate, params.id],
    );

    const hostel = detail?.hostel ?? null;
    const application = detail?.application ?? null;
    const headerActions = headerActionsForStatus(hostel?.status ?? "");
    const documents = useMemo(() => detail?.documents ?? [], [detail]);
    const requestedDocuments = application?.requestedDocuments ?? [];

    const photoItems = useMemo<LightboxItem[]>(
      () =>
        [...(hostel?.photos ?? [])]
          .sort(
            (a, b) =>
              PHOTO_KIND_ORDER[a.kind ?? "INTERIOR"] -
                PHOTO_KIND_ORDER[b.kind ?? "INTERIOR"] ||
              (a.roomType ?? "").localeCompare(b.roomType ?? ""),
          )
          .flatMap<LightboxItem>((photo) => {
            const src = assetHref(
              (photo as { fileAssetId?: string }).fileAssetId,
              photo.url,
            );
            const caption =
              photo.kind === "ROOM"
                ? photo.roomType || "Room"
                : photo.kind === "EXTERIOR"
                  ? "Outside"
                  : "Inside";
            return src ? [{ caption, src, title: hostel?.name ?? "Hostel photo" }] : [];
          }),
      [hostel],
    );

    const documentViews = useMemo(
      () =>
        documents.map((document) => ({
          document,
          kind: documentKind(document),
          src: assetHref(document.fileAssetId, document.fileUrl),
        })),
      [documents],
    );

    const documentItems = useMemo<LightboxItem[]>(
      () =>
        documentViews.flatMap<LightboxItem>(({ document, kind, src }) =>
          src && kind !== "file"
            ? [
                {
                  caption: `Uploaded ${formatTimestamp(document.createdAt)}`,
                  kind,
                  src,
                  title: document.documentType,
                },
              ]
            : [],
        ),
      [documentViews],
    );

    const snapshot = useMemo(() => {
      const groups = snapshotGroups(application?.snapshot ?? {}, hostel);
      const changes = groups.reduce(
        (total, group) =>
          total +
          (group.kind === "fields"
            ? group.cells.filter((cell) => cell.now).length
            : group.rows.flat().filter((cell) => cell.now).length),
        0,
      );
      return { changes, groups };
    }, [application, hostel]);

    function openLightbox(items: LightboxItem[], index: number) {
      setLightboxItems(items);
      setLightboxIndex(index);
    }

    if (!hostel) {
      return (
        <div className="mx-auto max-w-[1200px] space-y-4">
          <PortalPageHeader
            breadcrumb={[
              { href: "/platform/dashboard", label: "Home" },
              { href: "/platform/hostels", label: "Hostel Approvals" },
              "Review",
            ]}
            description="Review the owner's submission, paperwork, and photos before deciding."
            title="Hostel Review"
          />
          <Message value={message} />
          {message ? (
            <EmptyState label="Hostel detail is not loaded." />
          ) : (
            <LoadingRows />
          )}
        </div>
      );
    }

    const owner = detail?.owner ?? null;
    const people = [
      owner ? { contact: owner, label: "Owner" } : null,
      detail?.submitter && detail.submitter.id !== owner?.id
        ? { contact: detail.submitter, label: "Filed by" }
        : null,
      detail?.applicant &&
      detail.applicant.id !== owner?.id &&
      detail.applicant.id !== detail.submitter?.id
        ? { contact: detail.applicant, label: "Applicant" }
        : null,
    ].filter(
      (person): person is { contact: NonNullable<Contact>; label: string } =>
        person !== null,
    );

    const events: Array<{
      at?: string | null;
      label: string;
      note?: string;
      tone: "base" | "bad" | "good" | "warn";
    }> = [
      { at: owner?.registeredAt, label: "Owner account created", tone: "base" },
      {
        at: application?.submittedAt,
        label: "Application submitted",
        note: application?.notes,
        tone: "base",
      },
      {
        at: application?.infoRequestedAt,
        label: "More documents requested",
        note: application?.infoRequestNote,
        tone: "warn",
      },
      {
        at: application?.reviewedAt,
        label:
          application?.status === "REJECTED"
            ? "Rejected"
            : application?.status === "APPROVED"
              ? "Approved"
              : "Reviewed",
        note: application?.rejectionReason,
        tone: application?.status === "REJECTED" ? "bad" : "good",
      },
    ];
    const trail = events
      .filter((event) => event.at)
      .sort((a, b) => Date.parse(a.at ?? "") - Date.parse(b.at ?? ""));

    const rooms = hostel.roomConfigurations ?? [];
    const rentMin = hostel.pricing?.monthlyRentMin;
    const rentMax = hostel.pricing?.monthlyRentMax;
    const rent =
      rentMin && rentMax && rentMin !== rentMax
        ? `${currency(rentMin)} – ${currency(rentMax).replace(/^[^\d]+/, "")}`
        : rentMin || rentMax
          ? currency((rentMin || rentMax) as number)
          : "—";
    const { lat, lng } = hostel.location;

    const tabs = [
      { key: "overview", label: "Overview" },
      { key: "listing", label: "Listing" },
      { key: "original", label: "Original form" },
      { count: photoItems.length, key: "photos", label: "Photos" },
      { count: documents.length, key: "documents", label: "Documents" },
    ];

    return (
      <div className="mx-auto max-w-[1200px] space-y-4">
        <PortalPageHeader
          actions={
            headerActions.length > 0 ? (
              <>
                {headerActions.includes("approve") ? (
                  <RoleButton
                    disabled={busy}
                    onClick={() => void action("approve")}
                    tone="platform"
                  >
                    <Check className="size-3.5" />
                    Approve
                  </RoleButton>
                ) : null}
                {headerActions.includes("request-documents") ? (
                  <RoleButton
                    disabled={busy}
                    onClick={() => void action("request-documents")}
                    tone="platform"
                    variant="outline"
                  >
                    <FileText className="size-3.5" />
                    Request docs
                  </RoleButton>
                ) : null}
                {headerActions.includes("reject") ? (
                  <RoleButton
                    disabled={busy}
                    onClick={() => void action("reject")}
                    tone="platform"
                    variant="outline"
                  >
                    <X className="size-3.5" />
                    Reject
                  </RoleButton>
                ) : null}
              </>
            ) : undefined
          }
          breadcrumb={[
            { href: "/platform/dashboard", label: "Home" },
            { href: "/platform/hostels", label: "Hostel Approvals" },
            hostel.name,
          ]}
          description="Everything the owner submitted, their identity, uploaded paperwork, and listing photos."
          title={hostel.name}
        />
        <Message value={message} />

        {detail?.branchOf ? (
          <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
            <p className="font-semibold text-foreground">
              Branch of {detail.branchOf.name} — free on its Max plan. Approve only after calling
              the branch.
            </p>
            <dl className="mt-2 grid gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-2">
              <div>
                <dt className="inline text-muted-foreground">Call the branch: </dt>
                <dd className="inline font-semibold">
                  {hostel.contact?.phone ? (
                    <a className="underline" href={`tel:${hostel.contact.phone}`}>
                      {hostel.contact.phone}
                    </a>
                  ) : (
                    "no phone given"
                  )}
                </dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">Main hostel phone: </dt>
                <dd className="inline font-semibold">{detail.branchOf.phone || "—"}</dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">PAN/VAT (must match): </dt>
                <dd className="inline font-mono font-semibold">
                  {hostel.panNumber ?? "—"} · main {detail.branchOf.panNumber ?? "none on file"}
                </dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">Payout holder: </dt>
                <dd className="inline font-semibold">
                  {detail.branchOf.payoutHolder ?? "—"}
                  {detail.branchOf.payoutVerified ? " (verified on the main hostel)" : " (main not verified)"}
                </dd>
              </div>
            </dl>
            <p className="mt-2 text-[12px] text-muted-foreground">
              Check the PAN/VAT certificate under Documents against the main hostel&apos;s. Only a
              superadmin can approve a branch.
            </p>
          </section>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <SoftBadge tone={statusToneFromLabel(hostel.status)}>
            Listing: {hostel.status.replaceAll("_", " ")}
          </SoftBadge>
          <SoftBadge tone={statusToneFromLabel(hostel.verificationStatus)}>
            KYC: {hostel.verificationStatus.replaceAll("_", " ")}
          </SoftBadge>
          {application ? (
            <SoftBadge tone={statusToneFromLabel(application.status)}>
              Application: {application.status.replaceAll("_", " ")}
            </SoftBadge>
          ) : null}
          <span className="text-[11.5px] text-muted-foreground">
            Submitted {formatTimestamp(application?.submittedAt)}
          </span>
          {hostel.status === "PUBLISHED" ? (
            <RoleButton
              className="ml-auto"
              disabled={busy}
              onClick={() => void action("unpublish")}
              tone="platform"
              variant="outline"
            >
              <EyeOff className="size-3.5" />
              Unpublish
            </RoleButton>
          ) : hostel.status === "APPROVED" ? (
            <RoleButton
              className="ml-auto"
              disabled={busy}
              onClick={() => void action("publish")}
              tone="platform"
            >
              <Globe className="size-3.5" />
              Publish
            </RoleButton>
          ) : null}
        </div>

        <TabBar onChange={setTab} tabs={tabs} value={tab} />

        {/* ── Who is behind it, and what has happened so far ───────── */}
        {tab === "overview" ? (
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="space-y-3">
              <SectionCard title="People">
                {people.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">
                    The owner account could not be found.
                  </p>
                ) : (
                  people.map((person) => (
                    <PersonRow
                      contact={person.contact}
                      key={`${person.label}-${person.contact.id}`}
                      label={person.label}
                    />
                  ))
                )}
              </SectionCard>

              <SectionCard title="Booking payouts">
                <ReviewPayoutAccount hostelId={params.id} />
              </SectionCard>
            </div>

            <SectionCard title="Review trail">
              {trail.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">Nothing recorded yet.</p>
              ) : (
                <ol className="space-y-4 border-l border-border pl-4">
                  {trail.map((event) => (
                    <li className="relative" key={event.label}>
                      <span
                        className={cn(
                          "absolute -left-[21.5px] top-1 size-2.5 rounded-full ring-4 ring-card",
                          event.tone === "bad"
                            ? "bg-rose-500"
                            : event.tone === "warn"
                              ? "bg-amber-500"
                              : event.tone === "good"
                                ? "bg-role-platform"
                                : "bg-muted-foreground/50",
                        )}
                      />
                      <p className="text-[12.5px] font-semibold text-foreground">
                        {event.label}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {formatTimestamp(event.at)}
                      </p>
                      {event.note ? (
                        <p className="mt-1 rounded-md bg-muted/50 px-2 py-1.5 text-[11.5px] text-foreground">
                          {event.note}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </SectionCard>
          </div>
        ) : null}

        {/* ── The live listing, as the public sees it ────────────── */}
        {tab === "listing" ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Type" value={humanizeEnum(hostel.hostelType)} />
              <Stat label="Rooms" value={hostel.capacitySummary?.totalRooms ?? "—"} />
              <Stat label="Beds" value={hostel.capacitySummary?.totalBeds ?? "—"} />
              <Stat label="Vacant beds" value={hostel.capacitySummary?.vacantBeds ?? "—"} />
              <Stat label="Meals a day" value={hostel.food?.mealsPerDay ?? "—"} />
              <Stat label="Rent a month" value={rent} />
            </div>

            {rooms.length > 0 ? (
              <SectionCard title="Rate card">
                <div className="-mx-1 overflow-x-auto">
                  <DataTable className="min-w-[560px]">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <Th>Room type</Th>
                        <Th align="right">Rooms</Th>
                        <Th align="right">Beds / room</Th>
                        <Th align="right">Vacant beds</Th>
                        <Th>Meals</Th>
                        <Th align="right">Rent a month</Th>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rooms.map((room) => (
                        <TableRow key={room.roomType}>
                          <TableCell className="font-semibold text-foreground">
                            {room.roomType}
                          </TableCell>
                          <TableCell className="text-right">{room.rooms}</TableCell>
                          <TableCell className="text-right">{room.bedsPerRoom}</TableCell>
                          <TableCell className="text-right">{room.vacantBeds}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {room.mealInclusion}
                          </TableCell>
                          <TableCell className="text-right font-semibold text-foreground">
                            {currency(room.monthlyRent)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </DataTable>
                </div>
              </SectionCard>
            ) : null}

            <div className="grid gap-3 lg:grid-cols-2">
              <SectionCard title="Listing">
                <Facts
                  items={[
                    { label: "Hostel name", value: hostel.name },
                    { label: "Slug", value: hostel.slug },
                    {
                      label: "Room types",
                      value: hostel.roomTypes.join(", ") || "—",
                    },
                    {
                      label: "Floors",
                      value: hostel.totalFloors ? hostel.totalFloors : "—",
                    },
                  ]}
                />
              </SectionCard>

              <SectionCard title="Location & contact">
                <Facts
                  items={[
                    { label: "Area", value: hostel.location.area || "—" },
                    { label: "City", value: hostel.location.city || "—" },
                    { label: "Address", value: hostel.location.address || "—" },
                    {
                      label: "Map pin",
                      value:
                        lat != null && lng != null ? (
                          <a
                            className="inline-flex items-center gap-1 text-role-platform hover:underline"
                            href={`https://www.google.com/maps?q=${lat},${lng}`}
                            rel="noreferrer"
                            target="_blank"
                          >
                            <MapPin className="size-3.5" />
                            Open in Maps
                          </a>
                        ) : (
                          "—"
                        ),
                    },
                    {
                      label: "Hostel phone",
                      value: hostel.contact?.phone ? (
                        <a
                          className="text-role-platform hover:underline"
                          href={`tel:${hostel.contact.phone}`}
                        >
                          {hostel.contact.phone}
                        </a>
                      ) : (
                        "—"
                      ),
                    },
                    {
                      label: "Hostel email",
                      value: hostel.contact?.email ? (
                        <a
                          className="text-role-platform hover:underline"
                          href={`mailto:${hostel.contact.email}`}
                        >
                          {hostel.contact.email}
                        </a>
                      ) : (
                        "—"
                      ),
                    },
                  ]}
                />
              </SectionCard>
            </div>

            <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <SectionCard title="Description">
                <p className="text-[13px] leading-6 text-foreground">
                  {hostel.description || (
                    <span className="text-muted-foreground">No description.</span>
                  )}
                </p>
              </SectionCard>

              <SectionCard title="Food">
                <Facts
                  items={[
                    { label: "Vegetarian", value: hostel.food?.hasVeg ? "Yes" : "No" },
                    {
                      label: "Non-vegetarian",
                      value: hostel.food?.hasNonVeg ? "Yes" : "No",
                    },
                    { label: "Notes", value: hostel.food?.notes || "—" },
                  ]}
                />
              </SectionCard>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <SectionCard title={`Facilities · ${hostel.facilities.length}`}>
                {hostel.facilities.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">None listed.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {hostel.facilities.map((facility) => (
                      <SoftBadge key={facility} tone="teal">
                        {facility}
                      </SoftBadge>
                    ))}
                  </div>
                )}
              </SectionCard>

              <SectionCard title={`House rules · ${hostel.rules.length}`}>
                {hostel.rules.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">None listed.</p>
                ) : (
                  <ol className="space-y-2">
                    {hostel.rules.map((rule, index) => (
                      <li className="flex gap-2.5 text-[12.5px] text-foreground" key={rule}>
                        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-role-platform-soft text-[10.5px] font-bold text-role-platform">
                          {index + 1}
                        </span>
                        <span className="pt-px">{rule}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </SectionCard>
            </div>
          </div>
        ) : null}

        {/* ── What the owner typed, frozen at submission ───────────── */}
        {tab === "original" ? (
          snapshot.groups.length === 0 ? (
            <EmptyState label="No form submission was stored for this hostel." />
          ) : (
            <div className="space-y-3">
              <div
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-medium",
                  snapshot.changes > 0
                    ? "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300"
                    : "border-border bg-muted/30 text-muted-foreground",
                )}
              >
                {snapshot.changes > 0 ? (
                  <History className="size-4 shrink-0" />
                ) : (
                  <CircleCheck className="size-4 shrink-0 text-role-platform" />
                )}
                {snapshot.changes > 0
                  ? `${snapshot.changes} value${snapshot.changes === 1 ? " has" : "s have"} changed since the owner submitted.`
                  : "Nothing has changed since the owner submitted."}
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {snapshot.groups.map((group) =>
                  group.kind === "fields" ? (
                    <SectionCard key={group.title} title={group.title}>
                      <Facts
                        items={group.cells.map((cell) => ({
                          label: cell.label,
                          value: <SnapshotValue cell={cell} />,
                        }))}
                      />
                    </SectionCard>
                  ) : null,
                )}
              </div>

              {snapshot.groups.map((group) =>
                group.kind === "table" ? (
                  <SectionCard key={group.title} title={group.title}>
                    <div className="-mx-1 overflow-x-auto">
                      <DataTable>
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            {group.columns.map((column) => (
                              <Th key={column.key}>{column.label}</Th>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {group.rows.map((row, rowIndex) => (
                            <TableRow key={rowIndex}>
                              {row.map((cell, cellIndex) => (
                                <TableCell
                                  className="align-top"
                                  key={group.columns[cellIndex]?.key}
                                >
                                  <SnapshotValue cell={cell} />
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </DataTable>
                    </div>
                  </SectionCard>
                ) : null,
              )}
            </div>
          )
        ) : null}

        {/* ── Photos with in-site lightbox ───────────────────────── */}
        {tab === "photos" ? (
          photoItems.length === 0 ? (
            <SectionCard>
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <ImageOff className="size-5" />
                </span>
                <p className="text-[13px] font-semibold text-foreground">
                  No photos uploaded
                </p>
                <p className="text-[11.5px] text-muted-foreground">
                  A listing without photos should not be published.
                </p>
              </div>
            </SectionCard>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {photoItems.map((item, index) => (
                <button
                  className="group relative aspect-[4/3] overflow-hidden rounded-xl border border-border bg-muted transition hover:border-role-platform/50"
                  key={`${item.src}-${index}`}
                  onClick={() => openLightbox(photoItems, index)}
                  type="button"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- remote
                      R2 asset behind a redirecting presign route. */}
                  <img
                    alt={`${hostel.name} — ${item.caption}`}
                    className="size-full object-cover transition group-hover:scale-[1.03]"
                    loading="lazy"
                    src={item.src}
                  />
                  <span className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[10.5px] font-semibold text-white">
                    {item.caption}
                  </span>
                </button>
              ))}
            </div>
          )
        ) : null}

        {/* ── Uploaded paperwork, shown in place ──────────────────── */}
        {tab === "documents" ? (
          <div className="space-y-3">
            {requestedDocuments.length > 0 ? (
              <SectionCard
                actions={
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Clock3 className="size-3" />
                    {formatTimestamp(application?.infoRequestedAt)}
                  </span>
                }
                title="Requested from owner"
              >
                <ul className="space-y-1.5">
                  {requestedDocuments.map((document, index) => (
                    <li
                      className="flex items-start gap-2 text-[12.5px]"
                      key={`${document.documentType}-${index}`}
                    >
                      <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-amber-500" />
                      <span>
                        <span className="font-semibold text-foreground">
                          {document.documentType}
                        </span>
                        {document.note ? (
                          <span className="text-muted-foreground"> — {document.note}</span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            ) : null}

            {documentViews.length === 0 ? (
              <EmptyState label="No documents were uploaded for this hostel." />
            ) : (
              <div
                className={cn("grid gap-3", documentViews.length > 1 && "lg:grid-cols-2")}
              >
                {documentViews.map(({ document, kind, src }) => {
                  const lightboxAt = documentItems.findIndex((item) => item.src === src);

                  return (
                    <SectionCard
                      actions={
                        <SoftBadge tone={statusToneFromLabel(document.status)}>
                          {document.status.replaceAll("_", " ")}
                        </SoftBadge>
                      }
                      key={document.id}
                      title={document.documentType}
                    >
                      {!src ? (
                        <p className="rounded-lg bg-muted/40 py-10 text-center text-[12px] text-muted-foreground">
                          No file attached.
                        </p>
                      ) : kind === "pdf" ? (
                        <iframe
                          className="h-[560px] w-full rounded-lg border border-border bg-muted/40"
                          src={src}
                          title={document.documentType}
                        />
                      ) : kind === "image" ? (
                        <button
                          className="group relative block w-full overflow-hidden rounded-lg border border-border bg-muted/40"
                          onClick={() => openLightbox(documentItems, lightboxAt)}
                          type="button"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element -- remote
                              R2 asset behind a redirecting presign route. */}
                          <img
                            alt={document.documentType}
                            className="mx-auto max-h-[560px] w-full object-contain"
                            src={src}
                          />
                          <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[10.5px] font-semibold text-white opacity-0 transition group-hover:opacity-100">
                            <Maximize2 className="size-3" />
                            Zoom
                          </span>
                        </button>
                      ) : (
                        <div className="flex flex-col items-center gap-2 rounded-lg bg-muted/40 py-10 text-center">
                          <FileText className="size-8 text-muted-foreground" />
                          <p className="text-[12px] text-muted-foreground">
                            {document.fileName || "This file"} can&apos;t be previewed.
                          </p>
                        </div>
                      )}

                      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
                        <span>Uploaded {formatTimestamp(document.createdAt)}</span>
                        {document.fileName ? (
                          <span className="min-w-0 truncate">{document.fileName}</span>
                        ) : null}
                        {src ? (
                          kind === "file" ? (
                            <a
                              className="ml-auto inline-flex items-center gap-1 font-semibold text-role-platform hover:underline"
                              href={src}
                              rel="noreferrer"
                              target="_blank"
                            >
                              <ExternalLink className="size-3.5" />
                              Open file
                            </a>
                          ) : (
                            <button
                              className="ml-auto inline-flex items-center gap-1 font-semibold text-role-platform hover:underline"
                              onClick={() => openLightbox(documentItems, lightboxAt)}
                              type="button"
                            >
                              <Maximize2 className="size-3.5" />
                              Full screen
                            </button>
                          )
                        ) : null}
                      </div>
                      {document.rejectionReason ? (
                        <p className="mt-1.5 text-[11.5px] font-medium text-rose-600 dark:text-rose-400">
                          {document.rejectionReason}
                        </p>
                      ) : null}
                    </SectionCard>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}

        {lightboxIndex !== null ? (
          <MediaLightbox
            index={lightboxIndex}
            items={lightboxItems}
            onClose={() => setLightboxIndex(null)}
            onIndexChange={setLightboxIndex}
          />
        ) : null}
      </div>
    );
  },
);
