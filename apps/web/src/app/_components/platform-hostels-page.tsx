"use client";

import {
  Archive,
  ArchiveRestore,
  BadgeCheck,
  Building2,
  Check,
  Clock3,
  ExternalLink,
  EyeOff,
  FileSearch,
  FileText,
  Fingerprint,
  Globe,
  ScanSearch,
  ShieldCheck,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useCallback, useMemo, useState } from "react";

import { EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import {
  DataTable,
  DetailField,
  DetailPanel,
  DetailSection,
  FilterBar,
  FilterSelect,
  InitialsAvatar,
  ListPager,
  MetricCard,
  PortalPageHeader,
  RoleButton,
  SearchField,
  SoftBadge,
  statusToneFromLabel,
  TabBar,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  Th,
} from "@/app/_components/portal-dashboard-ui";
import { browserApi } from "@/lib/browser-api";
import { platformEndpoints } from "@/lib/platform-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { DemoDataBadge, Hostel, Message } from "./core-portal-shared";

type ActionKey =
  | "approve"
  | "reject"
  | "request-documents"
  | "publish"
  | "unpublish"
  | "archive"
  | "restore";

type VerificationDocument = {
  createdAt: string | null;
  documentType: string;
  fileAssetId: string | null;
  fileUrl: string;
  id: string;
  rejectionReason: string;
  status: string;
};

type VerificationApplication = {
  id: string;
  infoRequestNote: string;
  rejectionReason: string;
  requestedDocuments: Array<{ documentType: string; note: string }>;
  status: string;
  submittedAt: string | null;
} | null;

type VerificationContact = {
  email: string;
  id: string;
  name: string;
  phone: string;
  registeredAt: string | null;
  role: string;
} | null;

type HostelDetail = {
  applicant: VerificationContact;
  application: VerificationApplication;
  documents: VerificationDocument[];
  hostel: Hostel;
  owner: VerificationContact;
  submitter: VerificationContact;
};

const ACTION_CONFIG: Record<
  ActionKey,
  { danger?: true; icon: LucideIcon; label: string; variant: "solid" | "outline" }
> = {
  approve: { icon: Check, label: "Approve", variant: "solid" },
  archive: { danger: true, icon: Archive, label: "Archive", variant: "outline" },
  publish: { icon: Globe, label: "Publish", variant: "solid" },
  reject: { icon: X, label: "Reject", variant: "outline" },
  "request-documents": { icon: FileText, label: "Request docs", variant: "outline" },
  restore: { icon: ArchiveRestore, label: "Restore", variant: "solid" },
  unpublish: { icon: EyeOff, label: "Unpublish", variant: "outline" },
};

/** Documents a hostel must supply before it can be marked verified. */
const REQUIRED_DOCUMENTS = [
  "Ownership proof",
  "Hostel registration / licence",
  "Owner citizenship",
  "Tax / PAN certificate",
];

/**
 * Approval and KYC are two readings of the same queue, so the tabs mix both
 * axes on purpose: four listing-status stages plus the cross-cutting document
 * queue, which can hold hostels sitting at any approval stage.
 */
const TABS = [
  { key: "PENDING", label: "Pending Approval" },
  { key: "KYC", label: "KYC Queue" },
  { key: "APPROVED", label: "Approved" },
  { key: "PUBLISHED", label: "Published" },
  { key: "REJECTED", label: "Rejected" },
  { key: "ALL", label: "All" },
  { key: "ARCHIVED", label: "Archived" },
];

/**
 * The Archived tab reads a different endpoint, not a different slice of the
 * same one — an archived hostel is excluded from every other platform read.
 */
const ARCHIVED_TAB = "ARCHIVED";

const PAGE_SIZE = 10;

const isAwaitingApproval = (hostel: Hostel) =>
  hostel.status === "PENDING_APPROVAL" || hostel.status === "DRAFT";

const isAwaitingKyc = (hostel: Hostel) =>
  hostel.verificationStatus === "PENDING" || hostel.verificationStatus === "UNDER_REVIEW";

function matchesTab(hostel: Hostel, tab: string) {
  switch (tab) {
    case "PENDING":
      return isAwaitingApproval(hostel);
    case "KYC":
      return isAwaitingKyc(hostel);
    case "APPROVED":
      return hostel.status === "APPROVED";
    case "PUBLISHED":
      return hostel.status === "PUBLISHED";
    case "REJECTED":
      return hostel.status === "REJECTED";
    case ARCHIVED_TAB:
      // The endpoint has already scoped this list to archived hostels; there
      // is nothing left to filter out.
      return true;
    default:
      return true;
  }
}

/**
 * Only the actions valid for a hostel's current status: approve/reject/publish
 * are one-way transitions, so e.g. showing "publish" on a hostel that's
 * already published (or "approve" on one already approved) is a no-op button,
 * not a real choice.
 */
function actionsForHostel(hostel: Hostel): ActionKey[] {
  // An archived hostel has exactly one thing that can be done to it here.
  // Approving or publishing something that is off the site and counting down
  // to erasure is not a decision the queue should offer.
  if (hostel.isArchived) {
    return ["restore"];
  }

  const review = ((): ActionKey[] => {
    switch (hostel.status) {
      case "DRAFT":
      case "PENDING_APPROVAL":
        return ["approve", "request-documents", "reject"];
      case "APPROVED":
        return ["publish", "reject"];
      case "PUBLISHED":
        return ["unpublish"];
      case "REJECTED":
        return ["approve", "request-documents"];
      default:
        return [];
    }
  })();

  // Archive is offered at every stage, last. A hostel can be a mistaken draft
  // as easily as a closed business.
  return [...review, "archive"];
}

/** Whole days left before the purge cron erases an archived hostel. */
function daysUntilPurge(purgeScheduledAt: string | null | undefined) {
  if (!purgeScheduledAt) return null;
  const due = new Date(purgeScheduledAt).getTime();
  if (Number.isNaN(due)) return null;
  return Math.max(0, Math.ceil((due - Date.now()) / (24 * 60 * 60 * 1000)));
}

function documentHref(document: VerificationDocument) {
  // FileAsset ids route through the auth-gated presign endpoint; legacy rows
  // that only stored a raw URL fall back to it directly.
  if (document.fileAssetId) {
    return `/api/v1/files/${document.fileAssetId}/url`;
  }
  return document.fileUrl || null;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export const PlatformHostelsPageContent = memo(function PlatformHostelsPageContent() {
  const router = useRouter();
  const [actionMessage, setActionMessage] = useState("");
  const [query, setQuery] = useState("");
  const [city, setCity] = useState("");
  const [tab, setTab] = useState("PENDING");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const showingArchived = tab === ARCHIVED_TAB;

  const invalidate = useInvalidateResources();
  const liveResource = usePortalResource<{ hostels: Hostel[] }>(
    platformEndpoints.hostels,
    { errorMessage: "Could not load hostels." },
  );
  // Fetched only once the Archived tab is opened. The queue this page exists
  // for is the live one, and archived hostels are dead weight on every other
  // tab's load.
  const archivedResource = usePortalResource<{ hostels: Hostel[] }>(
    showingArchived ? platformEndpoints.hostelsArchived : null,
    { errorMessage: "Could not load archived hostels." },
  );
  const hostelsResource = showingArchived ? archivedResource : liveResource;
  // Keyed by the selected id, so a detail response for a hostel the reviewer has
  // already clicked away from can never overwrite the open one — and clicking
  // back to a hostel seen earlier renders from cache instantly.
  const detailResource = usePortalResource<HostelDetail>(
    selectedId ? platformEndpoints.hostel(selectedId) : null,
    { errorMessage: "Could not load documents." },
  );

  const hostels = useMemo(
    () => hostelsResource.data?.hostels ?? [],
    [hostelsResource.data],
  );
  const state = hostelsResource.state;
  const detail = detailResource.data ?? null;
  const detailState = detailResource.state;
  const message = actionMessage || hostelsResource.message || detailResource.message;

  const action = useCallback(
    async (hostelId: string, nextAction: ActionKey) => {
      let body = JSON.stringify({});

      if (nextAction === "reject") {
        body = JSON.stringify({
          reason: window.prompt("Rejection reason") || "Rejected by platform owner.",
        });
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
        // Pulling a live listing is owner-visible, and the reason is quoted
        // verbatim in the email they receive — so it is required, not optional.
        const reason = window
          .prompt(
            "Why is this listing being unpublished? The owner will see this reason.",
          )
          ?.trim();
        if (!reason) return;
        body = JSON.stringify({ reason });
      } else if (nextAction === "archive") {
        const target = hostels.find((hostel) => hostel.id === hostelId);
        // Named confirmation before the reason, not after: the reason prompt
        // reads like paperwork, and paperwork is a bad place to discover you
        // are about to take a hostel off the platform.
        const confirmed = window.confirm(
          `Archive "${target?.name ?? "this hostel"}"?\n\nIt comes off the public site and out of its own portal immediately, and its staff and residents are signed out.\n\nIt can be restored for 60 days. After that it is erased permanently, along with its residents, invoices, payments and photos.`,
        );
        if (!confirmed) return;
        const reason = window
          .prompt("Why is this hostel being archived? (recorded in the audit log)")
          ?.trim();
        if (!reason) return;
        body = JSON.stringify({ reason });
      }

      setBusy(true);
      try {
        const result = await browserApi<{
          notification?: { reason?: string; sent: boolean; to?: string };
        }>(`${platformEndpoints.hostel(hostelId)}/${nextAction}`, {
          body,
          method: "PATCH",
        });

        // The action is saved either way, but the owner only knows if the email
        // actually left — surface that instead of a flat success.
        const notification = result?.notification;

        setActionMessage(
          notification && !notification.sent
            ? `Hostel ${nextAction} completed, but the owner was NOT emailed (${notification.reason ?? "unknown error"}). Contact ${notification.to ?? "the owner"} manually.`
            : `Hostel ${nextAction} action completed.`,
        );
        // Archiving and restoring move a hostel between the two lists, so both
        // have to be dropped — invalidating only the one on screen leaves the
        // other holding a hostel that is no longer in it.
        invalidate(
          platformEndpoints.hostels,
          platformEndpoints.hostelsArchived,
          platformEndpoints.hostel(hostelId),
        );
        // Its detail panel is about a hostel that just left this list.
        if (nextAction === "archive" || nextAction === "restore") {
          setSelectedId(null);
        }
      } catch (error) {
        setActionMessage(error instanceof Error ? error.message : "Action failed.");
      } finally {
        setBusy(false);
      }
    },
    [hostels, invalidate],
  );

  /**
   * Erase an archived hostel now rather than waiting out its 60 days.
   *
   * Guarded by typing the hostel's name, not an OK button. Nothing else in this
   * portal destroys data that cannot be recovered, and a confirm dialog is a
   * reflex — typing the name is the only guard that requires the reviewer to
   * have read which hostel they are on.
   */
  const purgeNow = useCallback(
    async (hostel: Hostel) => {
      const typed = window.prompt(
        `Erase "${hostel.name}" permanently?\n\nThis cannot be undone. Its residents, invoices, payments, complaints, photos and documents are deleted outright. Only the audit record survives.\n\nType the hostel's name to confirm:`,
      );

      if (typed?.trim() !== hostel.name) {
        if (typed !== null) {
          setActionMessage("Name did not match — nothing was erased.");
        }
        return;
      }

      setBusy(true);
      try {
        const result = await browserApi<{
          documentsDeleted: number;
          objectsDeleted: number;
        }>(platformEndpoints.hostel(hostel.id), { method: "DELETE" });

        setActionMessage(
          `"${hostel.name}" erased permanently — ${result?.documentsDeleted ?? 0} records and ${result?.objectsDeleted ?? 0} files.`,
        );
        setSelectedId(null);
        invalidate(
          platformEndpoints.hostels,
          platformEndpoints.hostelsArchived,
          platformEndpoints.hostel(hostel.id),
        );
      } catch (error) {
        setActionMessage(error instanceof Error ? error.message : "Erase failed.");
      } finally {
        setBusy(false);
      }
    },
    [invalidate],
  );

  const runDuplicateCheck = useCallback(async (hostelId: string) => {
    setBusy(true);
    try {
      await browserApi(`${platformEndpoints.hostel(hostelId)}/run-duplicate-check`, {
        body: JSON.stringify({}),
        method: "PATCH",
      });
      setActionMessage("Duplicate check finished — see Abuse Flags for any new matches.");
    } catch (error) {
      setActionMessage(
        error instanceof Error ? error.message : "Duplicate check failed.",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  // Always the live list, never the archived one. These four cards describe the
  // platform, and "Total Hostels: 3" meaning three *archived* hostels while the
  // Archived tab happens to be open is a number that lies.
  const liveHostels = useMemo(
    () => liveResource.data?.hostels ?? [],
    [liveResource.data],
  );

  const counts = useMemo(
    () => ({
      approvedLive: liveHostels.filter(
        (hostel) => hostel.status === "APPROVED" || hostel.status === "PUBLISHED",
      ).length,
      kycPending: liveHostels.filter(isAwaitingKyc).length,
      pendingApproval: liveHostels.filter(isAwaitingApproval).length,
      total: liveHostels.length,
    }),
    [liveHostels],
  );

  const cities = useMemo(
    () =>
      Array.from(
        new Set(hostels.map((hostel) => hostel.location.city).filter(Boolean)),
      ) as string[],
    [hostels],
  );

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();

    return hostels.filter((hostel) => {
      if (!matchesTab(hostel, tab)) return false;
      if (city && hostel.location.city !== city) return false;
      if (!term) return true;
      return `${hostel.name} ${hostel.slug} ${hostel.location.area} ${hostel.location.city ?? ""}`
        .toLowerCase()
        .includes(term);
    });
  }, [city, hostels, query, tab]);

  const paged = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page],
  );

  const tabCount = (key: string) => {
    // The archived count comes from its own list, and only once that list has
    // been fetched — counting the live one here would show a live total under
    // an "Archived" label.
    if (key === ARCHIVED_TAB) {
      return archivedResource.data?.hostels.length;
    }
    if (showingArchived) {
      return undefined;
    }
    return hostels.filter((hostel) => matchesTab(hostel, key)).length;
  };

  const selectedHostel = hostels.find((hostel) => hostel.id === selectedId) ?? null;
  const documents = detail?.documents ?? [];

  return (
    <div className="mx-auto max-w-[1448px] space-y-4">
      <PortalPageHeader
        breadcrumb={["Home", "Hostel Approvals"]}
        description="One queue for listing decisions and document KYC — read the paperwork, then approve, reject, publish, unpublish or archive."
        title="Hostel Approvals"
      />
      <Message value={message} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={Building2}
          label="Total Hostels"
          note="On the platform"
          tone="blue"
          value={counts.total}
        />
        <MetricCard
          icon={Clock3}
          label="Pending Approval"
          note="Awaiting a decision"
          noteTone="amber"
          tone="amber"
          value={counts.pendingApproval}
        />
        <MetricCard
          icon={FileSearch}
          label="KYC Pending"
          note="Documents to check"
          noteTone="cyan"
          tone="cyan"
          value={counts.kycPending}
        />
        <MetricCard
          icon={BadgeCheck}
          label="Approved & Live"
          note="Cleared for listing"
          noteTone="green"
          tone="green"
          value={counts.approvedLive}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.65fr_1fr]">
        <Panel>
          <TabBar
            className="mb-3"
            onChange={(next) => {
              setTab(next);
              setPage(1);
            }}
            tabs={TABS.map((item) => ({ ...item, count: tabCount(item.key) }))}
            value={tab}
          />

          <FilterBar>
            <SearchField
              onChange={(next) => {
                setQuery(next);
                setPage(1);
              }}
              placeholder="Search hostels by name or area..."
              value={query}
            />
            <FilterSelect
              defaultLabel="All Cities"
              onChange={(next) => {
                setCity(next);
                setPage(1);
              }}
              options={cities}
              value={city}
            />
          </FilterBar>

          {state === "loading" ? <LoadingRows /> : null}
          {state === "error" ? <EmptyState label="Hostels could not be loaded." /> : null}
          {state === "ready" && filtered.length === 0 ? (
            <EmptyState label="Nothing in this queue." />
          ) : null}

          {state === "ready" && filtered.length > 0 ? (
            <>
              <DataTable className="min-w-[620px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <Th>Hostel</Th>
                    <Th>Location</Th>
                    <Th>Listing</Th>
                    <Th>KYC Status</Th>
                    <Th align="right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paged.map((hostel) => (
                    <TableRow
                      className={
                        hostel.id === selectedId
                          ? "bg-role-platform-soft/40"
                          : "cursor-pointer"
                      }
                      key={hostel.id}
                      onClick={() => setSelectedId(hostel.id)}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <InitialsAvatar name={hostel.name} size="sm" tone="platform" />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <p className="truncate font-semibold text-foreground">
                                {hostel.name}
                              </p>
                              {hostel.isDemoData ? (
                                <DemoDataBadge label={hostel.demoDataLabel} />
                              ) : null}
                              {hostel.branchOf ? <SoftBadge tone="amber">BRANCH</SoftBadge> : null}
                            </div>
                            <p className="truncate text-[11px] text-muted-foreground">
                              {hostel.branchOf ? `Branch of ${hostel.branchOf.name}` : hostel.slug}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {hostel.location.area}
                        {hostel.location.city ? `, ${hostel.location.city}` : ""}
                      </TableCell>
                      <TableCell>
                        {hostel.isArchived ? (
                          <div className="space-y-0.5">
                            <SoftBadge tone="rose">ARCHIVED</SoftBadge>
                            <p className="text-[11px] text-muted-foreground">
                              {(() => {
                                const days = daysUntilPurge(hostel.purgeScheduledAt);
                                if (days === null) return "Not scheduled for erasure";
                                return days === 0
                                  ? "Erased on the next sweep"
                                  : `Erased in ${days} day${days === 1 ? "" : "s"}`;
                              })()}
                            </p>
                          </div>
                        ) : (
                          <SoftBadge tone={statusToneFromLabel(hostel.status)}>
                            {hostel.status.replaceAll("_", " ")}
                          </SoftBadge>
                        )}
                      </TableCell>
                      <TableCell>
                        <SoftBadge tone={statusToneFromLabel(hostel.verificationStatus)}>
                          {hostel.verificationStatus.replaceAll("_", " ")}
                        </SoftBadge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end">
                          <button
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-role-platform transition hover:bg-role-platform-soft"
                            onClick={(event) => {
                              event.stopPropagation();
                              router.push(`/platform/hostels/${hostel.id}`);
                            }}
                            type="button"
                          >
                            <ShieldCheck className="size-3.5" />
                            Review
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </DataTable>
              <ListPager
                onPageChange={setPage}
                page={page}
                pageSize={PAGE_SIZE}
                showPageSize
                total={filtered.length}
                unit="hostels"
              />
            </>
          ) : null}
        </Panel>

        {selectedHostel ? (
          <DetailPanel
            footer={
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {actionsForHostel(selectedHostel).map((nextAction) => {
                    const {
                      danger,
                      icon: Icon,
                      label,
                      variant,
                    } = ACTION_CONFIG[nextAction];

                    return (
                      <RoleButton
                        className={
                          danger
                            ? "border-destructive/30 text-destructive hover:bg-destructive/10"
                            : undefined
                        }
                        disabled={busy}
                        key={nextAction}
                        onClick={() => void action(selectedHostel.id, nextAction)}
                        tone="platform"
                        variant={variant}
                      >
                        <Icon className="size-3.5" />
                        {label}
                      </RoleButton>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-3 text-[11px] font-semibold">
                  <Link
                    className="inline-flex items-center gap-1 text-role-platform hover:underline"
                    href={`/platform/hostels/${selectedHostel.id}`}
                  >
                    <ExternalLink className="size-3" />
                    Open full review
                  </Link>
                  <button
                    className="inline-flex items-center gap-1 text-muted-foreground transition hover:text-foreground disabled:opacity-40"
                    disabled={busy}
                    onClick={() => void runDuplicateCheck(selectedHostel.id)}
                    type="button"
                  >
                    <ScanSearch className="size-3" />
                    Run duplicate check
                  </button>
                  {/* Only ever on an already-archived hostel — the server
                      refuses anything else, and offering it here on a live one
                      would be a button that exists to fail. */}
                  {selectedHostel.isArchived ? (
                    <button
                      className="inline-flex items-center gap-1 text-destructive transition hover:underline disabled:opacity-40"
                      disabled={busy}
                      onClick={() => void purgeNow(selectedHostel)}
                      type="button"
                    >
                      <Trash2 className="size-3" />
                      Erase now
                    </button>
                  ) : null}
                </div>
              </div>
            }
            onClose={() => setSelectedId(null)}
            subtitle={
              <>
                {selectedHostel.location.area}
                {selectedHostel.location.city ? `, ${selectedHostel.location.city}` : ""}
              </>
            }
            title={selectedHostel.name}
          >
            {detailState === "loading" ? <LoadingRows /> : null}
            {detailState === "error" ? (
              <EmptyState label="Documents could not be loaded." />
            ) : null}

            {detailState === "ready" ? (
              <>
                {selectedHostel.isArchived ? (
                  <DetailSection title="Archived">
                    <DetailField
                      label="Archived on"
                      value={formatDateTime(selectedHostel.archivedAt)}
                    />
                    <DetailField
                      label="Reason"
                      value={selectedHostel.archiveReason || "—"}
                    />
                    <DetailField
                      label="Erased in"
                      value={(() => {
                        const days = daysUntilPurge(selectedHostel.purgeScheduledAt);
                        if (days === null) {
                          return "Not scheduled";
                        }
                        return days === 0
                          ? "Due now"
                          : `${days} day${days === 1 ? "" : "s"}`;
                      })()}
                    />
                  </DetailSection>
                ) : null}

                <DetailSection title="Status">
                  <DetailField
                    label="Listing status"
                    value={
                      <SoftBadge tone={statusToneFromLabel(selectedHostel.status)}>
                        {selectedHostel.status.replaceAll("_", " ")}
                      </SoftBadge>
                    }
                  />
                  <DetailField
                    label="Verification"
                    value={
                      <SoftBadge
                        tone={statusToneFromLabel(selectedHostel.verificationStatus)}
                      >
                        {selectedHostel.verificationStatus.replaceAll("_", " ")}
                      </SoftBadge>
                    }
                  />
                  <DetailField
                    label="Application"
                    value={detail?.application?.status?.replaceAll("_", " ") ?? "—"}
                  />
                  <DetailField label="Documents on file" value={`${documents.length}`} />
                </DetailSection>

                <DetailSection title="Submitted By">
                  <DetailField
                    label="Name"
                    value={detail?.submitter?.name ?? detail?.owner?.name ?? "—"}
                  />
                  <DetailField
                    label="Email"
                    value={detail?.submitter?.email ?? detail?.owner?.email ?? "—"}
                  />
                  <DetailField
                    label="Phone"
                    value={detail?.submitter?.phone ?? detail?.owner?.phone ?? "—"}
                  />
                  <DetailField
                    label="Submitted on"
                    value={formatDateTime(
                      detail?.application?.submittedAt ?? selectedHostel.submittedAt,
                    )}
                  />
                </DetailSection>

                <DetailSection title="Required Checklist">
                  {REQUIRED_DOCUMENTS.map((requirement) => {
                    const match = documents.find((document) =>
                      document.documentType
                        .toLowerCase()
                        .includes(requirement.split(" ")[0].toLowerCase()),
                    );

                    return (
                      <DetailField
                        key={requirement}
                        label={requirement}
                        value={
                          match ? (
                            <SoftBadge tone={statusToneFromLabel(match.status)}>
                              {match.status.replaceAll("_", " ")}
                            </SoftBadge>
                          ) : (
                            <SoftBadge tone="slate">Missing</SoftBadge>
                          )
                        }
                      />
                    );
                  })}
                </DetailSection>

                <DetailSection title={`Submitted Documents (${documents.length})`}>
                  {documents.length === 0 ? (
                    <p className="py-2 text-[11.5px] text-muted-foreground">
                      The owner has not uploaded any documents yet.
                    </p>
                  ) : (
                    documents.map((document) => {
                      const href = documentHref(document);

                      return (
                        <div
                          className="flex items-start justify-between gap-2 border-b border-border/50 py-1.5 last:border-0"
                          key={document.id}
                        >
                          <div className="min-w-0">
                            <p className="truncate text-[11.5px] font-semibold text-foreground">
                              {document.documentType}
                            </p>
                            <p className="text-[10.5px] text-muted-foreground">
                              {formatDate(document.createdAt)}
                              {document.rejectionReason
                                ? ` · ${document.rejectionReason}`
                                : ""}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <SoftBadge tone={statusToneFromLabel(document.status)}>
                              {document.status.replaceAll("_", " ")}
                            </SoftBadge>
                            {href ? (
                              <a
                                className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                                href={href}
                                rel="noreferrer noopener"
                                target="_blank"
                                title="Open document"
                              >
                                <ExternalLink className="size-3" />
                              </a>
                            ) : null}
                          </div>
                        </div>
                      );
                    })
                  )}
                </DetailSection>

                {detail?.application?.requestedDocuments?.length ? (
                  <DetailSection title="Requested From Owner">
                    {detail.application.requestedDocuments.map((request) => (
                      <DetailField
                        key={request.documentType}
                        label={request.documentType}
                        value={request.note || "Requested"}
                      />
                    ))}
                  </DetailSection>
                ) : null}
              </>
            ) : null}
          </DetailPanel>
        ) : (
          <Panel className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-role-platform-soft text-role-platform">
              <Fingerprint className="size-5" />
            </span>
            <p className="text-[13px] font-semibold text-foreground">
              Select a hostel to review it
            </p>
            <p className="max-w-xs text-[11.5px] text-muted-foreground">
              Its submitter, document checklist, and upload history appear here, along
              with the approve, reject, and publish controls.
            </p>
          </Panel>
        )}
      </div>
    </div>
  );
});
