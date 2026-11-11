"use client";

import { formatHostelDate, formatHostelDateTime } from "@hostel/shared/calendar/bs";
import Link from "next/link";
import { memo, useCallback, useMemo, useState } from "react";

import { useConfirm } from "@/app/_components/confirm-dialog";
import { currency, EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import {
  DataTable,
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
} from "@/app/_components/portal-dashboard-ui";
import {
  Ban,
  CalendarClock,
  CreditCard,
  LockOpen,
  Receipt,
  Zap,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { browserApi } from "@/lib/browser-api";
import { platformEndpoints } from "@/lib/platform-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { Hostel, Message } from "./core-portal-shared";
import { MoreMenu } from "./platform-page-ui";

type HostelPlan = {
  currentPeriodEnd: string | null;
  cycle: string | null;
  dueBy: string | null;
  freeUntil: string | null;
  hostelId: string;
  lifetime: boolean;
  planId: string | null;
  planName: string | null;
  status: string;
  trialEndsAt: string | null;
};

type PlanInvoice = { hostelId: string; outstanding: number; status: string };
type CatalogPlan = { id: string; monthly: number; name: string };

type Standing =
  | "LIFETIME"
  | "ACTIVE"
  | "DUE"
  | "EXPIRED"
  | "TRIAL"
  | "FREE"
  | "UNPAID"
  | "CANCELLED"
  | "NONE";

const STANDING: Record<
  Standing,
  { label: string; tone: "green" | "amber" | "rose" | "teal" | "slate" }
> = {
  ACTIVE: { label: "ACTIVE", tone: "green" },
  CANCELLED: { label: "CANCELLED", tone: "slate" },
  DUE: { label: "PAST DUE", tone: "amber" },
  EXPIRED: { label: "EXPIRED", tone: "rose" },
  FREE: { label: "FREE MONTHS", tone: "teal" },
  LIFETIME: { label: "LIFETIME", tone: "green" },
  NONE: { label: "NO PLAN", tone: "slate" },
  TRIAL: { label: "TRIAL", tone: "teal" },
  UNPAID: { label: "NOT PAID", tone: "amber" },
};

const DAY = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 12;
const EXPIRING_DAYS = 14;

const future = (iso: string | null, now: number) => Boolean(iso && Date.parse(iso) > now);

/** One word for where a hostel's plan stands today, from the stored state and its dates. */
function standingOf(plan: HostelPlan | undefined, now: number): Standing {
  if (!plan) return "NONE";
  if (plan.lifetime) return "LIFETIME";
  if (plan.status === "CANCELLED") return "CANCELLED";
  if (plan.status === "PAST_DUE")
    return future(plan.currentPeriodEnd, now) ? "DUE" : "EXPIRED";
  if (plan.status === "ACTIVE")
    return future(plan.currentPeriodEnd, now) ? "ACTIVE" : "EXPIRED";
  if (plan.status === "EXPIRED") return "EXPIRED";
  if (future(plan.freeUntil, now)) return "FREE";
  if (future(plan.trialEndsAt, now)) return "TRIAL";
  return "UNPAID";
}

/** The date that matters for this standing: when it runs out, or when it was due. */
function runsOutOf(plan: HostelPlan | undefined, standing: Standing) {
  if (!plan || standing === "LIFETIME") return null;
  if (standing === "FREE") return plan.freeUntil;
  if (standing === "TRIAL") return plan.trialEndsAt;
  if (standing === "UNPAID") return plan.dueBy;
  return plan.currentPeriodEnd;
}

function relative(iso: string, now: number) {
  const days = Math.round((Date.parse(iso) - now) / DAY);
  if (days === 0) return "today";
  return days > 0
    ? `in ${days} day${days === 1 ? "" : "s"}`
    : `${-days} day${days === -1 ? "" : "s"} ago`;
}

const TABS = [
  { key: "ALL", label: "All" },
  { key: "ACTIVE", label: "Active" },
  { key: "ATTENTION", label: "Due & expired" },
  { key: "FREE", label: "Trial & free" },
  { key: "SUSPENDED", label: "Suspended" },
  { key: "NONE", label: "No plan" },
];

const ATTENTION: Standing[] = ["DUE", "EXPIRED", "UNPAID"];

type Row = {
  hostel: Hostel;
  owed: number;
  plan?: HostelPlan;
  runsOut: string | null;
  standing: Standing;
};

function matchesTab(row: Row, tab: string) {
  switch (tab) {
    case "ACTIVE":
      return row.standing === "ACTIVE" || row.standing === "LIFETIME";
    case "ATTENTION":
      return ATTENTION.includes(row.standing);
    case "FREE":
      return row.standing === "TRIAL" || row.standing === "FREE";
    case "SUSPENDED":
      return Boolean(row.hostel.suspension);
    case "NONE":
      return row.standing === "NONE" || row.standing === "CANCELLED";
    default:
      return true;
  }
}

/**
 * Hostels → Subscriptions: every hostel's plan as it stands, and the two hands
 * a platform admin has on it — recharge and suspend. The money ledger itself
 * (invoices, receipts, claims) is Plan Billing under Finance.
 */
export const PlatformHostelSubscriptionsPageContent = memo(
  function PlatformHostelSubscriptionsPageContent() {
    const invalidate = useInvalidateResources();
    const { confirm, confirmDialog } = useConfirm();
    const [actionMessage, setActionMessage] = useState("");
    const [query, setQuery] = useState("");
    const [tab, setTab] = useState("ALL");
    const [page, setPage] = useState(1);
    const [busy, setBusy] = useState(false);
    const [rechargeFor, setRechargeFor] = useState<Row | null>(null);
  // One instant for the whole screen, so every row is judged against the same "now".
  const [now] = useState(() => Date.now());

    const hostelsResource = usePortalResource<{ hostels: Hostel[] }>(
      platformEndpoints.hostels,
      {
        errorMessage: "Could not load hostels.",
      },
    );
    const plansResource = usePortalResource<{ subscriptions: HostelPlan[] }>(
      platformEndpoints.hostelPlans,
      {
        errorMessage: "Could not load hostel plans.",
      },
    );
    // What is still owed, from each hostel's newest plan invoice (newest-first).
    const ledgerResource = usePortalResource<{ invoices: PlanInvoice[] }>(
      `${platformEndpoints.subscriptions}?limit=500`,
      { errorMessage: "Could not load plan billing." },
    );
    const rows = useMemo<Row[]>(() => {
      const planBy = new Map(
        (plansResource.data?.subscriptions ?? []).map((plan) => [plan.hostelId, plan]),
      );
      const owedBy = new Map<string, number>();
      for (const invoice of ledgerResource.data?.invoices ?? []) {
        if (!owedBy.has(invoice.hostelId)) {
          owedBy.set(
            invoice.hostelId,
            invoice.status === "VOID" ? 0 : Math.max(0, invoice.outstanding),
          );
        }
      }

      return (hostelsResource.data?.hostels ?? []).map((hostel) => {
        const plan = planBy.get(hostel.id);
        const standing = standingOf(plan, now);
        return {
          hostel,
          owed: owedBy.get(hostel.id) ?? 0,
          plan,
          runsOut: runsOutOf(plan, standing),
          standing,
        };
      });
    }, [hostelsResource.data, ledgerResource.data, now, plansResource.data]);

    const counts = useMemo(() => {
      return {
        active: rows.filter((row) => matchesTab(row, "ACTIVE")).length,
        attention: rows.filter((row) => matchesTab(row, "ATTENTION")).length,
        expiring: rows.filter(
          (row) =>
            row.standing === "ACTIVE" &&
            row.runsOut &&
            Date.parse(row.runsOut) - now < EXPIRING_DAYS * DAY,
        ).length,
        suspended: rows.filter((row) => row.hostel.suspension).length,
      };
    }, [now, rows]);

    const filtered = useMemo(() => {
      const term = query.trim().toLowerCase();
      return rows.filter((row) => {
        if (!matchesTab(row, tab)) return false;
        if (!term) return true;
        return `${row.hostel.name} ${row.hostel.slug} ${row.hostel.location.city ?? ""} ${row.plan?.planName ?? ""}`
          .toLowerCase()
          .includes(term);
      });
    }, [query, rows, tab]);

    const paged = useMemo(
      () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      [filtered, page],
    );

    const switchTab = (next: string) => {
      setTab(next);
      setPage(1);
    };

    const refresh = useCallback(
      () =>
        invalidate(
          platformEndpoints.hostels,
          platformEndpoints.hostelPlans,
          platformEndpoints.subscriptions,
          platformEndpoints.hostelDetails,
        ),
      [invalidate],
    );

    /**
     * Suspend for an unpaid plan, and undo it. Suspending emails the owner the
     * unpaid invoice and starts three days of pre-suspension; after that every
     * portal at the hostel stops until the plan is paid. Paying in full (or a
     * recharge here) lifts it — Lift is for a mistake.
     */
    const suspension = useCallback(
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
          }>(
            `${platformEndpoints.hostel(hostel.id)}/suspend`,
            next === "suspend"
              ? { body: JSON.stringify({ reason: "PLAN_PAYMENT" }), method: "PATCH" }
              : { method: "DELETE" },
          );
          const notification = result?.notification;
          setActionMessage(
            next === "lift"
              ? `"${hostel.name}" suspension lifted.`
              : notification && !notification.sent
                ? `"${hostel.name}" is in pre-suspension, but the owner was NOT emailed (${notification.reason ?? "unknown error"}). Contact ${notification.to || "the owner"} manually.`
                : `"${hostel.name}" is in pre-suspension. The owner has been emailed the invoice.`,
          );
          refresh();
        } catch (error) {
          setActionMessage(error instanceof Error ? error.message : "Action failed.");
        } finally {
          setBusy(false);
        }
      },
      [confirm, refresh],
    );

    const state =
      hostelsResource.state === "error" || plansResource.state === "error"
        ? "error"
        : hostelsResource.state === "ready" && plansResource.state === "ready"
          ? "ready"
          : "loading";
    const message = actionMessage || hostelsResource.message || plansResource.message;

    return (
      <div className="mx-auto max-w-[1448px] space-y-4">
        <PortalPageHeader
          description="Every hostel's plan, and when it runs out."
          title="Subscriptions"
        />
        <Message value={message} />

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            active={tab === "ACTIVE"}
            icon={CreditCard}
            label="On a paid plan"
            onClick={() => switchTab("ACTIVE")}
            value={counts.active}
          />
          <MetricCard
            icon={CalendarClock}
            label={`Run out within ${EXPIRING_DAYS} days`}
            tone={counts.expiring > 0 ? "amber" : "teal"}
            value={counts.expiring}
          />
          <MetricCard
            active={tab === "ATTENTION"}
            icon={Receipt}
            label="Due or expired"
            onClick={() => switchTab("ATTENTION")}
            tone={counts.attention > 0 ? "rose" : "teal"}
            value={counts.attention}
          />
          <MetricCard
            active={tab === "SUSPENDED"}
            icon={Ban}
            label="Suspended"
            onClick={() => switchTab("SUSPENDED")}
            tone={counts.suspended > 0 ? "rose" : "teal"}
            value={counts.suspended}
          />
        </div>

        <Panel>
          <TabBar
            className="mb-3"
            onChange={switchTab}
            tabs={TABS.map((item) => ({
              ...item,
              count: rows.filter((row) => matchesTab(row, item.key)).length,
            }))}
            value={tab}
          />
          <div className="mb-3">
            <SearchField
              onChange={(next) => {
                setQuery(next);
                setPage(1);
              }}
              placeholder="Search hostel or plan"
              value={query}
            />
          </div>

          {state === "loading" ? <LoadingRows /> : null}
          {state === "error" ? (
            <EmptyState label="Subscriptions could not be loaded." />
          ) : null}
          {state === "ready" && filtered.length === 0 ? (
            <EmptyState label="No hostels match." />
          ) : null}

          {state === "ready" && filtered.length > 0 ? (
            <>
              <DataTable className="min-w-[900px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <Th>Hostel</Th>
                    <Th>Plan</Th>
                    <Th>Standing</Th>
                    <Th>Runs out</Th>
                    <Th align="right">Owed</Th>
                    <Th align="right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paged.map((row) => {
                    const { hostel, plan, standing } = row;
                    // A branch bills to its main hostel: nothing to recharge or
                    // suspend on the branch itself.
                    const branch = Boolean(hostel.branchOf);
                    // A suspension is for a hostel with a portal to lose.
                    const suspendable =
                      hostel.status === "PUBLISHED" || hostel.status === "APPROVED";

                    return (
                      <TableRow key={hostel.id}>
                        <TableCell>
                          <div className="flex items-center gap-2.5">
                            <InitialsAvatar name={hostel.name} size="sm" tone="team" />
                            <div className="min-w-0">
                              <Link
                                className="truncate text-[13.5px] font-semibold text-foreground hover:text-role-team"
                                href={`/platform/hostels/${hostel.id}`}
                              >
                                {hostel.name}
                              </Link>
                              <p className="truncate text-[12px] text-muted-foreground">
                                {branch
                                  ? `Branch · billed to ${hostel.branchOf?.name}`
                                  : [hostel.location.area, hostel.location.city]
                                      .filter(Boolean)
                                      .join(", ")}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <p className="text-[12.5px] font-semibold text-foreground">
                            {plan?.planName ?? "—"}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {plan?.lifetime
                              ? "Lifetime"
                              : plan?.cycle
                                ? plan.cycle.replace("halfYearly", "half-yearly")
                                : ""}
                          </p>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-0.5">
                            <SoftBadge tone={STANDING[standing].tone}>
                              {STANDING[standing].label}
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
                                  ? "Suspended"
                                  : `Pre-suspension · stops ${formatHostelDateTime(hostel.suspension.graceEndsAt)}`}
                              </p>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          {row.runsOut ? (
                            <>
                              <p className="text-[12.5px] font-medium text-foreground">
                                {formatHostelDate(row.runsOut)}
                              </p>
                              <p
                                className={
                                  Date.parse(row.runsOut) < now
                                    ? "text-[11px] font-semibold text-destructive"
                                    : "text-[11px] text-muted-foreground"
                                }
                              >
                                {relative(row.runsOut, now)}
                              </p>
                            </>
                          ) : (
                            <span className="text-[12px] text-muted-foreground">
                              {standing === "LIFETIME" ? "Never" : "—"}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-medium text-foreground">
                          {row.owed > 0 ? (
                            currency(row.owed)
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {branch ? null : (
                            <div className="flex items-center justify-end gap-1">
                              {standing === "LIFETIME" ? null : (
                                <button
                                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-semibold text-role-team transition hover:bg-role-team-soft disabled:opacity-40"
                                  disabled={busy}
                                  onClick={() => setRechargeFor(row)}
                                  type="button"
                                >
                                  <Zap className="size-3.5" />
                                  Recharge
                                </button>
                              )}
                              {suspendable ? (
                                <MoreMenu label={`More for ${hostel.name}`} row>
                                  {hostel.suspension ? (
                                    <DropdownMenuItem
                                      disabled={busy}
                                      onSelect={() => void suspension(hostel, "lift")}
                                    >
                                      <LockOpen className="size-4" />
                                      Lift suspension
                                    </DropdownMenuItem>
                                  ) : (
                                    <DropdownMenuItem
                                      disabled={busy}
                                      onSelect={() => void suspension(hostel, "suspend")}
                                      variant="destructive"
                                    >
                                      <Ban className="size-4" />
                                      Suspend
                                    </DropdownMenuItem>
                                  )}
                                </MoreMenu>
                              ) : null}
                            </div>
                          )}
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
                unit="hostels"
              />
            </>
          ) : null}
        </Panel>

        <RechargeDialog
          onClose={() => setRechargeFor(null)}
          onDone={(text) => {
            setActionMessage(text);
            refresh();
          }}
          row={rechargeFor}
        />
        {confirmDialog}
      </div>
    );
  },
);

/**
 * Recharge by hand: the months add onto what is running and the chosen plan
 * becomes the live one. No payment is checked; a running suspension is lifted.
 */
function RechargeDialog({
  onClose,
  onDone,
  row,
}: {
  onClose: () => void;
  onDone: (message: string) => void;
  row: Row | null;
}) {
  const site = usePortalResource<{ config: { plans?: { plans?: CatalogPlan[] } } }>(
    row ? "/api/v1/public/site-config" : null,
    { errorMessage: "Could not load the plan catalogue." },
  );
  const plans = site.data?.config.plans?.plans ?? [];
  const [planId, setPlanId] = useState("");
  const [months, setMonths] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Default to the plan the hostel is on, else the first in the catalogue.
  const chosen =
    plans.find((plan) => plan.id === planId) ??
    plans.find((plan) => plan.id === row?.plan?.planId) ??
    plans[0];

  const close = () => {
    if (busy) return;
    setPlanId("");
    setMonths(1);
    setError("");
    onClose();
  };

  const submit = async () => {
    if (!row || !chosen) return;
    setBusy(true);
    setError("");
    try {
      const result = await browserApi<{ currentPeriodEnd: string; planName: string }>(
        `${platformEndpoints.hostel(row.hostel.id)}/recharge`,
        { body: JSON.stringify({ months, planId: chosen.id }), method: "POST" },
      );
      onDone(
        `"${row.hostel.name}" recharged: ${result?.planName ?? chosen.name}, paid till ${
          result ? formatHostelDate(result.currentPeriodEnd) : "—"
        }.`,
      );
      setBusy(false);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Recharge failed.");
      setBusy(false);
    }
  };

  const select =
    "mt-1 h-10 w-full rounded-xl border border-border bg-background px-3 text-[13.5px] font-normal text-foreground";

  return (
    <Dialog onOpenChange={(open) => (open ? null : close())} open={Boolean(row)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Recharge {row?.hostel.name}</DialogTitle>
          <DialogDescription>
            {row?.runsOut && row.standing === "ACTIVE"
              ? `Months add on after ${formatHostelDate(row.runsOut)}.`
              : "Months start from today."}{" "}
            No payment is checked. A running suspension is lifted.
          </DialogDescription>
        </DialogHeader>

        {site.state === "loading" ? <LoadingRows /> : null}
        {site.state === "ready" && plans.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            No plans are configured to recharge with.
          </p>
        ) : null}

        {plans.length > 0 ? (
          <div className="space-y-3">
            <label className="block text-[12px] font-semibold text-foreground">
              Plan
              <select
                className={select}
                onChange={(event) => setPlanId(event.target.value)}
                value={chosen?.id ?? ""}
              >
                {plans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name} · {currency(plan.monthly)}/month
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[12px] font-semibold text-foreground">
              Months
              <select
                className={select}
                onChange={(event) => setMonths(Number(event.target.value))}
                value={months}
              >
                {Array.from({ length: 12 }, (_, index) => index + 1).map((count) => (
                  <option key={count} value={count}>
                    {count} month{count === 1 ? "" : "s"}
                    {chosen ? ` · ${currency(chosen.monthly * count)}` : ""}
                  </option>
                ))}
              </select>
            </label>
            {error ? (
              <p className="text-[12.5px] font-medium text-destructive">{error}</p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button disabled={busy} onClick={close} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!chosen || busy}
            loading={busy}
            onClick={() => void submit()}
            type="button"
          >
            Recharge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
