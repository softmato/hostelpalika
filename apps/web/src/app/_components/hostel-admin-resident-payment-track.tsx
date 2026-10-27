"use client";

import { roomTypeLabel } from "@hostel/shared/constants/room-types";
import { CalendarDays, ReceiptText } from "@/components/icons";
import { memo } from "react";

import { currency, LoadingRows } from "@/app/_components/shared-ui";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  dayMonthYear,
  dayMonthYearBoth,
  dayMonthYearTime,
  monthLabel,
} from "@/lib/format-month";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { usePortalResource } from "@/lib/portal-query";

import {
  EmptyInline,
  InitialsAvatar,
  SoftBadge,
  statusToneFromLabel,
} from "./portal-dashboard-ui";

type LedgerPayment = {
  amount: number;
  method: string;
  occurredAt: string;
  receiptNumber: string | null;
  settledAt: string | null;
  transactionCode: string | null;
};

type LedgerMonth = {
  dueAmount: number;
  dueDate: string | null;
  invoiceId: string | null;
  paidAmount: number;
  payments: LedgerPayment[];
  period: string;
  status: string;
};

type ResidentLedger = {
  months: LedgerMonth[];
  resident: {
    fullName: string;
    id: string;
    moveInDate: string | null;
    phone: string | null;
    roomType: string | null;
  };
  totals: {
    monthsBilled: number;
    monthsPaid: number;
    outstanding: number;
    paid: number;
  };
};

function StatSlab({
  hint,
  label,
  value,
}: {
  hint: string;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-base font-bold text-foreground">{value}</p>
      {/* Every tile says what it counts. "0 / 0" on its own is a riddle. */}
      <p className="mt-0.5 text-[10.5px] leading-3 text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * One month of a resident's history.
 *
 * A billed month that was never paid and a month that was never billed look
 * completely different here on purpose. The second is not a resident problem —
 * it is a billing run that skipped somebody — and rendering both as "unpaid"
 * would send the owner chasing the wrong person.
 */
function MonthRow({ month }: { month: LedgerMonth }) {
  const billed = Boolean(month.invoiceId);
  const outstanding = Math.max(month.dueAmount - month.paidAmount, 0);

  return (
    <li className="rounded-xl border border-border/70 bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-foreground">{monthLabel(month.period)}</p>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            {billed
              ? `${currency(month.dueAmount)} rent · pay by ${dayMonthYearBoth(month.dueDate)}`
              : "No rent invoiced for this month"}
          </p>
        </div>
        <SoftBadge tone={billed ? statusToneFromLabel(month.status) : "slate"}>
          {billed ? month.status.replaceAll("_", " ") : "NOT BILLED"}
        </SoftBadge>
      </div>

      {month.payments.length > 0 ? (
        <ul className="mt-2.5 space-y-1.5 border-t border-border/50 pt-2.5">
          {month.payments.map((payment, index) => (
            <li
              className="flex items-start justify-between gap-3 text-[11.5px]"
              key={`${payment.occurredAt}-${index}`}
            >
              <span className="flex min-w-0 items-start gap-1.5 text-muted-foreground">
                <ReceiptText className="mt-0.5 size-3 shrink-0" />
                <span className="min-w-0">
                  {/* The date the money moved, which is the one an owner
                      cross-checks against a statement — not the day we recorded it. */}
                  Paid {dayMonthYearTime(payment.occurredAt)} ·{" "}
                  {payment.method.replaceAll("_", " ")}
                  {payment.transactionCode ? (
                    <span className="block font-mono text-[10.5px]">
                      {payment.transactionCode}
                    </span>
                  ) : null}
                  {payment.receiptNumber ? (
                    <span className="block">Receipt {payment.receiptNumber}</span>
                  ) : null}
                </span>
              </span>
              <span className="shrink-0 font-semibold text-emerald-700 dark:text-emerald-400">
                {currency(payment.amount)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {billed && outstanding > 0 ? (
        <p className="mt-2 border-t border-border/50 pt-2 text-[11.5px] font-semibold text-rose-700 dark:text-rose-400">
          {currency(outstanding)} still outstanding
        </p>
      ) : null}
    </li>
  );
}

/**
 * A resident's whole payment track, opened by clicking their row in the matrix.
 *
 * A right-hand sheet rather than a route: the owner is mid-scan of the month's
 * matrix and comparing this person against the rows around them. Navigating
 * away and back would lose the month, the filter and the scroll position each
 * time, which is enough friction that nobody would use it twice.
 */
export const ResidentPaymentTrackSheet = memo(function ResidentPaymentTrackSheet({
  onClose,
  residentId,
}: {
  onClose: () => void;
  residentId: string;
}) {
  const ledger = usePortalResource<ResidentLedger>(
    residentId ? hostelAdminEndpoints.residentLedger(residentId) : null,
    { errorMessage: "Could not load this resident's history." },
  );

  const data = ledger.data ?? null;

  return (
    <Sheet onOpenChange={(open) => (open ? undefined : onClose())} open={Boolean(residentId)}>
      <SheetContent
        className="w-full gap-0 overflow-y-auto p-0 data-[side=right]:sm:max-w-lg"
        side="right"
      >
        <SheetHeader className="border-b border-border/60 p-4">
          <div className="flex items-center gap-3">
            <InitialsAvatar name={data?.resident.fullName ?? "…"} tone="admin" />
            <div className="min-w-0">
              <SheetTitle className="truncate text-base">
                {data?.resident.fullName ?? "Payment history"}
              </SheetTitle>
              <SheetDescription className="text-[11.5px]">
                Payment history
                {data?.resident.roomType
                  ? ` · ${roomTypeLabel(data.resident.roomType)}`
                  : ""}
                {data?.resident.moveInDate
                  ? ` · here since ${dayMonthYear(data.resident.moveInDate)}`
                  : ""}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="space-y-4 p-4">
          {ledger.state === "loading" ? <LoadingRows /> : null}
          {ledger.state === "error" ? (
            <EmptyInline label={ledger.message || "History could not be loaded."} />
          ) : null}

          {data ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <StatSlab
                  hint="received since move-in"
                  label="Total paid"
                  value={currency(data.totals.paid)}
                />
                <StatSlab
                  hint="still owed across all months"
                  label="Outstanding"
                  value={currency(data.totals.outstanding)}
                />
                <StatSlab
                  hint={`of ${data.totals.monthsBilled} month(s) invoiced`}
                  label="Months settled"
                  value={String(data.totals.monthsPaid)}
                />
                <StatSlab
                  hint="months since they moved in"
                  label="Months here"
                  value={String(data.months.length)}
                />
              </div>

              {/* A brand-new resident's whole column reads NOT BILLED, which
                  looks broken rather than early. Say what it means and what
                  fixes it. */}
              {data.totals.monthsBilled === 0 ? (
                <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[12px] leading-4 text-amber-800 dark:text-amber-300">
                  No rent has been invoiced to this resident yet. Use{" "}
                  <span className="font-semibold">Generate Invoices</span> on the
                  payments screen to bill a month.
                </p>
              ) : null}

              {data.months.length === 0 ? (
                <EmptyInline label="Nothing billed since move-in." />
              ) : (
                <ul className="space-y-2.5">
                  {data.months.map((month) => (
                    <MonthRow key={month.period} month={month} />
                  ))}
                </ul>
              )}

              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <CalendarDays className="size-3" />
                Every month since move-in is listed, billed or not.
              </p>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
});
