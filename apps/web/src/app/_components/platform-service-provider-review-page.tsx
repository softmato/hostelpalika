"use client";

import { formatHostelDateTime } from "@hostel/shared/calendar/bs";

import {
  BadgeCheck,
  Check,
  EyeOff,
  FileText,
  ImageOff,
  Loader2,
  Mail,
  Phone,
  X,
} from "@/components/icons";
import { memo, useCallback, useMemo, useState } from "react";
import { useParams } from "next/navigation";

import { EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import {
  DataTable,
  DetailField,
  DetailSection,
  PortalPageHeader,
  RoleButton,
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
import { browserApi } from "@/lib/browser-api";
import { platformEndpoints } from "@/lib/platform-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { Message, type ServiceProvider } from "./portal-shared";

type ProviderDocument = {
  createdAt: string | null;
  documentType: string;
  fileAssetId: string | null;
  fileUrl: string;
  id: string;
  status: string;
};

type ProviderApplication = {
  id: string;
  rejectionReason: string;
  status: string;
  submittedAt: string | null;
} | null;

type ProviderDetail = {
  application: ProviderApplication;
  documents: ProviderDocument[];
  provider: ServiceProvider & {
    approvedAt?: string;
    createdAt?: string;
    rejectionReason?: string;
    updatedAt?: string;
  };
};

const TABS = [
  { key: "application", label: "Application" },
  { key: "photo", label: "Photo" },
  { key: "documents", label: "Documents" },
];

/**
 * The registration form uploads the applicant's headshot as a document with this
 * type, because the public upload route hands back URLs rather than FileAsset
 * ids and so cannot populate `photoAssetId`. Splitting it out here keeps the
 * Photo tab meaningful and the Documents tab about paperwork.
 */
const PHOTO_DOCUMENT_TYPE = "PROFILE_PHOTO";

/** Present-tense labels shown while a moderation request is still in flight. */
const ACTION_PROGRESS = {
  approve: "Approving",
  hide: "Hiding",
  reject: "Rejecting",
} as const;

/**
 * Approve/hide/reject are status-dependent, mirroring the moderation actions the
 * list view offers so the two screens can never disagree about what is possible.
 */
function headerActionsForStatus(status: string): Array<"approve" | "hide" | "reject"> {
  switch (status) {
    case "PENDING_APPROVAL":
      return ["approve", "reject"];
    case "APPROVED":
      return ["hide", "reject"];
    case "REJECTED":
    case "HIDDEN":
    case "INACTIVE":
      return ["approve"];
    default:
      return [];
  }
}

/**
 * A FileAsset id routes through the auth-gated presign endpoint, which
 * 302-redirects to a short-lived R2 URL. Public-form uploads only ever stored a
 * raw `fileUrl`, so that is the fallback.
 */
function assetHref(fileAssetId?: string | null, fileUrl?: string) {
  if (fileAssetId) {
    return `/api/v1/files/${fileAssetId}/url`;
  }
  return fileUrl || null;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : formatHostelDateTime(date);
}

function humanize(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((word, index) =>
      index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word,
    )
    .join(" ");
}

function categoryLabel(category: string) {
  return category
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

export const PlatformServiceProviderReviewPageContent = memo(
  function PlatformServiceProviderReviewPageContent() {
    const params = useParams<{ id: string }>();
    const [actionMessage, setActionMessage] = useState("");
    /** Which action is in flight — drives the per-button spinner and label. */
    const [busy, setBusy] = useState<"approve" | "hide" | "reject" | null>(null);
    const [tab, setTab] = useState("application");
    const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
    const [lightboxItems, setLightboxItems] = useState<LightboxItem[]>([]);

    const invalidate = useInvalidateResources();
    // Same cache entry the Service Providers list opens its review rail from, so
    // arriving here from that screen paints immediately.
    const detailResource = usePortalResource<ProviderDetail>(
      platformEndpoints.serviceProvider(params.id),
      { errorMessage: "Could not load this application." },
    );

    const detail = detailResource.data ?? null;
    const message = actionMessage || detailResource.message;

    const action = useCallback(
      async (nextAction: "approve" | "hide" | "reject") => {
        let body = JSON.stringify({});

        if (nextAction === "reject") {
          // Required — the applicant is emailed this reason verbatim.
          const reason = window
            .prompt("Why is this application being rejected? The applicant sees this.")
            ?.trim();
          if (!reason) return;
          body = JSON.stringify({ reason });
        }

        // The PATCH plus its refetch can run for seconds; without visible
        // progress the button reads as broken and gets clicked twice.
        setBusy(nextAction);
        setActionMessage(`${ACTION_PROGRESS[nextAction]}…`);

        try {
          await browserApi(
            `${platformEndpoints.serviceProvider(params.id)}/${nextAction}`,
            { body, method: "PATCH" },
          );
          setActionMessage(`Provider ${nextAction}d.`);
          invalidate(
            platformEndpoints.serviceProvider(params.id),
            platformEndpoints.serviceProviders,
          );
        } catch (error) {
          setActionMessage(error instanceof Error ? error.message : "Action failed.");
        } finally {
          setBusy(null);
        }
      },
      [invalidate, params.id],
    );

    const provider = detail?.provider ?? null;
    const headerActions = headerActionsForStatus(provider?.status ?? "");
    const allDocuments = useMemo(() => detail?.documents ?? [], [detail]);

    const photoDocuments = useMemo(
      () =>
        allDocuments.filter((document) => document.documentType === PHOTO_DOCUMENT_TYPE),
      [allDocuments],
    );
    const paperwork = useMemo(
      () =>
        allDocuments.filter((document) => document.documentType !== PHOTO_DOCUMENT_TYPE),
      [allDocuments],
    );

    const trades = useMemo(
      () =>
        provider
          ? provider.categories?.length
            ? provider.categories
            : [provider.category]
          : [],
      [provider],
    );

    // flatMap rather than map+filter so documents with no file drop out without
    // needing a type predicate to strip the nulls back off.
    const photoItems = useMemo<LightboxItem[]>(
      () =>
        photoDocuments.flatMap<LightboxItem>((document) => {
          const src = assetHref(document.fileAssetId, document.fileUrl);
          return src ? [{ src, title: provider?.fullName ?? "Provider photo" }] : [];
        }),
      [photoDocuments, provider],
    );

    const documentItems = useMemo<LightboxItem[]>(
      () =>
        paperwork.flatMap<LightboxItem>((document) => {
          const src = assetHref(document.fileAssetId, document.fileUrl);
          return src
            ? [
                {
                  caption: `Uploaded ${formatTimestamp(document.createdAt)}`,
                  src,
                  title: humanize(document.documentType),
                },
              ]
            : [];
        }),
      [paperwork],
    );

    function openLightbox(items: LightboxItem[], index: number) {
      setLightboxItems(items);
      setLightboxIndex(index);
    }

    if (!provider) {
      return (
        <div className="mx-auto max-w-[1200px] space-y-4">
          <PortalPageHeader
            breadcrumb={[
              { href: "/platform/dashboard", label: "Home" },
              { href: "/platform/service-providers", label: "Service Providers" },
              "Review",
            ]}
            description="Review the applicant's trade details and paperwork before deciding."
            title="Provider Review"
          />
          <Message value={message} />
          {message ? (
            <EmptyState label="Provider application is not loaded." />
          ) : (
            <LoadingRows />
          )}
        </div>
      );
    }

    return (
      <div className="mx-auto max-w-[1200px] space-y-4">
        <PortalPageHeader
          actions={
            headerActions.length > 0 ? (
              <>
                {headerActions.includes("approve") ? (
                  <RoleButton
                    disabled={Boolean(busy)}
                    onClick={() => void action("approve")}
                    tone="platform"
                  >
                    {busy === "approve" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Check className="size-3.5" />
                    )}
                    {busy === "approve" ? "Approving…" : "Approve"}
                  </RoleButton>
                ) : null}
                {headerActions.includes("hide") ? (
                  <RoleButton
                    disabled={Boolean(busy)}
                    onClick={() => void action("hide")}
                    tone="platform"
                    variant="outline"
                  >
                    {busy === "hide" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <EyeOff className="size-3.5" />
                    )}
                    {busy === "hide" ? "Hiding…" : "Hide"}
                  </RoleButton>
                ) : null}
                {headerActions.includes("reject") ? (
                  <RoleButton
                    disabled={Boolean(busy)}
                    onClick={() => void action("reject")}
                    tone="platform"
                    variant="outline"
                  >
                    {busy === "reject" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <X className="size-3.5" />
                    )}
                    {busy === "reject" ? "Rejecting…" : "Reject"}
                  </RoleButton>
                ) : null}
              </>
            ) : undefined
          }
          breadcrumb={[
            { href: "/platform/dashboard", label: "Home" },
            { href: "/platform/service-providers", label: "Service Providers" },
            provider.fullName,
          ]}
          description="Everything the applicant submitted, their trades, and the paperwork backing it up."
          title={provider.fullName}
        />
        <Message value={message} />

        <div className="flex flex-wrap items-center gap-2">
          <SoftBadge tone={statusToneFromLabel(provider.status)}>
            {humanize(provider.status)}
          </SoftBadge>
          {trades.filter(Boolean).map((trade) => (
            <SoftBadge key={trade} tone="teal">
              {categoryLabel(trade)}
            </SoftBadge>
          ))}
          <span className="text-[11.5px] text-muted-foreground">
            Submitted{" "}
            {formatTimestamp(detail?.application?.submittedAt ?? provider.createdAt)}
          </span>
        </div>

        <Panel>
          <TabBar
            className="mb-3"
            onChange={setTab}
            tabs={TABS.map((item) =>
              item.key === "documents"
                ? { ...item, count: paperwork.length }
                : item.key === "photo"
                  ? { ...item, count: photoItems.length }
                  : item,
            )}
            value={tab}
          />

          {/* ── What the applicant typed into the form ─────────────── */}
          {tab === "application" ? (
            <div className="grid gap-3 lg:grid-cols-2">
              <DetailSection title="Applicant">
                <DetailField label="Full name" value={provider.fullName} />
                <DetailField label="Phone" value={provider.phone || "—"} />
                <DetailField label="Email" value={provider.email || "—"} />
                <DetailField
                  label="Submitted on"
                  value={formatTimestamp(provider.createdAt)}
                />
              </DetailSection>

              <DetailSection title="Trade">
                <DetailField
                  label={trades.length > 1 ? "Trades" : "Trade"}
                  value={trades.filter(Boolean).map(categoryLabel).join(", ") || "—"}
                />
                <DetailField
                  label="Main trade"
                  value={categoryLabel(provider.category)}
                />
                <DetailField label="Service area" value={provider.area || "—"} />
                <DetailField label="City" value={provider.city || "—"} />
                <DetailField label="Availability" value={provider.availability || "—"} />
                <DetailField label="Experience" value={provider.experience || "—"} />
              </DetailSection>

              <DetailSection title="Review Trail">
                <DetailField
                  label="Application status"
                  value={
                    detail?.application?.status
                      ? humanize(detail.application.status)
                      : humanize(provider.status)
                  }
                />
                <DetailField
                  label="Approved on"
                  value={formatTimestamp(provider.approvedAt)}
                />
                <DetailField
                  label="Last updated"
                  value={formatTimestamp(provider.updatedAt)}
                />
                {provider.rejectionReason ? (
                  <DetailField
                    label="Rejection reason"
                    value={provider.rejectionReason}
                  />
                ) : null}
              </DetailSection>

              <DetailSection title="Quick Contact">
                <div className="flex flex-wrap gap-2 pt-1">
                  {provider.phone ? (
                    <RoleButton asChild tone="platform" variant="outline">
                      <a href={`tel:${provider.phone}`}>
                        <Phone className="size-3.5" />
                        Call applicant
                      </a>
                    </RoleButton>
                  ) : null}
                  {provider.email ? (
                    <RoleButton asChild tone="platform" variant="outline">
                      <a href={`mailto:${provider.email}`}>
                        <Mail className="size-3.5" />
                        Email applicant
                      </a>
                    </RoleButton>
                  ) : null}
                </div>
              </DetailSection>

              {provider.description ? (
                <div className="lg:col-span-2">
                  <DetailSection title="Description">
                    <p className="py-1 text-[11.5px] leading-5 text-muted-foreground">
                      {provider.description}
                    </p>
                  </DetailSection>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* ── Headshot, with the same in-site lightbox ───────────── */}
          {tab === "photo" ? (
            photoItems.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <ImageOff className="size-5" />
                </span>
                <p className="text-[13px] font-semibold text-foreground">
                  No photo uploaded
                </p>
                <p className="text-[11.5px] text-muted-foreground">
                  A provider without a photo cannot be identified at the hostel gate.
                </p>
              </div>
            ) : (
              <>
                <p className="mb-2.5 text-[11.5px] text-muted-foreground">
                  Click to open full size.
                </p>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
                  {photoItems.map((item, index) => (
                    <button
                      className="group relative aspect-[4/3] overflow-hidden rounded-lg border border-border bg-muted transition hover:border-role-platform/50"
                      key={`${item.src}-${index}`}
                      onClick={() => openLightbox(photoItems, index)}
                      type="button"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- remote
                          R2 asset behind a redirecting presign route. */}
                      <img
                        alt={`${provider.fullName} photo ${index + 1}`}
                        className="size-full object-cover transition group-hover:scale-[1.03]"
                        loading="lazy"
                        src={item.src}
                      />
                    </button>
                  ))}
                </div>
              </>
            )
          ) : null}

          {/* ── Uploaded paperwork ─────────────────────────────────── */}
          {tab === "documents" ? (
            paperwork.length === 0 ? (
              <EmptyState label="No documents were attached to this application." />
            ) : (
              <DataTable className="min-w-[620px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <Th>Document</Th>
                    <Th>Status</Th>
                    <Th>Uploaded</Th>
                    <Th align="right">File</Th>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paperwork.map((document) => {
                    const label = humanize(document.documentType);
                    const itemIndex = documentItems.findIndex(
                      (item) =>
                        item.caption ===
                          `Uploaded ${formatTimestamp(document.createdAt)}` &&
                        item.title === label,
                    );

                    return (
                      <TableRow key={document.id}>
                        <TableCell>
                          <div className="flex items-center gap-2 font-semibold text-foreground">
                            <FileText className="size-3.5 text-role-platform" />
                            {label}
                          </div>
                        </TableCell>
                        <TableCell>
                          <SoftBadge tone={statusToneFromLabel(document.status)}>
                            {humanize(document.status)}
                          </SoftBadge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatTimestamp(document.createdAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          {itemIndex === -1 ? (
                            <span className="text-[11.5px] text-muted-foreground">
                              No file
                            </span>
                          ) : (
                            <button
                              className="text-[11.5px] font-semibold text-role-platform transition hover:underline"
                              onClick={() => openLightbox(documentItems, itemIndex)}
                              type="button"
                            >
                              View
                            </button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </DataTable>
            )
          ) : null}
        </Panel>

        {provider.status === "APPROVED" ? (
          <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <BadgeCheck className="size-3.5 text-role-platform" />
            This provider is live and bookable by hostels.
          </p>
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
