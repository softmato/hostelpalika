"use client";

import {
  Archive,
  ArchiveRestore,
  Ban,
  EyeOff,
  Globe,
  Image as ImageIcon,
  LockOpen,
  MapPin,
  Star,
  Trash2,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { memo, useCallback, useMemo, useState } from "react";

import { useConfirm } from "@/app/_components/confirm-dialog";
import { currency, EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import {
  DataTable,
  FilterBar,
  FilterSelect,
  InitialsAvatar,
  ListPager,
  MetricCard,
  PortalPageHeader,
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
import { DemoDataBadge, Hostel, Message } from "./core-portal-shared";

/**
 * The Archived tab reads a different endpoint, not a different slice of this
 * one — an archived hostel is excluded from every other platform read, which is
 * the whole point of archiving it.
 */
const ARCHIVED_TAB = "ARCHIVED";

const TABS = [
  { key: "PUBLISHED", label: "Live" },
  { key: "APPROVED", label: "Approved, not live" },
  { key: "DRAFT", label: "Draft" },
  { key: "ALL", label: "All" },
  { key: ARCHIVED_TAB, label: "Archived" },
];

const PAGE_SIZE = 10;

/** Whole days left before the purge cron erases an archived hostel. */
function daysUntilPurge(purgeScheduledAt: string | null | undefined) {
  if (!purgeScheduledAt) return null;
  const due = new Date(purgeScheduledAt).getTime();
  if (Number.isNaN(due)) return null;
  return Math.max(0, Math.ceil((due - Date.now()) / (24 * 60 * 60 * 1000)));
}

/**
 * A rough completeness score so the owner can spot thin listings — the same
 * signals a visitor judges a hostel on.
 */
function listingQuality(hostel: Hostel) {
  const checks = [
    hostel.photos.length >= 3,
    Boolean(hostel.description && hostel.description.length > 80),
    hostel.facilities.length >= 3,
    Boolean(hostel.pricing?.monthlyRentMin),
    Boolean(hostel.contact?.phone),
    hostel.rules.length > 0,
  ];

  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

export const PlatformListingsPageContent = memo(function PlatformListingsPageContent() {
  const invalidate = useInvalidateResources();
  const [actionMessage, setActionMessage] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("PUBLISHED");
  const [cityFilter, setCityFilter] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);

  const showingArchived = tab === ARCHIVED_TAB;

  const liveResource = usePortalResource<{ hostels: Hostel[] }>(
    platformEndpoints.hostels,
    { errorMessage: "Could not load listings." },
  );
  // Fetched only once the Archived tab is opened. This page is about what the
  // public can see, and archived hostels are dead weight on every other tab.
  const archivedResource = usePortalResource<{ hostels: Hostel[] }>(
    showingArchived ? platformEndpoints.hostelsArchived : null,
    { errorMessage: "Could not load archived listings." },
  );
  const hostelsResource = showingArchived ? archivedResource : liveResource;

  const hostels = useMemo(
    () => hostelsResource.data?.hostels ?? [],
    [hostelsResource.data],
  );
  // The four metric cards describe the platform, so they always read the live
  // list — a "Live Listings" count sourced from the archived queue is a lie.
  const liveHostels = useMemo(
    () => liveResource.data?.hostels ?? [],
    [liveResource.data],
  );
  const state = hostelsResource.state;
  const message = actionMessage || hostelsResource.message;

  /**
   * Archive, and undo it. Both move a hostel between the two lists, so both
   * invalidate both — dropping only the one on screen leaves the other holding
   * a hostel that is no longer in it.
   */
  const archiveAction = useCallback(
    async (hostel: Hostel, next: "archive" | "restore") => {
      let body = JSON.stringify({});

      if (next === "archive") {
        const confirmed = window.confirm(
          `Archive "${hostel.name}"?\n\nIt comes off the public site and out of its own portal immediately, and its staff and residents are signed out.\n\nIt can be restored for 60 days. After that it is erased permanently, along with its residents, invoices, payments and photos.`,
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
        await browserApi(`${platformEndpoints.hostel(hostel.id)}/${next}`, {
          body,
          method: "PATCH",
        });
        setActionMessage(
          next === "archive"
            ? `"${hostel.name}" archived — restorable for 60 days.`
            : `"${hostel.name}" restored.`,
        );
        invalidate(
          platformEndpoints.hostels,
          platformEndpoints.hostelsArchived,
          platformEndpoints.hostelDetails,
        );
      } catch (error) {
        setActionMessage(error instanceof Error ? error.message : "Action failed.");
      } finally {
        setBusy(false);
      }
    },
    [invalidate],
  );

  const { confirm, confirmDialog } = useConfirm();

  /**
   * Suspend for an unpaid plan, and undo it.
   *
   * Suspending closes nothing today. It emails the owner the unpaid plan
   * invoice and starts three days of pre-suspension; after that every portal
   * tied to the hostel stops until the plan is paid. Paying in full lifts it
   * without anyone coming back here — Lift is for a mistake.
   */
  const suspensionAction = useCallback(
    async (hostel: Hostel, next: "suspend" | "lift") => {
      const confirmed = await confirm(
        next === "suspend"
          ? {
              actionLabel: "Suspend",
              description:
                "Reason: plan payment not received. The owner is emailed the unpaid plan invoice now. The portal keeps working for 3 days, with a countdown for the owner and wardens. After that the admin, warden, resident, guardian and cook portals stop until the plan is paid. Paying in full lifts it automatically.",
              title: `Suspend "${hostel.name}"?`,
              tone: "destructive",
            }
          : {
              actionLabel: "Lift suspension",
              description:
                "The portal opens again right away for everyone at this hostel. The unpaid invoice stays open.",
              title: `Lift the suspension on "${hostel.name}"?`,
            },
      );

      if (!confirmed) return;

      setBusy(true);
      try {
        const result = await browserApi<{
          notification?: { reason?: string; sent: boolean; to?: string };
        }>(`${platformEndpoints.hostel(hostel.id)}/suspend`, {
          ...(next === "suspend"
            ? { body: JSON.stringify({ reason: "PLAN_PAYMENT" }), method: "PATCH" }
            : { method: "DELETE" }),
        });

        const notification = result?.notification;

        setActionMessage(
          next === "lift"
            ? `"${hostel.name}" suspension lifted.`
            : notification && !notification.sent
              ? `"${hostel.name}" is in pre-suspension, but the owner was NOT emailed (${notification.reason ?? "unknown error"}). Contact ${notification.to || "the owner"} manually.`
              : `"${hostel.name}" is in pre-suspension. The owner has been emailed the invoice.`,
        );
        invalidate(platformEndpoints.hostels, platformEndpoints.hostelDetails);
      } catch (error) {
        setActionMessage(error instanceof Error ? error.message : "Action failed.");
      } finally {
        setBusy(false);
      }
    },
    [confirm, invalidate],
  );

  /**
   * Recharge a hostel's plan by hand: the months add onto what is running and
   * the chosen plan becomes the live one. No payment is checked yet.
   */
  const rechargeAction = useCallback(
    async (hostel: Hostel) => {
      let plans: { id: string; monthly: number; name: string }[] = [];
      try {
        const site = await browserApi<{
          config: { plans?: { plans?: { id: string; monthly: number; name: string }[] } };
        }>("/api/v1/public/site-config");
        plans = site?.config.plans?.plans ?? [];
      } catch {
        // Falls through to the empty-catalogue message below.
      }

      if (!plans.length) {
        setActionMessage("No plans are configured to recharge with.");
        return;
      }

      const picked = window.prompt(
        `Recharge "${hostel.name}" — which plan?\n\n${plans
          .map((plan, index) => `${index + 1}. ${plan.name} (${currency(plan.monthly)}/month)`)
          .join("\n")}\n\nType the number:`,
      );
      if (picked === null) return;
      const plan = plans[Number(picked) - 1];
      if (!plan) {
        setActionMessage("No such plan — nothing was recharged.");
        return;
      }

      const months = Number(
        window.prompt(`How many months of ${plan.name} to add (1–12)?`, "1"),
      );
      if (!Number.isInteger(months) || months < 1 || months > 12) {
        setActionMessage("Months must be 1–12 — nothing was recharged.");
        return;
      }

      setBusy(true);
      try {
        const result = await browserApi<{ currentPeriodEnd: string; planName: string }>(
          `${platformEndpoints.hostel(hostel.id)}/recharge`,
          { body: JSON.stringify({ months, planId: plan.id }), method: "POST" },
        );
        setActionMessage(
          `"${hostel.name}" recharged: ${result?.planName ?? plan.name}, paid till ${
            result ? new Date(result.currentPeriodEnd).toLocaleDateString() : "—"
          }.`,
        );
        invalidate(platformEndpoints.hostels, platformEndpoints.hostelDetails);
      } catch (error) {
        setActionMessage(error instanceof Error ? error.message : "Recharge failed.");
      } finally {
        setBusy(false);
      }
    },
    [invalidate],
  );

  /**
   * Erase an archived hostel now rather than waiting out its 60 days.
   *
   * Guarded by typing the hostel's name, not an OK button. Nothing else in this
   * portal destroys data that cannot be recovered, and a confirm dialog is a
   * reflex — typing the name is the only guard that requires having read which
   * hostel you are on.
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
        invalidate(
          platformEndpoints.hostels,
          platformEndpoints.hostelsArchived,
          platformEndpoints.hostelDetails,
        );
      } catch (error) {
        setActionMessage(error instanceof Error ? error.message : "Erase failed.");
      } finally {
        setBusy(false);
      }
    },
    [invalidate],
  );

  const action = useCallback(
    async (hostelId: string, next: "publish" | "unpublish") => {
      let body = JSON.stringify({});

      if (next === "unpublish") {
        // Required: the owner is emailed this reason verbatim.
        const reason = window
          .prompt(
            "Why is this listing being unpublished? The owner will see this reason.",
          )
          ?.trim();
        if (!reason) return;
        body = JSON.stringify({ reason });
      }

      try {
        const result = await browserApi<{
          notification?: { reason?: string; sent: boolean; to?: string };
        }>(`${platformEndpoints.hostel(hostelId)}/${next}`, {
          body,
          method: "PATCH",
        });

        const notification = result?.notification;

        setActionMessage(
          notification && !notification.sent
            ? `Listing ${next}ed, but the owner was NOT emailed (${notification.reason ?? "unknown error"}). Contact ${notification.to ?? "the owner"} manually.`
            : `Listing ${next}ed.`,
        );
        invalidate(platformEndpoints.hostels, platformEndpoints.hostelDetails);
      } catch (error) {
        setActionMessage(error instanceof Error ? error.message : "Action failed.");
      }
    },
    [invalidate],
  );

  const counts = useMemo(
    () => ({
      approved: liveHostels.filter((hostel) => hostel.status === "APPROVED").length,
      lowQuality: liveHostels.filter((hostel) => listingQuality(hostel) < 60).length,
      noPhotos: liveHostels.filter((hostel) => hostel.photos.length === 0).length,
      published: liveHostels.filter((hostel) => hostel.status === "PUBLISHED").length,
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
      // The archived list is already scoped by the endpoint; its rows keep
      // whatever listing status they held when they were archived, so matching
      // on `status` here would filter all of them out.
      if (tab !== "ALL" && !showingArchived && hostel.status !== tab) return false;
      if (cityFilter && hostel.location.city !== cityFilter) return false;
      if (!term) return true;
      return `${hostel.name} ${hostel.slug} ${hostel.location.area}`
        .toLowerCase()
        .includes(term);
    });
  }, [cityFilter, hostels, query, showingArchived, tab]);

  const paged = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page],
  );

  const tabCount = (key: string) => {
    // The archived count comes from its own list, and only once that list has
    // been fetched. The other four always count the live one, so the numbers
    // stay put when the Archived tab is open.
    if (key === ARCHIVED_TAB) {
      return archivedResource.data?.hostels.length;
    }
    if (key === "ALL") {
      return liveHostels.length;
    }
    return liveHostels.filter((hostel) => hostel.status === key).length;
  };

  return (
    <div className="mx-auto max-w-[1448px] space-y-4">
      <PortalPageHeader
        breadcrumb={["Home", "Listings"]}
        description="Manage what the public actually sees — live listings, their completeness, and visibility."
        title="Listings"
      />
      <Message value={message} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={Globe}
          label="Live Listings"
          note="Visible to the public"
          noteTone="green"
          tone="green"
          value={counts.published}
        />
        <MetricCard
          icon={Star}
          label="Approved, Not Live"
          note="Ready to publish"
          noteTone="amber"
          tone="amber"
          value={counts.approved}
        />
        <MetricCard
          icon={ImageIcon}
          label="Missing Photos"
          note="Hurts conversion"
          noteTone="rose"
          tone="rose"
          value={counts.noPhotos}
        />
        <MetricCard
          icon={MapPin}
          label="Thin Listings"
          note="Under 60% complete"
          noteTone="amber"
          tone="teal"
          value={counts.lowQuality}
        />
      </div>

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
            placeholder="Search listings by name or area..."
            value={query}
          />
          <div className="flex flex-wrap gap-2">
            <FilterSelect
              defaultLabel="All Cities"
              onChange={(next) => {
                setCityFilter(next);
                setPage(1);
              }}
              options={cities}
              value={cityFilter}
            />
            <FilterSelect
              defaultLabel="All Types"
              options={["BOYS", "GIRLS", "CO_LIVING"]}
            />
          </div>
        </FilterBar>

        {state === "loading" ? <LoadingRows /> : null}
        {state === "error" ? <EmptyState label="Listings could not be loaded." /> : null}
        {state === "ready" && filtered.length === 0 ? (
          <EmptyState label="No listings match these filters." />
        ) : null}

        {state === "ready" && filtered.length > 0 ? (
          <>
            <DataTable className="min-w-[900px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <Th>Listing</Th>
                  <Th>Location</Th>
                  <Th>Type</Th>
                  <Th align="right">From</Th>
                  <Th align="center">Photos</Th>
                  <Th>Completeness</Th>
                  <Th>Status</Th>
                  <Th align="right">Actions</Th>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paged.map((hostel) => {
                  const quality = listingQuality(hostel);

                  return (
                    <TableRow key={hostel.id}>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <InitialsAvatar name={hostel.name} size="sm" tone="platform" />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Link
                                className="truncate font-semibold text-foreground hover:text-role-platform"
                                href={`/platform/hostels/${hostel.id}`}
                              >
                                {hostel.name}
                              </Link>
                              {hostel.isDemoData ? (
                                <DemoDataBadge label={hostel.demoDataLabel} />
                              ) : null}
                            </div>
                            <p className="truncate text-[11px] text-muted-foreground">
                              /{hostel.slug}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {hostel.location.area}
                        {hostel.location.city ? `, ${hostel.location.city}` : ""}
                      </TableCell>
                      <TableCell>
                        <SoftBadge tone="teal">
                          {hostel.hostelType.replaceAll("_", " ")}
                        </SoftBadge>
                      </TableCell>
                      <TableCell className="text-right font-medium text-foreground">
                        {hostel.pricing?.monthlyRentMin
                          ? currency(hostel.pricing.monthlyRentMin)
                          : "—"}
                      </TableCell>
                      <TableCell className="text-center text-muted-foreground">
                        {hostel.photos.length}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                            <span
                              className={
                                quality >= 80
                                  ? "block h-full rounded-full bg-emerald-500"
                                  : quality >= 60
                                    ? "block h-full rounded-full bg-amber-500"
                                    : "block h-full rounded-full bg-rose-500"
                              }
                              style={{ width: `${quality}%` }}
                            />
                          </span>
                          <span className="text-[11px] font-semibold text-muted-foreground">
                            {quality}%
                          </span>
                        </div>
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
                          <div className="space-y-0.5">
                            <SoftBadge tone={statusToneFromLabel(hostel.status)}>
                              {hostel.status.replaceAll("_", " ")}
                            </SoftBadge>
                            {hostel.suspension ? (
                              <p
                                className={
                                  hostel.suspension.stage === "SUSPENDED"
                                    ? "text-[11px] font-semibold text-destructive"
                                    : "text-[11px] font-semibold text-amber-700 dark:text-amber-300"
                                }
                              >
                                {hostel.suspension.stage === "SUSPENDED"
                                  ? "Suspended · plan unpaid"
                                  : `Pre-suspension · stops ${new Date(
                                      hostel.suspension.graceEndsAt,
                                    ).toLocaleString("en-GB", {
                                      day: "numeric",
                                      hour: "numeric",
                                      minute: "2-digit",
                                      month: "short",
                                      timeZone: "Asia/Kathmandu",
                                    })}`}
                              </p>
                            ) : null}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          {hostel.isArchived ? (
                            <>
                              <button
                                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-role-platform transition hover:bg-role-platform-soft disabled:opacity-40"
                                disabled={busy}
                                onClick={() => void archiveAction(hostel, "restore")}
                                type="button"
                              >
                                <ArchiveRestore className="size-3.5" />
                                Restore
                              </button>
                              <button
                                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-destructive transition hover:bg-destructive/10 disabled:opacity-40"
                                disabled={busy}
                                onClick={() => void purgeNow(hostel)}
                                type="button"
                              >
                                <Trash2 className="size-3.5" />
                                Erase now
                              </button>
                            </>
                          ) : hostel.status === "PUBLISHED" ? (
                            <>
                              <a
                                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-role-platform transition hover:bg-role-platform-soft"
                                href={`/hostels/${hostel.slug}`}
                                rel="noreferrer noopener"
                                target="_blank"
                              >
                                <Globe className="size-3.5" />
                                View
                              </a>
                              <button
                                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-amber-700 transition hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/40"
                                onClick={() => action(hostel.id, "unpublish")}
                                type="button"
                              >
                                <EyeOff className="size-3.5" />
                                Unpublish
                              </button>
                            </>
                          ) : hostel.status === "APPROVED" ? (
                            <button
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-emerald-700 transition hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
                              onClick={() => action(hostel.id, "publish")}
                              type="button"
                            >
                              <Globe className="size-3.5" />
                              Publish
                            </button>
                          ) : null}
                          {/* A suspension is for a hostel with a portal to
                              lose: one that is live, or approved and waiting. */}
                          {hostel.isArchived ||
                          (hostel.status !== "PUBLISHED" &&
                            hostel.status !== "APPROVED") ? null : hostel.suspension ? (
                            <button
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-role-platform transition hover:bg-role-platform-soft disabled:opacity-40"
                              disabled={busy}
                              onClick={() => void suspensionAction(hostel, "lift")}
                              type="button"
                            >
                              <LockOpen className="size-3.5" />
                              Lift
                            </button>
                          ) : (
                            <button
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-destructive transition hover:bg-destructive/10 disabled:opacity-40"
                              disabled={busy}
                              onClick={() => void suspensionAction(hostel, "suspend")}
                              type="button"
                            >
                              <Ban className="size-3.5" />
                              Suspend
                            </button>
                          )}
                          {hostel.isArchived ? null : (
                            <button
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:opacity-40 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
                              disabled={busy}
                              onClick={() => void rechargeAction(hostel)}
                              type="button"
                            >
                              <Zap className="size-3.5" />
                              Recharge
                            </button>
                          )}
                          {/* Offered at every stage — a listing can be a
                              mistaken draft as easily as a closed business —
                              and never on a row that is already archived. */}
                          {hostel.isArchived ? null : (
                            <button
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-destructive transition hover:bg-destructive/10 disabled:opacity-40"
                              disabled={busy}
                              onClick={() => void archiveAction(hostel, "archive")}
                              type="button"
                            >
                              <Archive className="size-3.5" />
                              Archive
                            </button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </DataTable>
            <ListPager
              onPageChange={setPage}
              page={page}
              pageSize={PAGE_SIZE}
              showPageSize
              total={filtered.length}
              unit="listings"
            />
          </>
        ) : null}
      </Panel>
      {confirmDialog}
    </div>
  );
});
