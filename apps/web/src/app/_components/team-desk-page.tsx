"use client";

import { AlertTriangle, ArrowRight, Building2, FileSpreadsheet, Phone, Plus, QrCode, Users, Wallet } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { useCheckoutHandoff } from "@/app/_components/checkout-handoff";
import { GetAppDialog } from "@/components/get-app-dialog";
import { browserApi } from "@/lib/browser-api";
import { cn } from "@/lib/utils";
import type { UnpublishedPrepayment } from "@/modules/team/team-prepayment.service";
import { formatBsAdDate } from "@hostel/shared/calendar/bs";

/**
 * An agent's own desk: what they have filed, and what is still owed on it.
 *
 * Deliberately plain. This is a work surface somebody opens twenty times a day
 * standing in a corridor, so it is a number row and a table — no hero, no
 * illustration, no explanatory prose about what the field team does. The person
 * reading it is the field team.
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
      ? `Due ${new Date(row.dueBy).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
      : "Past due";
  }

  return row.subscriptionStatus === "ACTIVE" ? "Paid" : row.subscriptionStatus;
}

function statusTone(status: string) {
  return status === "ACTIVE"
    ? "bg-success/10 text-success"
    : status === "PAST_DUE"
      ? "bg-warning/10 text-warning"
      : "bg-muted text-muted-foreground";
}

function Figure({ label, tone, value }: { label: string; tone?: string; value: string }) {
  return (
    <div>
      <p className={cn("text-sm font-bold tabular-nums sm:text-base", tone ?? "text-foreground")}>
        {value}
      </p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
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
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="app-card p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Today&apos;s salary
          </p>
          <span className="rounded-full bg-brand-teal/10 px-2 py-0.5 text-[11px] font-bold text-brand-teal">
            {rate} commission
          </span>
        </div>
        <p className="mt-2 text-3xl font-bold tabular-nums text-foreground">
          {rupees(wallet?.today.commission ?? 0)}
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3 text-center">
          <Figure label="Hostels added" value={String(wallet?.today.hostels ?? 0)} />
          <Figure label="Paid" tone="text-success" value={rupees(wallet?.today.paid ?? 0)} />
          <Figure label="Due" tone="text-warning" value={rupees(wallet?.today.due ?? 0)} />
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          {rate} of each new hostel&apos;s setup fee, credited once the fee clears.
        </p>
      </div>

      <div className="app-card p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Wallet</p>
        <p className="mt-2 text-3xl font-bold tabular-nums text-foreground">
          {rupees(wallet?.balance ?? 0)}
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3 text-center">
          <Figure label="Earned" value={rupees(wallet?.earned ?? 0)} />
          <Figure label="Paid to you" value={rupees(wallet?.paidOut ?? 0)} />
          <Figure label="Once paid" tone="text-muted-foreground" value={rupees(wallet?.pending ?? 0)} />
        </div>
        {entries.length > 0 ? (
          <ul className="mt-3 divide-y divide-border border-t border-border">
            {entries.slice(0, 4).map((entry) => (
              <li className="flex items-center justify-between gap-2 py-1.5 text-xs" key={entry.id}>
                <span className="min-w-0 truncate text-muted-foreground">
                  {entry.type === "COMMISSION"
                    ? entry.hostelName || "Commission"
                    : `Paid out${entry.method ? ` · ${entry.method}` : ""}`}
                  {" · "}
                  {new Date(entry.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                </span>
                <span
                  className={cn(
                    "shrink-0 font-semibold tabular-nums",
                    entry.type === "COMMISSION" ? "text-success" : "text-foreground",
                  )}
                >
                  {entry.type === "COMMISSION" ? "+" : "−"}
                  {rupees(entry.amount)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function Stat({
  emphasis,
  icon: Icon,
  label,
  value,
}: {
  emphasis?: "warning";
  icon: typeof Wallet;
  label: string;
  value: string;
}) {
  return (
    <div className="app-card p-4">
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            "size-4",
            emphasis === "warning" ? "text-warning" : "text-brand-teal",
          )}
        />
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
      </div>
      <p
        className={cn(
          "mt-2 text-2xl font-bold tabular-nums",
          emphasis === "warning" ? "text-warning" : "text-foreground",
        )}
      >
        {value}
      </p>
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

  function payButton(row: Registration) {
    return (
      <button
        className="inline-flex items-center gap-1.5 rounded-md bg-brand-teal px-2.5 py-1 text-xs font-bold text-white transition hover:brightness-110 disabled:opacity-60"
        disabled={handoff.busy}
        onClick={() => payRemaining(row)}
        type="button"
      >
        <QrCode className="size-3.5" />
        Pay {rupees(row.outstanding)}
      </button>
    );
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">My desk</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every hostel you have registered, and what it still owes.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Its own tab: the sheet is a full-screen page, kept open beside the desk. */}
          <a
            className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm font-semibold text-foreground transition hover:bg-muted"
            href="/hostel-registration-track-sheet"
            rel="noopener noreferrer"
            target="_blank"
          >
            <FileSpreadsheet className="size-4" /> Hostel sheet
          </a>
          <GetAppDialog />
          <Link
            className="inline-flex items-center gap-2 rounded-lg bg-brand-teal px-4 py-2.5 text-sm font-semibold text-white transition hover:brightness-110"
            href="/team/register"
          >
            <Plus className="size-4" /> Register a hostel
          </Link>
        </div>
      </div>

      {paidWaiting.length > 0 ? <PaidNotPublished rows={paidWaiting} /> : null}

      <EarningsRow entries={entries} wallet={wallet} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          icon={Building2}
          label="Registered"
          value={String(summary?.hostelsRegistered ?? 0)}
        />
        <Stat
          icon={Wallet}
          label="Cash in hand"
          value={rupees(summary?.cashCollected ?? 0)}
        />
        <Stat icon={Wallet} label="Collected" value={rupees(summary?.collected ?? 0)} />
        <Stat
          emphasis="warning"
          icon={AlertTriangle}
          label="Outstanding"
          value={rupees(summary?.outstanding ?? 0)}
        />
      </div>

      <div className="app-card overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">
            {[0, 1, 2].map((row) => (
              <div className="h-10 animate-pulse rounded bg-muted" key={row} />
            ))}
          </div>
        ) : registrations.length === 0 ? (
          <div className="p-10 text-center">
            <Building2 className="mx-auto size-8 text-muted-foreground/40" />
            <p className="mt-3 text-sm font-semibold text-foreground">
              You have not registered a hostel yet
            </p>
            <Link
              className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted"
              href="/team/register"
            >
              <Plus className="size-4" /> Register your first
            </Link>
          </div>
        ) : (
          <>
            {/* Phones: one card per hostel, the call and the chase up front. */}
            <ul className="divide-y divide-border md:hidden">
              {registrations.map((row) => (
                <li className="space-y-2 p-4" key={row.hostelId}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-foreground">{row.hostelName}</p>
                      <p className="text-xs text-muted-foreground">
                        {row.planName || "—"} · {planLine(row)}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold",
                        statusTone(row.subscriptionStatus),
                      )}
                    >
                      {statusLabel(row)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                      {row.setupFee ? "Setup fee" : "Paid"}{" "}
                      <strong className="text-foreground">
                        {rupees(row.setupFee ? row.setupFee.amount : row.paid)}
                      </strong>
                      {row.setupFee && row.setupFee.collected < row.setupFee.amount
                        ? " · waiting on confirmation"
                        : ""}
                    </span>
                    {row.outstanding > 0 ? payButton(row) : null}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    {row.ownerPhone ? (
                      <a
                        className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-teal"
                        href={`tel:${row.ownerPhone}`}
                      >
                        <Phone className="size-3.5" />
                        {row.ownerPhone}
                      </a>
                    ) : (
                      <span className="text-xs text-muted-foreground">No number on file</span>
                    )}
                    <Link
                      className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-teal"
                      href={`/team/hostels/${row.hostelId}/residents`}
                    >
                      <Users className="size-3.5" />
                      Residents
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[980px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Hostel
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Plan
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Collected
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Outstanding
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Owner
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Status
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Residents
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {registrations.map((row) => (
                  <tr key={row.hostelId}>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-foreground">{row.hostelName}</p>
                      <p className="text-xs text-muted-foreground">
                        {[row.area, row.city].filter(Boolean).join(", ")}
                        {row.registeredAt
                          ? ` · ${new Date(row.registeredAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`
                          : ""}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      {/* Plan and price together: an outstanding figure means
                          nothing without the number it is short of, and that is
                          the first thing asked on the call. */}
                      <p className="font-medium text-foreground">
                        {row.planName || "—"}
                      </p>
                      <p className="text-xs tabular-nums text-muted-foreground">
                        {planLine(row)}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums text-foreground">
                      {rupees(row.paid)}
                      {row.setupFee ? (
                        <span className="block text-[11px] font-normal text-muted-foreground">
                          {rupees(row.setupFee.amount)} setup fee
                          {row.setupFee.collected < row.setupFee.amount ? ", not confirmed yet" : ""}
                        </span>
                      ) : null}
                      {row.cashCollected > 0 ? (
                        <span className="block text-[11px] font-normal text-muted-foreground">
                          {rupees(row.cashCollected)} cash
                        </span>
                      ) : null}
                    </td>
                    <td
                      className={cn(
                        "px-4 py-3 text-right font-semibold tabular-nums",
                        row.outstanding > 0 ? "text-warning" : "text-muted-foreground",
                      )}
                    >
                      {row.outstanding > 0 ? rupees(row.outstanding) : "—"}
                      {row.outstanding > 0 ? (
                        <div className="mt-1.5">
                          {payButton(row)}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      {/* The row exists so somebody rings them. A number that has
                          to be copied out of another screen first is a number
                          that does not get rung. */}
                      {row.ownerPhone ? (
                        <a
                          className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-teal hover:underline"
                          href={`tel:${row.ownerPhone}`}
                        >
                          <Phone className="size-3.5" />
                          {row.ownerPhone}
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          No number on file
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold",
                          statusTone(row.subscriptionStatus),
                        )}
                      >
                        {statusLabel(row)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {/* The people already living there are filled in with the
                          owner after publishing, so the way back is on the row. */}
                      <Link
                        className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-teal hover:underline"
                        href={`/team/hostels/${row.hostelId}/residents`}
                      >
                        <Users className="size-3.5" />
                        Add residents
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>

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
    <section className="app-card overflow-hidden border-warning/30">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <AlertTriangle className="size-4 text-warning" />
        <h2 className="text-sm font-bold text-foreground">Paid, not published</h2>
        <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs font-semibold text-warning">{rows.length}</span>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.id}>
            <Link
              className="grid gap-1 px-4 py-3 transition hover:bg-muted/50 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-4"
              href={`/team/register?resume=${row.id}`}
            >
              <span className="min-w-0">
                <span className="block truncate font-semibold text-foreground">{row.hostelName}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {row.ownerName || "—"} · {row.planName} · paid {row.paidAt ? formatBsAdDate(new Date(row.paidAt)) : "—"}
                  {row.reference ? ` · ${row.reference}` : ""}
                </span>
              </span>
              <span className="text-sm font-bold tabular-nums text-foreground">
                {rupees(row.chargeAmount)}
                {row.chargeAmount < row.amount ? (
                  <span className="block text-xs font-medium text-muted-foreground">of {rupees(row.amount)}</span>
                ) : null}
              </span>
              <span className="inline-flex items-center gap-1 text-sm font-semibold text-brand-teal">
                Finish &amp; publish <ArrowRight className="size-4" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
