"use client";

import { AlertTriangle, ArrowRight, Building2, FileSpreadsheet, Plus, QrCode, Wallet } from "@/components/icons";
import Link from "next/link";
import { useEffect, useState } from "react";

import { useCheckoutHandoff } from "@/app/_components/checkout-handoff";
import { MetricCard, PortalPageHeader, RoleButton } from "@/app/_components/portal-dashboard-ui";
import { FilterButton, FilterChoice } from "@/components/filter-panel";
import { GetAppDialog } from "@/components/get-app-dialog";
import { Glyph } from "@/components/glyph";
import { Button } from "@/components/ui/button";
import { browserApi } from "@/lib/browser-api";
import { cn } from "@/lib/utils";
import type { UnpublishedPrepayment } from "@/modules/team/team-prepayment.service";
import { formatBsAdDate, formatHostelDate } from "@hostel/shared/calendar/bs";
import { FactChip, ShareBar, titleCase } from "./daily-portal-ui";

/**
 * An agent's own desk: what they have filed, and what is still owed on it.
 *
 * Deliberately plain. This is a work surface somebody opens twenty times a day
 * standing in a corridor, so it is the shared page header, two big figures, a
 * number row and a card per hostel with its paid bar and the owner's number —
 * no illustration, no explanatory prose about what the field team does.
 * The person reading it is the field team.
 *
 * ## The order
 *
 * Newest registration first. The overdue ones carry their "Due" badge and a
 * Pay button, so they are found by eye rather than by sort.
 *
 * ## Why "cash in hand" is its own figure
 *
 * `collected` includes Fonepay payments, which went straight to the platform's
 * merchant account and never touched the agent. `cashCollected` is the money
 * that physically passed through their hands, and it is the only one that is
 * ever a conversation about reconciliation — so it is shown separately rather
 * than rolled into a single total that would misstate what they are answerable
 * for.
 */

type Registration = {
  area: string;
  cashCollected: number;
  city: string;
  dueBy: string | null;
  /** The last free day of the plan; null for a hostel that went live without free months. */
  freeUntil: string | null;
  hostelId: string;
  hostelName: string;
  hostelStatus: string;
  onlineCollected: number;
  /** Owed on the plan only. The setup fee is apart. */
  outstanding: number;
  ownerEmail: string;
  ownerPhone: string;
  paid: number;
  planName: string;
  price: number;
  registeredAt: string | null;
  /** Null on a hostel filed before setup fees. */
  setupFee: { amount: number; collected: number } | null;
  slug: string;
  subscriptionStatus: string;
};

/** "Free until Kartik 12" / "Rs 999" — what the plan line under a hostel says. */
function planLine(row: Registration) {
  return row.freeUntil && Date.parse(row.freeUntil) >= Date.now()
    ? `free until ${formatBsAdDate(new Date(row.freeUntil))}`
    : rupees(row.price);
}

type Wallet = {
  balance: number;
  earned: number;
  paidOut: number;
  pending: number;
  ratePercent: number;
  today: { commission: number; due: number; hostels: number; paid: number };
};

type WalletEntry = {
  amount: number;
  at: string;
  hostelName: string;
  id: string;
  method: string | null;
  type: "COMMISSION" | "PAYOUT";
};

type Summary = {
  cashCollected: number;
  collected: number;
  hostelsRegistered: number;
  outstanding: number;
  pastDue: number;
};

function rupees(amount: number) {
  return `Rs ${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function statusLabel(row: Registration) {
  if (row.subscriptionStatus === "PAST_DUE") {
    return row.dueBy
      ? `Due ${formatHostelDate(row.dueBy)}`
      : "Past due";
  }

  return row.subscriptionStatus === "ACTIVE" ? "Paid" : titleCase(row.subscriptionStatus);
}

function statusTone(status: string) {
  return status === "ACTIVE"
    ? "bg-role-team-soft text-role-team"
    : status === "PAST_DUE"
      ? "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
      : "bg-muted text-muted-foreground";
}

type Show = "ALL" | "OWES" | "PAID";

function Figure({ label, tone, value }: { label: string; tone?: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className={cn("truncate text-[15px] font-bold tabular-nums", tone ?? "text-foreground")}>{value}</p>
      <p className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
    </div>
  );
}

/**
 * Today's salary and the wallet it lands in.
 *
 * Commission is earned on a hostel's first plan payment, so "today" shows both
 * halves of that: what the hostels registered today have paid and still owe,
 * and what actually reached the wallet today.
 */
function EarningsRow({ entries, wallet }: { entries: WalletEntry[]; wallet: Wallet | null }) {
  const rate = wallet ? `${wallet.ratePercent}%` : "—";

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Today&apos;s salary
            </p>
            <p className="mt-1 font-heading text-[34px] font-bold leading-none tracking-tight text-foreground tabular-nums">
              {rupees(wallet?.today.commission ?? 0)}
            </p>
          </div>
          {/* The rate is of each new hostel's setup fee, credited once it clears. */}
          <span className="rounded-full bg-role-team-soft px-2.5 py-0.5 text-[11.5px] font-semibold text-role-team">
            {rate} of setup fees
          </span>
        </div>
        <div className="grid grid-cols-3 gap-3 border-t border-border/60 pt-3">
          <Figure label="Hostels added" value={String(wallet?.today.hostels ?? 0)} />
          <Figure label="Paid" tone="text-role-team" value={rupees(wallet?.today.paid ?? 0)} />
          <Figure label="Due" tone="text-amber-600" value={rupees(wallet?.today.due ?? 0)} />
        </div>
      </section>

      <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Wallet</p>
            <p className="mt-1 font-heading text-[34px] font-bold leading-none tracking-tight text-foreground tabular-nums">
              {rupees(wallet?.balance ?? 0)}
            </p>
          </div>
          <span className="flex size-11 items-center justify-center rounded-2xl bg-foreground text-background">
            <Glyph className="size-[22px]" name="wallet" variant="solid" />
          </span>
        </div>
        <ShareBar
          label={`${rupees(wallet?.paidOut ?? 0)} paid to you of ${rupees(wallet?.earned ?? 0)} earned`}
          total={wallet?.earned ?? 0}
          value={wallet?.paidOut ?? 0}
        />
        {(wallet?.pending ?? 0) > 0 ? (
          <p className="text-[12.5px] text-muted-foreground">{rupees(wallet?.pending ?? 0)} more once hostels pay.</p>
        ) : null}
        {entries.length > 0 ? (
          <ul className="divide-y divide-border/60 border-t border-border/60">
            {entries.slice(0, 4).map((entry) => (
              <li className="flex items-center justify-between gap-2 py-2 text-[12.5px]" key={entry.id}>
                <span className="min-w-0 truncate text-muted-foreground">
                  {entry.type === "COMMISSION"
                    ? entry.hostelName || "Commission"
                    : `Paid out${entry.method ? ` · ${entry.method}` : ""}`}
                  {" · "}
                  {formatHostelDate(entry.at)}
                </span>
                <span
                  className={cn(
                    "shrink-0 font-semibold tabular-nums",
                    entry.type === "COMMISSION" ? "text-role-team" : "text-foreground",
                  )}
                >
                  {entry.type === "COMMISSION" ? "+" : "−"}
                  {rupees(entry.amount)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

export function TeamDeskPage() {
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [entries, setEntries] = useState<WalletEntry[]>([]);
  const [paidWaiting, setPaidWaiting] = useState<UnpublishedPrepayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [show, setShow] = useState<Show>("ALL");
  const handoff = useCheckoutHandoff();

  /*
   * The balance, by Softmato QR on this device — the same checkout the owner's
   * own Pay opens. No amount is sent: the server charges what is still owed.
   */
  function payRemaining(row: Registration) {
    void handoff.start({
      back: "/team",
      endpoint: `/api/v1/team/hostels/${row.hostelId}/checkout`,
      preparing: "Setting up the remaining payment",
    });
  }

  useEffect(() => {
    async function load() {
      try {
        const [list, stats, money, waiting] = await Promise.all([
          browserApi<{ registrations: Registration[] }>("/api/v1/team/hostels"),
          browserApi<{ summary: Summary }>("/api/v1/team/summary"),
          browserApi<{ entries: WalletEntry[]; wallet: Wallet }>("/api/v1/team/wallet"),
          browserApi<{ prepayments: UnpublishedPrepayment[] }>("/api/v1/team/prepayments").catch(() => ({
            prepayments: [],
          })),
        ]);

        setPaidWaiting(waiting.prepayments);
        setRegistrations(list.registrations);
        setSummary(stats.summary);
        setWallet(money.wallet);
        setEntries(money.entries);
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, []);

  const visible = registrations.filter((row) =>
    show === "ALL" ? true : show === "OWES" ? row.outstanding > 0 : row.outstanding <= 0,
  );
  const collected = summary?.collected ?? 0;
  const outstanding = summary?.outstanding ?? 0;

  return (
    <div className="space-y-5">
      <PortalPageHeader
        actions={
          <>
            {/* Its own tab: the sheet is a full-screen page, kept open beside the desk. */}
            <Button asChild className="h-9 gap-2 rounded-xl" variant="outline">
              <a href="/hostel-registration-track-sheet" rel="noopener noreferrer" target="_blank">
                <FileSpreadsheet className="size-4" />
                Hostel sheet
              </a>
            </Button>
            <GetAppDialog />
            <RoleButton asChild className="h-9 px-4" tone="team">
              <Link href="/team/register">
                <Plus className="size-4" />
                Register a hostel
              </Link>
            </RoleButton>
          </>
        }
        description="Every hostel you registered, and what it still owes."
        title="My desk"
      />

      {paidWaiting.length > 0 ? <PaidNotPublished rows={paidWaiting} /> : null}

      <EarningsRow entries={entries} wallet={wallet} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard icon={Building2} label="Registered" value={String(summary?.hostelsRegistered ?? 0)} />
        <MetricCard icon={Wallet} label="Cash in hand" value={rupees(summary?.cashCollected ?? 0)} />
        <MetricCard icon={Wallet} label="Collected" value={rupees(collected)} />
        <MetricCard
          icon={AlertTriangle}
          label="Outstanding"
          tone={outstanding > 0 ? "amber" : "teal"}
          value={rupees(outstanding)}
        />
      </div>
      {collected + outstanding > 0 ? (
        <ShareBar
          label={`${rupees(collected)} collected of ${rupees(collected + outstanding)}`}
          total={collected + outstanding}
          value={collected}
        />
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-heading text-[15px] font-semibold text-foreground">
            Hostels <span className="font-normal text-muted-foreground">· {visible.length}</span>
          </h2>
          {registrations.length > 0 ? (
            <FilterButton active={show === "ALL" ? 0 : 1} onClear={() => setShow("ALL")}>
              <FilterChoice
                label="Show"
                onChange={setShow}
                options={[
                  { label: "All", value: "ALL" },
                  { label: "Still owes", value: "OWES" },
                  { label: "Paid up", value: "PAID" },
                ]}
                value={show}
              />
            </FilterButton>
          ) : null}
        </div>

        {loading ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((row) => (
              <div className="h-44 animate-pulse rounded-2xl bg-muted" key={row} />
            ))}
          </div>
        ) : registrations.length === 0 ? (
          <section className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-card p-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <Building2 className="size-6" />
            </span>
            <p className="font-heading text-[15px] font-semibold text-foreground">No hostel registered yet</p>
            <RoleButton asChild className="h-9 px-4" tone="team" variant="outline">
              <Link href="/team/register">
                <Plus className="size-4" />
                Register your first
              </Link>
            </RoleButton>
          </section>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((row) => {
              const billed = row.paid + row.outstanding;

              return (
                <article
                  className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-card p-4 transition duration-200 hover:-translate-y-0.5 hover:shadow-md"
                  key={row.hostelId}
                >
                  <div className="flex items-start gap-3">
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-role-team-soft text-role-team">
                      <Glyph className="size-5" name="hostel" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-heading text-[15px] font-semibold text-foreground">{row.hostelName}</p>
                      <p className="truncate text-[12px] text-muted-foreground">
                        {[row.area, row.city].filter(Boolean).join(", ")}
                        {row.registeredAt
                          ? ` · ${formatHostelDate(row.registeredAt)}`
                          : ""}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold",
                        statusTone(row.subscriptionStatus),
                      )}
                    >
                      {statusLabel(row)}
                    </span>
                  </div>

                  {/* Plan and price together: an outstanding figure means
                      nothing without the number it is short of, and that is the
                      first thing asked on the call. */}
                  <ShareBar
                    label={`${row.planName || "No plan"} · ${planLine(row)}`}
                    total={billed}
                    tone={row.subscriptionStatus === "PAST_DUE" ? "warn" : "brand"}
                    value={row.paid}
                  />

                  <div className="flex flex-wrap gap-1.5">
                    <FactChip glyph="checkmark-circle" tone="brand">{`${rupees(row.paid)} paid`}</FactChip>
                    {row.cashCollected > 0 ? <FactChip glyph="cash">{`${rupees(row.cashCollected)} cash`}</FactChip> : null}
                    {row.setupFee ? (
                      <FactChip
                        glyph="receipt"
                        tone={row.setupFee.collected < row.setupFee.amount ? "warn" : "neutral"}
                      >
                        {`${rupees(row.setupFee.amount)} setup${row.setupFee.collected < row.setupFee.amount ? " · not confirmed" : ""}`}
                      </FactChip>
                    ) : null}
                  </div>

                  <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
                    {/* The row exists so somebody rings them. */}
                    {row.ownerPhone ? (
                      <FactChip glyph="call" href={`tel:${row.ownerPhone}`} tone="brand">
                        {row.ownerPhone}
                      </FactChip>
                    ) : (
                      <span className="text-[12px] text-muted-foreground">No number on file</span>
                    )}
                    {/* The people already living there are filled in with the
                        owner after publishing, so the way back is on the card. */}
                    <FactChip glyph="people" href={`/team/hostels/${row.hostelId}/residents`}>
                      Residents
                    </FactChip>
                    {row.outstanding > 0 ? (
                      <RoleButton
                        className="ml-auto h-8 px-3"
                        disabled={handoff.busy}
                        onClick={() => payRemaining(row)}
                        tone="team"
                      >
                        <QrCode className="size-3.5" />
                        Pay {rupees(row.outstanding)}
                      </RoleButton>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {handoff.overlay}
    </div>
  );
}

/**
 * Hostels the owner has already paid for online that nobody has published.
 * The money is real, so the form is kept on the payment itself; each row
 * reopens it exactly as it was left, ready to publish.
 */
function PaidNotPublished({ rows }: { rows: UnpublishedPrepayment[] }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-amber-300 bg-card dark:border-amber-500/40">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
        <AlertTriangle className="size-4 text-amber-600" />
        <h2 className="font-heading text-[15px] font-semibold text-foreground">Paid, not published</h2>
        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11.5px] font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          {rows.length}
        </span>
      </div>
      <ul className="divide-y divide-border/60">
        {rows.map((row) => (
          <li key={row.id}>
            <Link
              className="grid gap-1 px-4 py-3 transition hover:bg-muted/50 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-4"
              href={`/team/register?resume=${row.id}`}
            >
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-semibold text-foreground">{row.hostelName}</span>
                <span className="block truncate text-[12px] text-muted-foreground">
                  {row.ownerName || "—"} · {row.planName}
                  {row.kind === "LIFETIME" ? " · Lifetime" : ""} · paid {row.paidAt ? formatBsAdDate(new Date(row.paidAt)) : "—"}
                  {row.reference ? ` · ${row.reference}` : ""}
                </span>
              </span>
              <span className="text-[13.5px] font-bold tabular-nums text-foreground">
                {rupees(row.chargeAmount)}
                {row.chargeAmount < row.amount ? (
                  <span className="block text-[12px] font-medium text-muted-foreground">of {rupees(row.amount)}</span>
                ) : null}
              </span>
              <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-role-team">
                Finish &amp; publish <ArrowRight className="size-4" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
