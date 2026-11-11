"use client";

import { formatHostelDate, formatHostelDateTime } from "@hostel/shared/calendar/bs";

import {
  BadgeCheck,
  Building2,
  Check,
  Clock3,
  ExternalLink,
  FileSearch,
  FileText,
  Fingerprint,
  Mail,
  Pencil,
  ScanSearch,
  ShieldCheck,
  X,
  type IconComponent,
} from "@/components/icons";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useCallback, useMemo, useState } from "react";

import { EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import { FilterButton, FilterChoice } from "@/components/filter-panel";
import {
  DataTable,
  DetailField,
  DetailPanel,
  DetailSection,
  InitialsAvatar,
  ListPager,
  MetricCard,
  PortalPageHeader,
  RoleButton,
  SearchField,
  SoftBadge,
  type SoftTone,
  statusToneFromLabel,
  TabBar,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  Th,
} from "@/app/_components/portal-dashboard-ui";
import { browserApi } from "@/lib/browser-api";
import { Role } from "@/lib/roles";
import { platformEndpoints } from "@/lib/platform-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { DemoDataBadge, Hostel, type HostelPortal, Message } from "./core-portal-shared";

/**
 * Approval decisions only. Publishing, unpublishing and archiving are what the
 * public sees, so they live on Listings; plan money lives on Subscriptions.
 */
type ActionKey = "approve" | "reject" | "request-documents";

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
  portals?: HostelPortal[];
  submitter: VerificationContact;
};

const PORTAL_LABELS: Record<string, [label: string, letter: string]> = {
  [Role.COOK]: ["Cook", "C"],
  [Role.GUARDIAN]: ["Guardian", "G"],
  [Role.HOSTEL_ADMIN]: ["Hostel admin", "A"],
  [Role.RESIDENT]: ["Resident", "R"],
  [Role.WARDEN]: ["Warden", "W"],
};

function portalTone(portal: HostelPortal): SoftTone {
  if (portal.accounts === 0) return "slate";
  return portal.opened === 0 ? "amber" : "green";
}

function portalSummary(portal: HostelPortal) {
  if (portal.accounts === 0) return "No login";
  return portal.opened === 0
    ? `Not opened · ${portal.accounts}`
    : `Opened · ${portal.opened}/${portal.accounts}`;
}

const ACTION_CONFIG: Record<
  ActionKey,
  { danger?: true; icon: IconComponent; label: string; variant: "solid" | "outline" }
> = {
  approve: { icon: Check, label: "Approve", variant: "solid" },
  reject: { danger: true, icon: X, label: "Reject", variant: "outline" },
  "request-documents": { icon: FileText, label: "Request docs", variant: "outline" },
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
 * axes on purpose: the decision stages plus the cross-cutting document queue,
 * which can hold hostels sitting at any approval stage. Live vs not-live is a
 * Listings question, so "Approved" counts published hostels too.
 */
const TABS = [
  { key: "PENDING", label: "Pending Approval" },
  { key: "KYC", label: "KYC Queue" },
  { key: "APPROVED", label: "Approved" },
  { key: "REJECTED", label: "Rejected" },
  { key: "ALL", label: "All" },
];

const PAGE_SIZE = 10;

const isApproved = (hostel: Hostel) =>
  hostel.status === "APPROVED" || hostel.status === "PUBLISHED";

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
      return isApproved(hostel);
    case "REJECTED":
      return hostel.status === "REJECTED";
    default:
      return true;
  }
}

/**
 * Only the decisions valid for a hostel's current status — "approve" on one
 * already approved is a no-op button, not a real choice. A published hostel
 * has no approval decision left; pulling it is Unpublish, on Listings.
 */
function actionsForHostel(hostel: Hostel): ActionKey[] {
  switch (hostel.status) {
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
  return Number.isNaN(date.getTime()) ? "—" : formatHostelDate(date);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : formatHostelDateTime(date);
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

  const invalidate = useInvalidateResources();
  const hostelsResource = usePortalResource<{ hostels: Hostel[] }>(
    platformEndpoints.hostels,
    { errorMessage: "Could not load hostels." },
  );
  const meResource = usePortalResource<{ user: { role: string } }>(
    platformEndpoints.currentUser,
    { errorMessage: "Could not load your account." },
  );
  // The server refuses anyone else; this only hides buttons that would fail.
  const isSuperadmin = meResource.data?.user?.role === Role.SUPERADMIN;
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
        invalidate(platformEndpoints.hostels, platformEndpoints.hostel(hostelId));
      } catch (error) {
        setActionMessage(error instanceof Error ? error.message : "Action failed.");
      } finally {
        setBusy(false);
      }
    },
    [invalidate],
  );

  /**
   * Fixes an owner email the team mistyped at filing. The owner's login moves
   * with it, and the server mails both inboxes — a Gmail is told to use
   * Google, anyone else gets a temporary password when they need one. "Send
   * login" is only for a resend.
   */
  const editOwnerEmail = useCallback(
    async (hostelId: string, current: string) => {
      const email = window
        .prompt("Owner's email. Their login and every hostel email go here.", current)
        ?.trim()
        .toLowerCase();
      if (!email || email === current) return;

      setBusy(true);
      try {
        const result = await browserApi<{
          notification?: { google: boolean; loginIssued: boolean; reason?: string; sent: boolean };
        }>(`${platformEndpoints.hostel(hostelId)}/owner-email`, {
          body: JSON.stringify({ email }),
          method: "PATCH",
        });
        const note = result?.notification;
        setActionMessage(
          !note
            ? `Owner email is already ${email}.`
            : note.sent
              ? `Owner email changed to ${email}. ${note.google ? "They were emailed to log in with Google" : note.loginIssued ? "A temporary password was emailed there" : "A notice was emailed there"}, and ${current || "the old address"} was told.`
              : `Owner email changed to ${email}, but the email was NOT sent (${note.reason ?? "unknown error"}). Use Send login.`,
        );
        invalidate(platformEndpoints.hostels, platformEndpoints.hostel(hostelId));
      } catch (error) {
        setActionMessage(error instanceof Error ? error.message : "Could not change the email.");
      } finally {
        setBusy(false);
      }
    },
    [invalidate],
  );

  const sendOwnerInvite = useCallback(async (hostelId: string, email: string) => {
    if (
      !window.confirm(
        `Send the portal login to ${email}?

A new temporary password is issued. Any earlier one stops working.`,
      )
    ) {
      return;
    }

    setBusy(true);
    try {
      const result = await browserApi<{
        notification?: { reason?: string; sent: boolean; to?: string };
      }>(`${platformEndpoints.hostel(hostelId)}/owner-invite`, {
        body: JSON.stringify({}),
        method: "PATCH",
      });
      setActionMessage(
        result?.notification?.sent === false
          ? `Login was NOT emailed (${result.notification.reason ?? "unknown error"}).`
          : `Login sent to ${email}.`,
      );
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "Could not send the login.");
    } finally {
      setBusy(false);
    }
  }, []);

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

  const counts = useMemo(
    () => ({
      approved: hostels.filter(isApproved).length,
      kycPending: hostels.filter(isAwaitingKyc).length,
      pendingApproval: hostels.filter(isAwaitingApproval).length,
      total: hostels.length,
    }),
    [hostels],
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

  const tabCount = (key: string) => hostels.filter((hostel) => matchesTab(hostel, key)).length;

  const switchTab = (next: string) => {
    setTab(next);
    setPage(1);
  };

  const selectedHostel = hostels.find((hostel) => hostel.id === selectedId) ?? null;
  const documents = detail?.documents ?? [];

  return (
    <div className="mx-auto max-w-[1448px] space-y-4">
      <PortalPageHeader description="Read the paperwork, then decide." title="Hostel Approvals" />
      <Message value={message} />

      {/* Each tile opens the tab it counts. */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          active={tab === "ALL"}
          icon={Building2}
          label="Hostels"
          onClick={() => switchTab("ALL")}
          value={counts.total}
        />
        <MetricCard
          active={tab === "PENDING"}
          icon={Clock3}
          label="Waiting approval"
          onClick={() => switchTab("PENDING")}
          tone={counts.pendingApproval > 0 ? "amber" : "teal"}
          value={counts.pendingApproval}
        />
        <MetricCard
          active={tab === "KYC"}
          icon={FileSearch}
          label="Documents to check"
          onClick={() => switchTab("KYC")}
          tone={counts.kycPending > 0 ? "amber" : "teal"}
          value={counts.kycPending}
        />
        <MetricCard
          active={tab === "APPROVED"}
          icon={BadgeCheck}
          label="Approved"
          note={counts.total > 0 ? `${Math.round((counts.approved / counts.total) * 100)}% of all` : undefined}
          onClick={() => switchTab("APPROVED")}
          value={counts.approved}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.65fr_1fr]">
        <Panel>
          <TabBar
            className="mb-3"
            onChange={switchTab}
            tabs={TABS.map((item) => ({ ...item, count: tabCount(item.key) }))}
            value={tab}
          />

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <SearchField
              onChange={(next) => {
                setQuery(next);
                setPage(1);
              }}
              placeholder="Search hostels"
              value={query}
            />
            <FilterButton
              active={city ? 1 : 0}
              onClear={() => {
                setCity("");
                setPage(1);
              }}
            >
              <FilterChoice
                label="City"
                onChange={(next) => {
                  setCity(next);
                  setPage(1);
                }}
                options={[{ label: "All", value: "" }, ...cities.map((name) => ({ label: name, value: name }))]}
                value={city}
              />
            </FilterButton>
          </div>

          {state === "loading" ? <LoadingRows /> : null}
          {state === "error" ? <EmptyState label="Hostels could not be loaded." /> : null}
          {state === "ready" && filtered.length === 0 ? (
            <EmptyState label="Nothing in this queue." />
          ) : null}

          {state === "ready" && filtered.length > 0 ? (
            <>
              <DataTable className="min-w-[640px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <Th>Hostel</Th>
                    <Th>Listing</Th>
                    <Th>KYC</Th>
                    <Th>Portals</Th>
                    <Th align="right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paged.map((hostel) => (
                    <TableRow
                      className={
                        hostel.id === selectedId
                          ? "bg-role-team-soft/60"
                          : "cursor-pointer"
                      }
                      key={hostel.id}
                      onClick={() => setSelectedId(hostel.id)}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <InitialsAvatar name={hostel.name} size="sm" tone="team" />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <p className="truncate text-[13.5px] font-semibold text-foreground">
                                {hostel.name}
                              </p>
                              {hostel.isDemoData ? (
                                <DemoDataBadge label={hostel.demoDataLabel} />
                              ) : null}
                              {hostel.branchOf ? <SoftBadge tone="amber">BRANCH</SoftBadge> : null}
                            </div>
                            <p className="truncate text-[12px] text-muted-foreground">
                              {hostel.branchOf
                                ? `Branch of ${hostel.branchOf.name}`
                                : [hostel.location.area, hostel.location.city].filter(Boolean).join(", ")}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <SoftBadge tone={statusToneFromLabel(hostel.status)}>
                          {hostel.status.replaceAll("_", " ")}
                        </SoftBadge>
                      </TableCell>
                      <TableCell>
                        <SoftBadge tone={statusToneFromLabel(hostel.verificationStatus)}>
                          {hostel.verificationStatus.replaceAll("_", " ")}
                        </SoftBadge>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          {(hostel.portals ?? []).map((portal) => {
                            const [label, letter] = PORTAL_LABELS[portal.role] ?? [portal.role, "?"];
                            return (
                              <span
                                aria-label={`${label}: ${portalSummary(portal)}`}
                                key={portal.role}
                                title={`${label}: ${portalSummary(portal)}`}
                              >
                                <SoftBadge className="px-1.5" tone={portalTone(portal)}>
                                  {letter}
                                </SoftBadge>
                              </span>
                            );
                          })}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end">
                          <button
                            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-semibold text-role-team transition hover:bg-role-team-soft"
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
                        tone="team"
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
                    className="inline-flex items-center gap-1 text-role-team hover:underline"
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

                {isSuperadmin && detail?.owner ? (
                  <DetailSection title="Owner">
                    <DetailField label="Name" value={detail.owner.name} />
                    <DetailField label="Email" value={detail.owner.email || "—"} />
                    <div className="flex flex-wrap gap-3 py-2 text-[11.5px]">
                      <button
                        className="inline-flex items-center gap-1 text-muted-foreground transition hover:text-foreground disabled:opacity-40"
                        disabled={busy}
                        onClick={() =>
                          void editOwnerEmail(selectedHostel.id, detail.owner?.email ?? "")
                        }
                        type="button"
                      >
                        <Pencil className="size-3" />
                        Edit email
                      </button>
                      {detail.owner.email ? (
                        <button
                          className="inline-flex items-center gap-1 text-primary transition hover:underline disabled:opacity-40"
                          disabled={busy}
                          onClick={() =>
                            void sendOwnerInvite(selectedHostel.id, detail.owner?.email ?? "")
                          }
                          type="button"
                        >
                          <Mail className="size-3" />
                          Send login
                        </button>
                      ) : null}
                    </div>
                  </DetailSection>
                ) : null}

                {detail?.portals ? (
                  <DetailSection title="Portals">
                    {detail.portals.map((portal) => (
                      <DetailField
                        key={portal.role}
                        label={PORTAL_LABELS[portal.role]?.[0] ?? portal.role}
                        value={
                          <span
                            title={
                              portal.lastOpenedAt
                                ? `Last opened ${formatDateTime(portal.lastOpenedAt)}`
                                : undefined
                            }
                          >
                            <SoftBadge tone={portalTone(portal)}>{portalSummary(portal)}</SoftBadge>
                          </span>
                        }
                      />
                    ))}
                  </DetailSection>
                ) : null}

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
            <span className="flex size-12 items-center justify-center rounded-full bg-role-team-soft text-role-team">
              <Fingerprint className="size-[22px]" />
            </span>
            <p className="text-[13.5px] font-semibold text-foreground">Pick a hostel to review it</p>
            <p className="text-[12px] text-muted-foreground">Its papers and the decision buttons open here.</p>
          </Panel>
        )}
      </div>
    </div>
  );
});
