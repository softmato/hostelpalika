"use client";

import {
  BadgeCheck,
  CircleSlash,
  Clock3,
  ExternalLink,
  EyeOff,
  FileText,
  Loader2,
  Phone,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import React, { useCallback, useMemo, useState } from "react";

import { MaintenanceChargesPanel } from "@/app/_components/platform-maintenance-charges";
import { EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import {
  DataTable,
  DetailField,
  FilterBar,
  FilterSelect,
  InitialsAvatar,
  ListPager,
  MetricCard,
  PortalPageHeader,
  RailCard,
  RoleButton,
  SearchField,
  SoftBadge,
  TabBar,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  Th,
  statusToneFromLabel,
} from "@/app/_components/portal-dashboard-ui";
import { browserApi } from "@/lib/browser-api";
import { platformEndpoints } from "@/lib/platform-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";
import { Message, type ServiceProvider } from "./portal-shared";

/**
 * Keys are the raw `ServiceProvider.status` values — the tab filter compares
 * against them directly. `PENDING_APPROVAL` is deliberately spelled out: it used
 * to read `PENDING` here, which matched nothing, so the Pending tab and the
 * Pending Review stat both sat at zero while the applications showed up under All.
 */
const TABS = [
  { key: "PENDING_APPROVAL", label: "Pending" },
  { key: "APPROVED", label: "Approved" },
  { key: "HIDDEN", label: "Hidden" },
  { key: "REJECTED", label: "Rejected" },
  { key: "ALL", label: "All" },
];

const PAGE_SIZE = 10;

/**
 * Ratings are not yet captured for providers, so the table shows a neutral
 * placeholder instead of inventing a score. Once reviews land, swap this for the
 * real aggregate.
 */
const NO_RATING = "—";

/** Uploaded file on a provider application, from the detail endpoint. */
type ProviderDocument = {
  documentType: string;
  fileAssetId?: string | null;
  fileUrl: string;
  id: string;
  status: string;
};

/** `PENDING_APPROVAL` → `Pending approval` — raw enums do not belong on screen. */
function statusLabel(status: string) {
  const words = status.toLowerCase().split("_");

  return words
    .map((word, index) =>
      index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word,
    )
    .join(" ");
}

/** `DOCTOR_CLINIC` → `Doctor Clinic`, for badges. */
function categoryLabel(category: string) {
  return category
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

function humanizeDocumentType(documentType: string) {
  return statusLabel(documentType);
}

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleDateString() : "—";
}

/** All trades a provider works in, tolerating pre-multi-trade records. */
function providerTrades(provider: ServiceProvider) {
  return provider.categories?.length ? provider.categories : [provider.category];
}

type ModerationAction = "approve" | "hide" | "reject";

/** Present-tense labels shown while a moderation request is still in flight. */
const ACTION_PROGRESS: Record<ModerationAction, string> = {
  approve: "Approving",
  hide: "Hiding",
  reject: "Rejecting",
};

/**
 * A moderation button that reports its own progress. The PATCH plus the list
 * refetch behind it can run for seconds; a button that neither moves nor
 * disables during that reads as broken and invites a second click.
 *
 * While *any* action is running every button locks, because they all mutate the
 * same records and a second request landing mid-flight would race the refetch.
 */
function ModerationButton({
  action,
  busyAction,
  className,
  icon: Icon,
  label,
  onRun,
  providerId,
}: {
  action: ModerationAction;
  busyAction: { action: ModerationAction; providerId: string } | null;
  className: string;
  icon: LucideIcon;
  label: string;
  onRun: (providerId: string, action: ModerationAction) => void;
  providerId: string;
}) {
  const isRunning = busyAction?.providerId === providerId && busyAction.action === action;
  const isLocked = Boolean(busyAction);

  return (
    <button
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      disabled={isLocked}
      onClick={(event) => {
        event.stopPropagation();
        onRun(providerId, action);
      }}
      type="button"
    >
      {isRunning ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <Icon className="size-3.5" />
      )}
      {isRunning ? `${ACTION_PROGRESS[action]}…` : label}
    </button>
  );
}

export const PlatformServiceProvidersPageContent = React.memo(
  function PlatformServiceProvidersPageContent() {
    const [actionMessage, setActionMessage] = useState("");
    const router = useRouter();
    const invalidate = useInvalidateResources();
    const providersResource = usePortalResource<{ providers: ServiceProvider[] }>(
      platformEndpoints.serviceProviders,
      { errorMessage: "Could not load providers." },
    );
    const [query, setQuery] = useState("");
    const [tab, setTab] = useState("PENDING_APPROVAL");
    const [categoryFilter, setCategoryFilter] = useState("");
    const [areaFilter, setAreaFilter] = useState("");
    const [availabilityFilter, setAvailabilityFilter] = useState("");
    const [verifiedOnly, setVerifiedOnly] = useState(false);
    const [page, setPage] = useState(1);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    /** Which moderation request is in flight, so its button can say so. */
    const [busyAction, setBusyAction] = useState<{
      action: ModerationAction;
      providerId: string;
    } | null>(null);

    const providers = useMemo(
      () => providersResource.data?.providers ?? [],
      [providersResource.data],
    );
    const state = providersResource.state;
    const message = actionMessage || providersResource.message;

    const moderate = useCallback(
      async (providerId: string, action: "approve" | "hide" | "reject") => {
        const reason =
          action === "reject" ? window.prompt("Rejection reason")?.trim() : undefined;

        if (action === "reject" && !reason) {
          return;
        }

        // The PATCH plus the list refetch behind it can take several seconds.
        // Without this the row looks inert and the obvious move is to click
        // again — which fires a second moderation request.
        setBusyAction({ action, providerId });
        setActionMessage(`${ACTION_PROGRESS[action]}…`);

        try {
          // `serviceProviders` already carries `?pageSize=100`, so appending a
          // path to it produced `...?pageSize=100/<id>/approve` — a 405 that made
          // every moderation action on this page silently impossible. Detail URLs
          // must be built from the `serviceProvider(id)` helper.
          await browserApi(`${platformEndpoints.serviceProvider(providerId)}/${action}`, {
            body: JSON.stringify(reason ? { reason } : {}),
            method: "PATCH",
          });
          setActionMessage(`Provider ${action}d.`);
          invalidate(
            platformEndpoints.serviceProviders,
            platformEndpoints.serviceProviderDetails,
          );
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not update provider.",
          );
        } finally {
          setBusyAction(null);
        }
      },
      [invalidate],
    );

    const counts = useMemo(() => {
      const by = (status: string) =>
        providers.filter((provider) => provider.status === status).length;
      return {
        approved: by("APPROVED"),
        hidden: by("HIDDEN"),
        pending: by("PENDING_APPROVAL"),
        total: providers.length,
      };
    }, [providers]);

    // Every trade a provider works in, so a plumber-and-carpenter shows up under
    // both the filter dropdown and a search for either word.
    const categories = useMemo(
      () =>
        Array.from(
          new Set(providers.flatMap((provider) => providerTrades(provider))),
        ).filter(Boolean),
      [providers],
    );

    const areas = useMemo(
      () =>
        Array.from(new Set(providers.map((provider) => provider.area))).filter(Boolean),
      [providers],
    );

    const filtered = useMemo(() => {
      const term = query.trim().toLowerCase();

      return providers.filter((provider) => {
        if (tab !== "ALL" && provider.status !== tab) return false;
        if (verifiedOnly && provider.status !== "APPROVED") return false;
        const trades = providerTrades(provider);

        if (categoryFilter && !trades.includes(categoryFilter)) return false;
        if (areaFilter && provider.area !== areaFilter) return false;
        if (availabilityFilter && provider.availability !== availabilityFilter) {
          return false;
        }
        if (!term) return true;

        return `${provider.fullName} ${trades.join(" ")} ${provider.area} ${provider.phone}`
          .toLowerCase()
          .includes(term);
      });
    }, [
      areaFilter,
      availabilityFilter,
      categoryFilter,
      providers,
      query,
      tab,
      verifiedOnly,
    ]);

    const paged = useMemo(
      () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      [filtered, page],
    );

    const pending = useMemo(
      () =>
        providers
          .filter((provider) => provider.status === "PENDING_APPROVAL")
          .slice(0, 6),
      [providers],
    );

    const selected = providers.find((provider) => provider.id === selectedId) ?? null;
    // The list endpoint carries no documents, so the review panel loads the full
    // application — same shape the Hostel Approvals review screen works from.
    // Approving without seeing the citizenship or licence scan is exactly what
    // this panel exists to prevent.
    const detailResource = usePortalResource<{
      documents: ProviderDocument[];
      provider: ServiceProvider;
    }>(selectedId ? platformEndpoints.serviceProvider(selectedId) : null, {
      errorMessage: "Could not load this application.",
    });
    const documents = detailResource.data?.documents ?? [];
    const detail = detailResource.data?.provider ?? selected;
    /** The action running against the *selected* provider, for the rail buttons. */
    const railBusy =
      busyAction && busyAction.providerId === selectedId ? busyAction.action : null;
    const selectedCategories = detail?.categories?.length
      ? detail.categories
      : detail
        ? [detail.category]
        : [];

    const tabCount = (key: string) =>
      key === "ALL"
        ? providers.length
        : providers.filter((provider) => provider.status === key).length;

    return (
      <div className="mx-auto max-w-[1448px] space-y-4">
        <PortalPageHeader
          breadcrumb={["Home", "Service Providers"]}
          description="Approve applications and manage the verified provider network hostels can book from."
          title="Service Providers"
        />
        <Message value={message} />

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            icon={Users}
            label="Total Providers"
            note="All applications"
            tone="teal"
            value={counts.total}
          />
          <MetricCard
            icon={Clock3}
            label="Pending Review"
            note="Awaiting decision"
            noteTone="amber"
            tone="amber"
            value={counts.pending}
          />
          <MetricCard
            icon={BadgeCheck}
            label="Approved"
            note="Bookable by hostels"
            noteTone="green"
            tone="green"
            value={counts.approved}
          />
          <MetricCard
            icon={CircleSlash}
            label="Hidden"
            note="Temporarily delisted"
            noteTone="rose"
            tone="rose"
            value={counts.hidden}
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
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
                placeholder="Search providers by name or service..."
                value={query}
              />
              <div className="flex flex-wrap gap-2">
                <FilterSelect
                  defaultLabel="All Categories"
                  onChange={(next) => {
                    setCategoryFilter(next);
                    setPage(1);
                  }}
                  options={categories}
                  value={categoryFilter}
                />
                <FilterSelect
                  defaultLabel="All Areas"
                  onChange={(next) => {
                    setAreaFilter(next);
                    setPage(1);
                  }}
                  options={areas}
                  value={areaFilter}
                />
                <FilterSelect
                  defaultLabel="Any Availability"
                  onChange={(next) => {
                    setAvailabilityFilter(next);
                    setPage(1);
                  }}
                  options={Array.from(
                    new Set(providers.map((provider) => provider.availability)),
                  ).filter(Boolean)}
                  value={availabilityFilter}
                />
              </div>
            </FilterBar>

            <div className="mb-2.5 mt-2.5 flex flex-wrap items-center justify-between gap-2">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-role-platform/25 bg-role-platform-soft px-2.5 py-1 text-[11.5px] font-semibold text-role-platform">
                <input
                  checked={verifiedOnly}
                  className="size-3.5 accent-current"
                  onChange={(event) => {
                    setVerifiedOnly(event.target.checked);
                    setPage(1);
                  }}
                  type="checkbox"
                />
                <ShieldCheck className="size-3.5" />
                Verified providers only
              </label>
              <button
                className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-muted-foreground transition hover:text-foreground"
                onClick={() => {
                  setQuery("");
                  setCategoryFilter("");
                  setAreaFilter("");
                  setAvailabilityFilter("");
                  setVerifiedOnly(false);
                  setPage(1);
                }}
                type="button"
              >
                <SlidersHorizontal className="size-3.5" />
                Reset filters
              </button>
            </div>

            {state === "loading" ? <LoadingRows /> : null}
            {state === "error" ? (
              <EmptyState label="Providers could not be loaded." />
            ) : null}
            {state === "ready" && filtered.length === 0 ? (
              <EmptyState label="No providers match these filters." />
            ) : null}

            {state === "ready" && filtered.length > 0 ? (
              <>
                <DataTable className="min-w-[820px]">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <Th>Provider</Th>
                      <Th>Category</Th>
                      <Th>Area</Th>
                      <Th>Rating</Th>
                      <Th>Phone</Th>
                      <Th>Availability</Th>
                      <Th align="right">Actions</Th>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paged.map((provider) => (
                      <TableRow
                        className={cn(
                          provider.id === selectedId
                            ? "bg-role-platform-soft/40"
                            : "cursor-pointer",
                        )}
                        key={provider.id}
                        onClick={() => setSelectedId(provider.id)}
                        onDoubleClick={() =>
                          router.push(`/platform/service-providers/${provider.id}`)
                        }
                      >
                        <TableCell>
                          <div className="flex items-center gap-2.5">
                            <span className="relative">
                              <InitialsAvatar
                                name={provider.fullName}
                                size="sm"
                                tone="platform"
                              />
                              {provider.status === "APPROVED" ? (
                                <BadgeCheck className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full bg-card text-emerald-600" />
                              ) : null}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate font-semibold text-foreground">
                                {provider.fullName}
                              </p>
                              <p className="truncate text-[11px] text-muted-foreground">
                                {provider.experience || provider.description || "—"}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {(provider.categories?.length
                              ? provider.categories
                              : [provider.category]
                            )
                              .filter(Boolean)
                              .map((category) => (
                                <SoftBadge key={category} tone="teal">
                                  {categoryLabel(category)}
                                </SoftBadge>
                              ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {provider.area || "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {NO_RATING}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {provider.phone || "—"}
                        </TableCell>
                        <TableCell>
                          <SoftBadge
                            tone={statusToneFromLabel(provider.availability || "slate")}
                          >
                            {provider.availability || "Unknown"}
                          </SoftBadge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
                            {/* The decision belongs on the full review screen —
                                the form data, photo and paperwork all live
                                there, and approving from the row alone means
                                approving documents nobody opened. */}
                            <Link
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-role-platform transition hover:bg-role-platform-soft"
                              href={`/platform/service-providers/${provider.id}`}
                              onClick={(event) => event.stopPropagation()}
                            >
                              <FileText className="size-3.5" />
                              Review
                            </Link>
                            {provider.phone ? (
                              <a
                                className="rounded-md border border-border p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                                href={`tel:${provider.phone}`}
                                onClick={(event) => event.stopPropagation()}
                                title="Call"
                              >
                                <Phone className="size-3" />
                              </a>
                            ) : null}
                            {provider.status !== "APPROVED" ? (
                              <ModerationButton
                                action="approve"
                                busyAction={busyAction}
                                className="text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
                                icon={BadgeCheck}
                                label="Approve"
                                onRun={moderate}
                                providerId={provider.id}
                              />
                            ) : (
                              <ModerationButton
                                action="hide"
                                busyAction={busyAction}
                                className="text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/40"
                                icon={EyeOff}
                                label="Hide"
                                onRun={moderate}
                                providerId={provider.id}
                              />
                            )}
                            <ModerationButton
                              action="reject"
                              busyAction={busyAction}
                              className="text-rose-700 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950/40"
                              icon={X}
                              label="Reject"
                              onRun={moderate}
                              providerId={provider.id}
                            />
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
                  unit="providers"
                />
              </>
            ) : null}
          </Panel>

          <div className="space-y-4">
            <RailCard
              action={
                <span className="text-[11px] font-semibold text-muted-foreground">
                  {counts.pending} total
                </span>
              }
              title="Pending Applications"
            >
              {pending.length === 0 ? (
                <p className="px-1 py-4 text-center text-[12px] text-muted-foreground">
                  Nothing waiting for review.
                </p>
              ) : (
                pending.map((provider) => (
                  <div
                    className="rounded-lg border border-border/70 bg-muted/15 p-2"
                    key={provider.id}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[12px] font-semibold text-foreground">
                          {provider.fullName}
                        </p>
                        <p className="text-[10.5px] text-muted-foreground">
                          {providerTrades(provider)
                            .filter(Boolean)
                            .map(categoryLabel)
                            .join(", ") || "Uncategorised"}
                          {provider.area ? ` · ${provider.area}` : ""}
                        </p>
                      </div>
                      <SoftBadge tone="amber">Pending</SoftBadge>
                    </div>
                    <div className="mt-1.5 flex gap-1.5">
                      <button
                        className="flex-1 rounded-md bg-role-platform px-2 py-1 text-[11px] font-semibold text-white transition hover:bg-role-platform/90"
                        onClick={() => void moderate(provider.id, "approve")}
                        type="button"
                      >
                        Approve
                      </button>
                      <button
                        className="flex-1 rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-muted-foreground transition hover:bg-muted"
                        onClick={() => void moderate(provider.id, "reject")}
                        type="button"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))
              )}
            </RailCard>

            {selected ? (
              <RailCard
                action={
                  <button
                    aria-label="Close provider details"
                    className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    onClick={() => setSelectedId(null)}
                    type="button"
                  >
                    <X className="size-3.5" />
                  </button>
                }
                title="Application Review"
              >
                <Link
                  className="mb-2.5 flex items-center justify-center gap-1.5 rounded-md bg-role-platform px-3 py-2 text-[12px] font-bold text-white transition hover:opacity-90"
                  href={`/platform/service-providers/${selected.id}`}
                >
                  <ExternalLink className="size-3.5" />
                  Open full review
                </Link>

                <div className="mb-2 flex items-center gap-2.5">
                  <InitialsAvatar name={selected.fullName} size="md" tone="platform" />
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-bold text-foreground">
                      {selected.fullName}
                    </p>
                    <SoftBadge tone={statusToneFromLabel(selected.status)}>
                      {statusLabel(selected.status)}
                    </SoftBadge>
                  </div>
                </div>

                <div className="mb-2 flex flex-wrap gap-1">
                  {selectedCategories.map((category) => (
                    <SoftBadge key={category} tone="teal">
                      {categoryLabel(category)}
                    </SoftBadge>
                  ))}
                </div>

                <DetailField label="Service area" value={detail?.area || "—"} />
                <DetailField label="City" value={detail?.city || "—"} />
                <DetailField label="Phone" value={detail?.phone || "—"} />
                <DetailField label="Email" value={detail?.email || "—"} />
                <DetailField label="Experience" value={detail?.experience || "—"} />
                <DetailField label="Availability" value={detail?.availability || "—"} />
                <DetailField label="Submitted" value={formatDate(detail?.createdAt)} />
                <DetailField label="Rating" value={NO_RATING} />

                {detail?.description ? (
                  <p className="mt-2 border-t border-border/50 pt-2 text-[11.5px] leading-4 text-muted-foreground">
                    {detail.description}
                  </p>
                ) : null}

                <div className="mt-3 border-t border-border/50 pt-2">
                  <p className="mb-1.5 text-[11px] font-bold text-foreground">
                    Documents{" "}
                    <span className="font-normal text-muted-foreground">
                      ({documents.length})
                    </span>
                  </p>
                  {detailResource.state === "loading" ? (
                    <p className="text-[11px] text-muted-foreground">Loading…</p>
                  ) : documents.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">
                      No documents were attached to this application.
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {documents.map((document) => (
                        <li key={document.id}>
                          <a
                            className="flex items-center gap-1.5 text-[11.5px] font-semibold text-role-platform hover:underline"
                            href={
                              document.fileAssetId
                                ? `/api/v1/files/${document.fileAssetId}/url`
                                : document.fileUrl || "#"
                            }
                            rel="noreferrer"
                            target="_blank"
                          >
                            <FileText className="size-3.5 shrink-0" />
                            <span className="truncate">
                              {humanizeDocumentType(document.documentType)}
                            </span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {selected.phone ? (
                    <RoleButton asChild tone="platform" variant="outline">
                      <a href={`tel:${selected.phone}`}>
                        <Phone className="size-3.5" />
                        Call
                      </a>
                    </RoleButton>
                  ) : null}
                  {selected.status === "APPROVED" ? (
                    <RoleButton
                      disabled={Boolean(busyAction)}
                      onClick={() => void moderate(selected.id, "hide")}
                      tone="platform"
                      variant="outline"
                    >
                      {railBusy === "hide" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <EyeOff className="size-3.5" />
                      )}
                      {railBusy === "hide" ? "Hiding…" : "Hide"}
                    </RoleButton>
                  ) : (
                    <RoleButton
                      disabled={Boolean(busyAction)}
                      onClick={() => void moderate(selected.id, "approve")}
                      tone="platform"
                    >
                      {railBusy === "approve" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <BadgeCheck className="size-3.5" />
                      )}
                      {railBusy === "approve" ? "Approving…" : "Approve"}
                    </RoleButton>
                  )}
                  {selected.status !== "REJECTED" ? (
                    <RoleButton
                      disabled={Boolean(busyAction)}
                      onClick={() => void moderate(selected.id, "reject")}
                      tone="platform"
                      variant="outline"
                    >
                      {railBusy === "reject" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <CircleSlash className="size-3.5" />
                      )}
                      {railBusy === "reject" ? "Rejecting…" : "Reject"}
                    </RoleButton>
                  ) : null}
                </div>
              </RailCard>
            ) : (
              <RailCard title="Network Health">
                <DetailField
                  label="Approval rate"
                  value={
                    counts.total > 0
                      ? `${Math.round((counts.approved / counts.total) * 100)}%`
                      : "—"
                  }
                />
                <DetailField label="Categories covered" value={categories.length} />
                <DetailField label="Areas covered" value={areas.length} />
                <p className="pt-1.5 text-[11px] leading-4 text-muted-foreground">
                  Select a provider row to inspect its application and act on it.
                </p>
              </RailCard>
            )}
          </div>
        </div>

        <MaintenanceChargesPanel />
      </div>
    );
  },
);
