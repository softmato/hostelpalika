"use client";
import { roomTypeLabel } from "@hostel/shared/constants/room-types";
import { ExportMenu } from "@/components/export-menu";
import { downloadTable } from "@/lib/downloads/downloader";

import {
  AlertTriangle,
  CalendarPlus,
  Clock3,
  CreditCard,
  Plus,
  ReceiptText,
  Banknote,
  Landmark,
  Smartphone,
  WalletCards,
} from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import {
  currency,
  EmptyState,
  Input as FormInput,
  LoadingRows,
  Select as FormSelect,
  TextArea,
} from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FilterButton, FilterChoice } from "@/components/filter-panel";
import { browserApi } from "@/lib/browser-api";
import {
  dayMonthYear,
  dayMonthYearBs,
  monthLabel,
  periodKey,
} from "@/lib/format-month";
import { bsPeriodBounds } from "@/lib/hostel-day";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import {
  combineResources,
  useInvalidateResources,
  usePortalResource,
} from "@/lib/portal-query";

import {
  field,
  optionalField,
  type Payment,
  type PaymentProof,
  type Resident,
} from "./hostel-admin-shared";
import { MonthField, MonthPicker, type PeriodRow } from "./hostel-admin-month-picker";
import { ProofReviewModal } from "./hostel-admin-proof-review-modal";
import { HostelAdminReviewQueue } from "./hostel-admin-review-queue";
import { ResidentPaymentTrackSheet } from "./hostel-admin-resident-payment-track";
import {
  DataTable,
  EmptyInline,
  InitialsAvatar,
  MetricCard,
  PortalPageHeader,
  RoleButton,
  SearchField,
  SectionCard,
  SoftBadge,
  statusToneFromLabel,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./portal-dashboard-ui";
import { BillExtraTags, fineGrowth, type BillLine } from "./khata-pages";
import { ShareBar } from "./hostel-admin-page-ui";
import { WalletMark } from "@/components/wallet-mark";
import { BusyForm, SubmitButton } from "./busy-form";
import { useSessionStore } from "@/stores/session-store";

/** "No fee set" only when nothing prices the room; a priceable row is just not billed yet. */
function notBilledLabel(reason: string | undefined) {
  if (reason === "NOT_YET_RUN") return "NOT BILLED YET";
  if (reason === "NOT_YET_DUE") return "BILLS ON THEIR DAY";
  if (reason === "PAID_BEFORE_JOINING") return "PAID BEFORE JOINING";
  if (reason === "FEE_SCHEDULE_MISSING" || reason === "BED_TYPE_NOT_PRICED") return "NO FEE SET";
  return "NOT BILLED";
}

type MatrixRow = {
  displayStatus:
    | "PAID"
    | "PARTIAL"
    | "UNPAID"
    | "OVERDUE"
    | "PENDING_PROOF"
    | "NOT_BILLED";
  /** Server's projection for a row with no invoice: what it would cost and why it isn't billed. */
  notBilled?: { amount: number | null; reason: string } | null;
  payment: (Payment & { fineWaived?: boolean; lines?: BillLine[] }) | null;
  resident: Resident & {
    fullName: string;
    moveInDate: string;
    /** Bed type — the attribute the hostel identifies a resident by (§11.4). */
    roomType?: string | null;
  };
};

/** The three header actions share one shape and one glass fill on the green block. */
const HEADER_BUTTON =
  "h-10 gap-2 rounded-xl !border !border-white/40 !bg-white/15 px-4 !text-white hover:!bg-white/25 [&_svg]:!text-white";

type PayMethod = "CASH" | "ESEWA" | "KHALTI" | "BANK";

const ONLINE_METHODS: { label: string; logo: string; value: Exclude<PayMethod, "CASH"> }[] = [
  { label: "eSewa", logo: "ESEWA", value: "ESEWA" },
  { label: "Khalti", logo: "KHALTI", value: "KHALTI" },
  { label: "Bank", logo: "BANK_TRANSFER", value: "BANK" },
];

/** A provider's logo tile; Bank has no brand, so it is a white tile with a bold bank glyph. */
function MethodMark({ logo, size }: { logo: string; size: number }) {
  if (logo !== "BANK_TRANSFER") {
    return <WalletMark name={logo} size={size} />;
  }

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center bg-white text-neutral-900"
      style={{ borderRadius: Math.round(size * 0.28), height: size, width: size }}
    >
      <Landmark size={Math.round(size * 0.6)} strokeWidth={2.75} />
    </span>
  );
}

type LedgerMonth = {
  dueAmount: number;
  invoiceId: string | null;
  lines: { amount: number; basis?: string; description: string }[];
  paidAmount: number;
  period: string;
};

type PeriodSummary = {
  earliestPeriod: string;
  months: PeriodRow[];
  overall: {
    collected: number;
    due: number;
    outstanding: number;
    overdueResidents: number;
    paid: number;
    partial: number;
    pendingProofs: number;
    unpaid: number;
  };
};

type MatrixTotals = {
  collected: number;
  due: number;
  notBilled: number;
  overdue: number;
  paid: number;
  partial: number;
  unpaid: number;
};

/**
 * The last day of the month being billed — the same date the server picks when
 * the field is left off entirely (`runBillingCycle` defaults `dueDate` to the
 * period's `lastDay`).
 *
 * Pre-filled rather than left blank: an empty required date field is the reason
 * this form was abandoned half-completed. Pre-filled with *the server's own
 * default* rather than a second convention, because a form that quietly submits
 * something other than what the button would do on its own is a rule nobody can
 * find later.
 *
 * ## `lastDay`, not `end`
 *
 * `bsPeriodBounds` returns both. `end` is 23:59:59.999 UTC, and Kathmandu is
 * 5h45m ahead — that instant is already 05:44 the next morning there, so a
 * Bhadra invoice would be stamped due on a moment every Nepali reader names
 * Aswin 1. A due date is a calendar day and takes `lastDay`; only a `$lte`
 * range takes `end`.
 *
 * This used to build `Date.UTC(year, month, 1)` straight off the two numbers in
 * the key. Once the key became Bikram Sambat that read `2083-05` as the year
 * 2083 AD and pre-filled the date picker with **1 June 2083**.
 */
function defaultDueDate(period: string) {
  try {
    return bsPeriodBounds(period).lastDay.toISOString().slice(0, 10);
  } catch {
    // A pre-cutover key, or a year past the conversion table. An empty field the
    // owner must fill beats a date from the wrong calendar.
    return "";
  }
}

/**
 * The month this screen opens on.
 *
 * **An identity, not a label.** It is sent to the server as the `period` the
 * matrix is keyed by, so it has to be the string `hostelPeriodOf` would produce
 * for the same instant. Assembling `2026-09` from the local Gregorian fields —
 * which is what this did — asked for a month the server has no invoices in, and
 * the screen answered with an empty table and no error on it.
 */
function defaultMonth() {
  return periodKey(new Date());
}

export const HostelAdminPaymentsPage = memo(function HostelAdminPaymentsPage() {
  const [month, setMonth] = useState(defaultMonth());
  const [filter, setFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [payResidentId, setPayResidentId] = useState("");
  // null = untouched, so the oldest unpaid month is the default pick.
  const [payMethod, setPayMethod] = useState<PayMethod>("CASH");
  const [payMonths, setPayMonths] = useState<string[] | null>(null);
  const [showFeeRun, setShowFeeRun] = useState(false);
  /**
   * The month the billing dialog will bill, tracked here rather than left to the
   * form so the due-date field beside it can follow along. Seeded from the table
   * when the dialog opens — the owner has just been looking at that month.
   */
  const [billMonth, setBillMonth] = useState(defaultMonth);
  const [approvingAll, setApprovingAll] = useState(false);
  const [processing, setProcessing] = useState<{ action: "approve" | "reject"; id: string } | null>(null);
  /** The review section is shown for pending claims, or when the Pending Proofs card opens it. */
  const [queueForced, setQueueForced] = useState(false);
  /** The collected-of-billed bar opens under the cards while the Collected card is hovered. */
  const [showShare, setShowShare] = useState(false);
  /** Whose month-by-month history is open in the side sheet. "" means none. */
  const [trackResidentId, setTrackResidentId] = useState("");
  /** Which claim is open in the full review modal (item 3, target §11.4). */
  const [reviewingId, setReviewingId] = useState("");
  const invalidate = useInvalidateResources();
  const sessionName = useSessionStore((state) => state.user?.name ?? "");

  const errorMessage = "Could not load payments.";
  const residentsResource = usePortalResource<{ residents: Resident[] }>(
    hostelAdminEndpoints.residents,
    { errorMessage },
  );
  // Keyed by month, so stepping back to a month already viewed paints from
  // cache instead of blanking the matrix.
  const matrixResource = usePortalResource<{
    month: string;
    rows: MatrixRow[];
    totals: MatrixTotals;
  }>(hostelAdminEndpoints.paymentsMatrix(month), { errorMessage });
  // Claims awaiting a decision. Since item 2.8 a "proof" is a PENDING
  // `PaymentEvent`, so the queue is the events endpoint rather than a second
  // list hanging off the payments response.
  const paymentsResource = usePortalResource<{ events: PaymentProof[] }>(
    hostelAdminEndpoints.paymentClaims,
    { errorMessage },
  );
  // Lifetime figures and the per-month roll-up. Deliberately *not* keyed by
  // month: the cards answer "how is this hostel doing", which does not change
  // when the table's month does.
  const periodsResource = usePortalResource<PeriodSummary>(
    hostelAdminEndpoints.paymentPeriods,
    { errorMessage },
  );

  const residents = useMemo(
    () => residentsResource.data?.residents ?? [],
    [residentsResource.data],
  );
  // Recording cash is for people living here now, not everyone who ever stayed.
  const livingResidents = useMemo(
    () => residents.filter((resident) => resident.status === "ACTIVE"),
    [residents],
  );
  const rows = useMemo(() => matrixResource.data?.rows ?? [], [matrixResource.data]);
  const totals = matrixResource.data?.totals ?? null;
  // The chosen resident's bill for the chosen month, from their own ledger —
  // the same invoice the cash endpoint settles against.
  const payLedger = usePortalResource<{ months: LedgerMonth[] }>(
    payResidentId ? hostelAdminEndpoints.residentLedger(payResidentId) : null,
    { errorMessage },
  );
  // Only months with a bill that still has a balance can be paid.
  const unpaidMonths = useMemo(
    () =>
      (payLedger.data?.months ?? [])
        .filter((entry) => entry.invoiceId && entry.dueAmount - entry.paidAmount > 0)
        .sort((x, y) => x.period.localeCompare(y.period)),
    [payLedger.data],
  );
  const chosenPeriods = payMonths ?? unpaidMonths.slice(0, 1).map((entry) => entry.period);
  const chosenBills = unpaidMonths.filter((entry) => chosenPeriods.includes(entry.period));
  const payBalance = chosenBills.reduce(
    (sum, entry) => sum + (entry.dueAmount - entry.paidAmount),
    0,
  );
  // The typed amount belongs to one selection; a new selection starts at the full balance.
  const amountKey = `${chosenPeriods.join(",")}-${payBalance}`;
  const [amountEdit, setAmountEdit] = useState<{ key: string; value: string } | null>(null);
  const payAmount = amountEdit?.key === amountKey ? amountEdit.value : String(payBalance);
  // What stays due per month: ticked months after the typed amount is spread
  // oldest first, plus every unticked unpaid month in full.
  const remainingLines = unpaidMonths
    .reduce<{ amount: number; left: number; period: string }[]>((lines, entry) => {
      const owed = entry.dueAmount - entry.paidAmount;
      const left = lines.length > 0 ? lines[lines.length - 1].left : Number(payAmount) || 0;
      const paying = chosenPeriods.includes(entry.period) ? Math.min(left, owed) : 0;

      return [...lines, { amount: owed - paying, left: left - paying, period: entry.period }];
    }, [])
    .filter((line) => line.amount > 0);
  const proofs = useMemo(
    () => paymentsResource.data?.events ?? [],
    [paymentsResource.data],
  );
  // Not sliced: `Approve all` must sweep exactly what the owner was shown, and
  // a hidden seventh row is the difference between a count they confirmed and
  // one they did not.
  const pendingProofs = useMemo(
    () => proofs.filter((proof) => proof.status === "PENDING"),
    [proofs],
  );
  // Read from the live list, not captured at click time: a claim someone else
  // approved while this modal was open must stop offering an Approve button.
  const reviewingProof = useMemo(
    () => proofs.find((proof) => proof.eventId === reviewingId) ?? null,
    [proofs, reviewingId],
  );
  const periods = useMemo(
    () => periodsResource.data?.months ?? [],
    [periodsResource.data],
  );
  const overall = periodsResource.data?.overall ?? null;
  const combined = combineResources(residentsResource, matrixResource, paymentsResource);
  const state = combined.state;
  const message = actionMessage || combined.message;

  const residentById = useMemo(
    () => new Map(residents.map((resident) => [resident.id, resident])),
    [residents],
  );

  /**
   * Bed type per resident, for the review queue's rows (§11.4).
   *
   * Read off the matrix rather than fetched again: the matrix already resolves
   * `bedType ?? roomType` per resident, and a second source for the same label
   * is a second way for the queue and the table to disagree about what somebody
   * is renting.
   */
  const bedLabelByResidentId = useMemo(
    () => new Map(rows.map((row) => [row.resident.id, row.resident.roomType ?? null])),
    [rows],
  );

  // Every mutation on this page moves both the matrix and the proof list.
  const refreshPayments = useCallback(() => {
    invalidate(
      hostelAdminEndpoints.paymentsMatrixAll,
      hostelAdminEndpoints.transactions,
      hostelAdminEndpoints.residents,
      "/api/v1/hostel-admin/finance/residents*",
    );
  }, [invalidate]);

  const handleCreatePayment = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);

      try {
        // One cash call per invoice, oldest first; a part payment clears the
        // oldest months and leaves the rest due.
        let remaining = Number(field(form, "amount"));
        const receipt =
          optionalField(form, "cashReceiptNumber") ??
          `${payMethod}-${Date.now()}`;

        for (const bill of chosenBills) {
          const owed = bill.dueAmount - bill.paidAmount;
          const amount = Math.min(remaining, owed);

          if (amount <= 0) {
            break;
          }

          await browserApi(`/api/v1/hostel-admin/finance/invoices/${bill.invoiceId}/cash`, {
            body: JSON.stringify({
              amount,
              cashReceiptNumber: chosenBills.length > 1 ? `${receipt}-${bill.period}` : receipt,
              collectedBy: field(form, "collectedBy"),
              method: payMethod,
              note: optionalField(form, "remarks"),
            }),
            method: "POST",
          });
          remaining -= amount;
        }

        formElement.reset();
        setPayResidentId("");
        setPayMonths(null);
        setPayMethod("CASH");
        setShowCreate(false);
        setActionMessage("Payment recorded — the resident has been notified with their receipt.");
        refreshPayments();
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not record the payment.",
        );
      }
    },
    [chosenBills, payMethod, refreshPayments],
  );

  const handleFeeRun = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      const monthlyFee = optionalField(form, "monthlyFee");

      try {
        if (monthlyFee) {
          await browserApi(hostelAdminEndpoints.residentFees, {
            body: JSON.stringify({ monthlyFee: Number(monthlyFee) }),
            method: "PATCH",
          });
        }

        const result = await browserApi<{
          billed: { residentId: string }[];
          failures: { errorCode: string; residentId: string }[];
          skipped: { reason: string; residentId: string }[];
        }>(hostelAdminEndpoints.billingRuns, {
          body: JSON.stringify({
            dueDate: field(form, "dueDate") || undefined,
            period: field(form, "month"),
          }),
          method: "POST",
        });

        // Failures are surfaced, never swallowed: a resident who cannot be
        // priced is reported rather than billed zero (P8).
        setActionMessage(
          `${result.billed.length} invoice(s) issued, ${result.skipped.length} skipped` +
            (result.failures.length > 0
              ? `, ${result.failures.length} could not be priced — check their room type and the fee schedule.`
              : "."),
        );
        setShowFeeRun(false);
        refreshPayments();
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not run the monthly fee job.",
        );
      }
    },
    [refreshPayments],
  );

  /* Takes the late fine off one bill; the matrix refetch shows the smaller due. */
  const waiveFine = useCallback(
    async (invoiceId: string, residentName: string) => {
      if (!window.confirm(`Waive ${residentName}'s late fine? It comes off this bill and stops growing.`)) {
        return;
      }

      try {
        await browserApi(`/api/v1/hostel-admin/finance/invoices/${invoiceId}/waive-fine`, {
          body: "{}",
          method: "POST",
        });
        setActionMessage("Fine waived.");
        await matrixResource.refreshAsync();
      } catch (error) {
        setActionMessage(error instanceof Error ? error.message : "Could not waive the fine.");
      }
    },
    [matrixResource],
  );

  const reviewProof = useCallback(
    async (proofId: string, action: "approve" | "reject", rejectionReason?: string) => {
      // A fixed reason list, not `window.prompt` (current §5.2): the resident
      // gets a sentence they can act on, the reasons become countable, and
      // nobody types an accusation into a permanent record.
      if (action === "reject" && !rejectionReason) {
        return;
      }

      setProcessing({ action, id: proofId });

      try {
        await browserApi(
          `${hostelAdminEndpoints.paymentClaims}/${proofId}/${action}`,
          {
            body: JSON.stringify(action === "reject" ? { rejectionReason } : {}),
            method: "POST",
          },
        );
        setActionMessage(action === "approve" ? "Proof approved." : "Proof rejected.");
        setReviewingId("");
        refreshPayments();
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not review proof.",
        );
      } finally {
        setProcessing(null);
      }
    },
    [refreshPayments],
  );

  /**
   * `Approve all` (target §11.4, item 3.5).
   *
   * Sweeps only all-green rows and confirms with the count and the total first —
   * an owner about to settle eleven payments at once should be told how much
   * money that is before, not after. The server re-derives which rows are green,
   * so a row that went amber since the render is skipped and reported.
   */
  const approveAll = useCallback(async () => {
    const green = pendingProofs.filter((proof) => proof.allGreen);

    if (green.length === 0) {
      setActionMessage("No claims have passed every check.");
      return;
    }

    const total = green.reduce((sum, proof) => sum + proof.amount, 0);

    if (
      !window.confirm(
        `Approve ${green.length} payment(s) totalling ${currency(total)}? Each resident gets a receipt.`,
      )
    ) {
      return;
    }

    setApprovingAll(true);

    try {
      const result = await browserApi<{
        data: { approved: string[]; skipped: { reason: string }[] };
      }>(`${hostelAdminEndpoints.paymentClaims}/bulk-approve`, {
        body: JSON.stringify({ eventIds: green.map((proof) => proof.eventId) }),
        method: "POST",
      });

      const approved = result?.data?.approved?.length ?? 0;
      const skipped = result?.data?.skipped?.length ?? 0;

      setActionMessage(
        `${approved} payment(s) approved` +
          (skipped > 0 ? `, ${skipped} left for review.` : "."),
      );
      refreshPayments();
    } catch (error) {
      setActionMessage(
        error instanceof Error ? error.message : "Could not approve the claims.",
      );
    } finally {
      setApprovingAll(false);
    }
  }, [pendingProofs, refreshPayments]);

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter !== "ALL") {
        const matchesFilter =
          filter === "UNPAID"
            ? ["UNPAID", "PENDING_PROOF", "NOT_BILLED"].includes(row.displayStatus)
            : row.displayStatus === filter;
        if (!matchesFilter) {
          return false;
        }
      }
      if (!query) {
        return true;
      }
      // Name *or* bed type: "double" is how an owner narrows to the residents
      // they price the same way, and it is the only other identifying attribute
      // on the row since room numbers left the model.
      return (
        row.resident.fullName.toLowerCase().includes(query) ||
        (row.resident.roomType ?? "").toLowerCase().includes(query)
      );
    });
  }, [filter, rows, search]);

  const stats = useMemo(
    () => ({
      // The month's own numbers still drive the tab counts, because the tabs
      // filter the month's table.
      notBilled: totals?.notBilled ?? 0,
      overdue: totals?.overdue ?? 0,
      // Counted from the rows: `totals.unpaid` folds these in, and the tab
      // needs them on their own.
      toReview: rows.filter((row) => row.displayStatus === "PENDING_PROOF").length,
      paid: totals?.paid ?? 0,
      partial: totals?.partial ?? 0,
      pendingProofs: proofs.filter((p) => p.status === "PENDING").length,
      unpaid: totals?.unpaid ?? 0,
    }),
    [proofs, rows, totals],
  );

  /**
   * Clicking a card filters the table to what the card counts.
   *
   * The cards are lifetime figures and the table is one month, so a click can
   * only ever narrow the *status*, never the period — pretending otherwise
   * would show "3 overdue" and then a table of one. Toggling off returns to
   * `ALL`, so a second click undoes the first, which is what a pressed-looking
   * card should do.
   */
  const filterBy = useCallback(
    (next: string) => setFilter((current) => (current === next ? "ALL" : next)),
    [],
  );

  return (
    <div className="mx-auto max-w-[1448px] space-y-6">
      <PortalPageHeader
        actions={
          <>
            <ExportMenu
              className={HEADER_BUTTON}
              disabled={filteredRows.length === 0}
              onExport={({ format }) =>
                void downloadTable(
                  format,
                  `payments-${month}`,
                  [
                    { key: "resident", label: "Resident" },
                    { key: "roomType", label: "Room type" },
                    { key: "status", label: "Status" },
                    { key: "due", label: "Due" },
                    { key: "paid", label: "Paid" },
                    { key: "dueDate", label: "Due date" },
                    { key: "method", label: "Method" },
                  ],
                  filteredRows.map((row) => ({
                    due: row.payment?.dueAmount ?? 0,
                    dueDate: row.payment?.dueDate?.slice(0, 10) ?? "",
                    method: row.payment?.paymentMethod ?? "",
                    paid: row.payment?.paidAmount ?? 0,
                    resident: row.resident.fullName,
                    roomType: row.resident.roomType ?? "",
                    status: row.displayStatus,
                  })),
                )
              }
            />
            <Button
              className={HEADER_BUTTON}
              onClick={() => {
                // Opens on the month the owner is looking at, every time. Left
                // holding its last value, the dialog would offer to bill a month
                // chosen two screens ago under a heading naming this one.
                setBillMonth(month);
                setShowFeeRun(true);
              }}
              type="button"
              variant="outline"
            >
              <CalendarPlus className="size-4" />
              Generate Invoices
            </Button>
            <RoleButton
              className={HEADER_BUTTON}
              onClick={() => {
                setPayMonths(null);
                setShowCreate(true);
              }}
              tone="admin"
              type="button"
            >
              <Plus className="size-4" />
              Record Payment
            </RoleButton>
          </>
        }
        description="Rent collected, still owed, and claims waiting on you."
        title="Payments"
      />

      {message ? (
        <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
          {message}
        </div>
      ) : null}

      {/* Lifetime figures for the hostel, not for the month in the table —
          "how are we doing" is not a question about August. Each card filters
          the table below to the rows it counts. */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div
          className="relative"
          onBlur={() => setShowShare(false)}
          onFocus={() => setShowShare(true)}
          onMouseEnter={() => setShowShare(true)}
          onMouseLeave={() => setShowShare(false)}
        >
          <MetricCard
            active={filter === "PAID"}
            icon={WalletCards}
            label="Collected (all time)"
            onClick={() => filterBy("PAID")}
            tone="teal"
            trend={`${overall?.paid ?? 0} bills fully paid`}
            value={currency(overall?.collected ?? 0)}
          />
          {overall && overall.collected + overall.outstanding > 0 ? (
            <span className="pointer-events-none absolute bottom-2.5 left-[65px] right-5 h-1 overflow-hidden rounded-full bg-foreground/15">
              <span
                className="block h-full rounded-full bg-emerald-500 transition-[width] duration-500 ease-out"
                style={{ width: `${Math.round((overall.collected / (overall.collected + overall.outstanding)) * 100)}%` }}
              />
            </span>
          ) : null}
        </div>
        <MetricCard
          active={filter === "UNPAID"}
          icon={ReceiptText}
          label="Outstanding (all time)"
          onClick={() => filterBy("UNPAID")}
          tone="teal"
          trend={`${(overall?.unpaid ?? 0) + (overall?.partial ?? 0)} open records`}
          value={currency(overall?.outstanding ?? 0)}
        />
        <MetricCard
          active={filter === "PENDING_PROOF"}
          icon={Clock3}
          label="Pending Proofs"
          onClick={() => {
            setQueueForced((open) => !open);
            filterBy("PENDING_PROOF");
          }}
          tone="amber"
          trend="Awaiting approval"
          value={String(overall?.pendingProofs ?? stats.pendingProofs)}
        />
        <MetricCard
          active={filter === "OVERDUE"}
          icon={AlertTriangle}
          label="Overdue Residents"
          onClick={() => filterBy("OVERDUE")}
          tone="rose"
          trendDown
          trend="Needs follow-up"
          value={String(overall?.overdueResidents ?? 0)}
        />
      </div>

      {overall && overall.collected + overall.outstanding > 0 ? (
        <div
          className={`grid transition-[grid-template-rows,opacity,margin] duration-300 ease-out ${
            showShare ? "grid-rows-[1fr] opacity-100" : "mb-0 grid-rows-[0fr] opacity-0"
          }`}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="rounded-2xl border border-border/70 bg-card px-4 py-3">
              <ShareBar
                label="rupees collected of everything billed"
                total={overall.collected + overall.outstanding}
                value={overall.collected}
              />
            </div>
          </div>
        </div>
      ) : null}

      <Dialog onOpenChange={setShowCreate} open={showCreate}>
        <DialogContent
          className={`transition-[max-width] duration-300 ease-out ${payResidentId ? "sm:max-w-2xl" : "sm:max-w-lg"}`}
        >
          <DialogHeader>
            <DialogTitle>Record a payment</DialogTitle>
            <DialogDescription>Cash a resident handed over — pick one or more unpaid months.</DialogDescription>
          </DialogHeader>
          <BusyForm className="grid gap-3 md:grid-cols-2" onSubmit={handleCreatePayment}>
            <FormSelect
              label="Resident"
              name="residentId"
              onChange={(event) => {
                setPayResidentId(event.target.value);
                setPayMonths(null);
              }}
              required
              value={payResidentId}
            >
              <option value="">Select resident</option>
              {livingResidents.map((resident) => (
                <option key={resident.id} value={resident.id}>
                  {resident.firstName} {resident.lastName}
                </option>
              ))}
            </FormSelect>

            <div
              className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out md:col-span-2 ${
                payResidentId ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
              }`}
            >
              <div className="grid min-h-0 gap-3 overflow-hidden md:grid-cols-2">
            {payResidentId ? (
              <div className="rounded-2xl border border-border/70 bg-muted/30 p-4 md:col-span-2">
                {payLedger.state === "loading" ? <LoadingRows /> : null}
                {payLedger.state !== "loading" && unpaidMonths.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">
                    Nothing is due for this resident — every billed month is paid.
                  </p>
                ) : null}
                {unpaidMonths.length > 0 ? (
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[13px] font-semibold text-foreground">Months to pay</p>
                      <span className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
                        {payMethod === "CASH" ? (
                          <Banknote className="size-4" />
                        ) : (
                          <MethodMark logo={ONLINE_METHODS.find((m) => m.value === payMethod)?.logo ?? "ESEWA"} size={20} />
                        )}
                        Paying by {payMethod === "CASH" ? "cash" : ONLINE_METHODS.find((m) => m.value === payMethod)?.label}
                      </span>
                    </div>
                    <div className="divide-y divide-border/60 text-[13px]">
                      {unpaidMonths.map((entry) => {
                        const owed = entry.dueAmount - entry.paidAmount;

                        return (
                          <label className="flex cursor-pointer items-center justify-between gap-3 py-1.5" key={entry.period}>
                            <span className="flex items-center gap-2">
                              <input
                                checked={chosenPeriods.includes(entry.period)}
                                className="size-4 accent-[var(--brand)]"
                                onChange={(event) =>
                                  setPayMonths(
                                    event.target.checked
                                      ? [...chosenPeriods, entry.period]
                                      : chosenPeriods.filter((period) => period !== entry.period),
                                  )
                                }
                                type="checkbox"
                              />
                              {monthLabel(entry.period)}
                              {entry.paidAmount > 0 ? <SoftBadge tone="amber">PARTIAL</SoftBadge> : null}
                              {entry.lines
                                .filter((line) => line.basis === "FINE")
                                .map((line) => (
                                  <SoftBadge key={line.description} tone="amber">
                                    incl. {currency(line.amount)} late fine{fineGrowth(line) ? ` · +${currency(fineGrowth(line)!.perDay)}/day` : ""}
                                  </SoftBadge>
                                ))}
                            </span>
                            <span className="font-medium text-foreground">{currency(owed)}</span>
                          </label>
                        );
                      })}
                    </div>
                    <div className="flex justify-between border-t border-border/60 pt-2 text-[14px] font-bold text-foreground">
                      <span>Balance due ({chosenBills.length} month{chosenBills.length === 1 ? "" : "s"})</span>
                      <span>{currency(payBalance)}</span>
                    </div>
                    {remainingLines.length === 0 ? (
                      <div className="flex justify-between text-[13px] font-medium text-success">
                        <span>Remaining</span>
                        <span>{currency(0)}</span>
                      </div>
                    ) : (
                      remainingLines.map((line) => (
                        <div className="flex justify-between text-[13px] font-medium text-warning" key={line.period}>
                          <span>Remaining of {monthLabel(line.period)}</span>
                          <span>{currency(line.amount)}</span>
                        </div>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}

            {payBalance > 0 ? (
              <>
                <div className="grid grid-cols-2 gap-2 md:col-span-2" role="radiogroup" aria-label="Paid by">
                  <button
                    aria-checked={payMethod === "CASH"}
                    className={`flex h-11 items-center justify-center gap-2 rounded-xl border text-[13.5px] font-semibold transition-colors ${
                      payMethod === "CASH"
                        ? "border-brand bg-brand/10 text-brand"
                        : "border-border/70 text-muted-foreground hover:bg-muted/50"
                    }`}
                    onClick={() => setPayMethod("CASH")}
                    role="radio"
                    type="button"
                  >
                    <Banknote className="size-4" />
                    Cash
                  </button>
                  {/* Rests as "Online"; on hover or focus the label gives way to
                      the three providers, so the choice is one click on a logo. */}
                  <div
                    className={`group relative h-11 overflow-hidden rounded-xl border transition-colors ${
                      payMethod !== "CASH" ? "border-brand bg-brand/10" : "border-border/70 hover:bg-muted/50"
                    }`}
                    role="group"
                  >
                    <span className="absolute inset-0 flex items-center justify-center gap-2 text-[13.5px] font-semibold transition-all duration-300 ease-out group-focus-within:scale-95 group-focus-within:opacity-0 group-hover:scale-95 group-hover:opacity-0">
                      {payMethod === "CASH" ? (
                        <Smartphone className="size-4 text-muted-foreground" />
                      ) : (
                        <MethodMark logo={ONLINE_METHODS.find((m) => m.value === payMethod)?.logo ?? "ESEWA"} size={24} />
                      )}
                      <span className={payMethod === "CASH" ? "text-muted-foreground" : "text-brand"}>
                        {payMethod === "CASH" ? "Online" : ONLINE_METHODS.find((m) => m.value === payMethod)?.label}
                      </span>
                    </span>
                    <span className="absolute inset-0 flex items-center justify-evenly px-2 opacity-0 transition-all duration-300 ease-out group-focus-within:opacity-100 group-hover:opacity-100">
                      {ONLINE_METHODS.map((method, index) => (
                        <button
                          aria-checked={payMethod === method.value}
                          aria-label={method.label}
                          className={`rounded-lg transition-all duration-300 ease-out hover:scale-110 focus-visible:scale-110 ${
                            payMethod === method.value ? "ring-2 ring-brand" : "opacity-80 hover:opacity-100"
                          } translate-y-1 group-focus-within:translate-y-0 group-hover:translate-y-0`}
                          key={method.value}
                          onClick={() => setPayMethod(method.value)}
                          role="radio"
                          style={{ transitionDelay: `${index * 40}ms` }}
                          title={method.label}
                          type="button"
                        >
                          <MethodMark logo={method.logo} size={30} />
                        </button>
                      ))}
                    </span>
                  </div>
                </div>
                <FormInput
                  label="Amount received"
                  onChange={(event) => setAmountEdit({ key: amountKey, value: event.target.value })}
                  value={payAmount}
                  max={String(payBalance)}
                  min="1"
                  name="amount"
                  required
                  type="number"
                />
                <FormInput label="Note" name="remarks" />
                <FormInput
                  defaultValue={sessionName}
                  label="Received by"
                  name="collectedBy"
                  placeholder="Who took the money"
                  required
                />
                <FormInput
                  label={payMethod !== "CASH" ? "Transaction ID (optional)" : "Receipt no. (optional)"}
                  name="cashReceiptNumber"
                />
              </>
            ) : null}
              </div>
            </div>
            <DialogFooter className="md:col-span-2">
              <SubmitButton
                busyLabel="Processing…"
                className="h-10 gap-2 rounded-xl bg-brand-teal px-5 text-white hover:bg-brand-teal/90"
                disabled={payBalance === 0}
              >
                <CreditCard className="size-4" />
                Record payment
              </SubmitButton>
            </DialogFooter>
          </BusyForm>
        </DialogContent>
      </Dialog>

      {/* Billing is a monthly event, not a control panel: it was a permanent
          card taking a third of the screen for a job done once a month, and it
          was read as "some settings I do not understand" rather than "the button
          that issues this month's rent". Behind a dialog, with the fields
          pre-filled and the effect stated in a sentence. */}
      <Dialog onOpenChange={setShowFeeRun} open={showFeeRun}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Generate monthly invoices</DialogTitle>
            <DialogDescription>
              One rent invoice per active resident, priced from your fee schedule.
            </DialogDescription>
          </DialogHeader>

          <form className="grid gap-3" onSubmit={handleFeeRun}>
            <div className="grid gap-3 sm:grid-cols-2">
              <MonthField
                label="Month to bill"
                name="month"
                onChange={setBillMonth}
                value={billMonth}
              />
              {/* Keyed on the month so the pre-filled due date follows it. A
                  date left over from the previously selected month is the one
                  mistake this dialog cannot show you: it looks filled in, and it
                  stamps an Asar deadline on a Bhadra invoice. */}
              <FormInput
                defaultValue={defaultDueDate(billMonth)}
                key={billMonth}
                label="Payment due by"
                name="dueDate"
                required
                type="date"
              />
            </div>
            <FormInput
              label="Override everyone's fee (optional)"
              min="0"
              name="monthlyFee"
              placeholder="Leave blank to use the fee schedule"
              type="number"
            />

            {/* The count comes from the table, which is loaded for one month.
                Pick a different month to bill and the number no longer
                describes it — so it is dropped rather than restated under the
                wrong heading. A confident "0 residents" about a month nobody
                has counted is the sentence that stops an owner billing.
                Already-billed residents are skipped, so running it twice is
                safe; anyone the fee schedule cannot price is reported, never
                billed zero. */}
            <p className="flex items-center gap-2 rounded-xl bg-muted/60 px-3 py-2.5 text-[12.5px] text-muted-foreground">
              <CalendarPlus className="size-4 shrink-0 text-role-team" />
              {billMonth === month ? (
                <span>
                  <span className="font-semibold text-foreground">{stats.notBilled} resident(s)</span> have no
                  invoice for {monthLabel(month)} yet. Only they are billed.
                </span>
              ) : (
                <span>
                  Everyone with no invoice for{" "}
                  <span className="font-semibold text-foreground">{monthLabel(billMonth)}</span> is billed.
                </span>
              )}
            </p>

            <DialogFooter>
              <Button
                onClick={() => setShowFeeRun(false)}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <RoleButton tone="admin" type="submit">
                <CreditCard className="size-4" />
                Generate invoices
              </RoleButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* The queue comes before the matrix (§11.4). The matrix answers "who has
          not paid", which is a question that keeps; the queue is money waiting on
          a decision, and it is what the owner opened this screen for. */}
      <div
        className={`grid transition-[grid-template-rows,opacity,margin] duration-300 ease-out ${
          pendingProofs.length > 0 || queueForced
            ? "grid-rows-[1fr] opacity-100"
            : "mb-0 grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
      <HostelAdminReviewQueue
        approvingAll={approvingAll}
        bedLabelByResidentId={bedLabelByResidentId}
        claims={pendingProofs}
        nameFor={(proof) => {
          const resident = residentById.get(proof.residentId);

          return resident
            ? `${resident.firstName} ${resident.lastName}`
            : (proof.residentName ?? "Resident");
        }}
        onApprove={(eventId) => void reviewProof(eventId, "approve")}
        onApproveAll={() => void approveAll()}
        onOpen={setReviewingId}
        onReject={(eventId, reason) => void reviewProof(eventId, "reject", reason)}
        processing={processing}
      />
        </div>
      </div>

      <div className="grid gap-5">
        <SectionCard>
          <div>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <SearchField
                onChange={setSearch}
                placeholder="Search by resident name or room type…"
                size="lg"
                value={search}
              />
              {/* "To review" is the bucket target §11.4 opens with, and the one
                  the Pending Proofs card sets — so it has a chip that shows as on. */}
              <FilterButton active={filter === "ALL" ? 0 : 1} onClear={() => setFilter("ALL")}>
                <FilterChoice
                  label="Status"
                  onChange={setFilter}
                  options={[
                    { label: `All ${rows.length}`, value: "ALL" },
                    { label: `Paid ${stats.paid}`, value: "PAID" },
                    { label: `Unpaid ${stats.unpaid}`, value: "UNPAID" },
                    { label: `Partial ${stats.partial}`, value: "PARTIAL" },
                    { label: `Overdue ${stats.overdue}`, value: "OVERDUE" },
                    { label: `To review ${stats.toReview}`, value: "PENDING_PROOF" },
                  ]}
                  value={filter}
                />
              </FilterButton>
              <span className="text-[12.5px] font-medium text-muted-foreground">
                {filteredRows.length} of {rows.length} residents
              </span>
              <div className="ml-auto">
                <MonthPicker
                  months={periods}
                  onChange={setMonth}
                  value={month}
                />
              </div>
            </div>

            <div>
              {state === "loading" ? <LoadingRows /> : null}
              {state === "error" ? (
                <EmptyState label="Payments could not be loaded." />
              ) : null}
              {state === "ready" && filteredRows.length === 0 ? (
                <EmptyInline label="No residents for this month." />
              ) : null}
              {state === "ready" && filteredRows.length > 0 ? (
                <DataTable className="min-w-[760px]">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      {/* Month and due date are separate columns on purpose.
                          Stacking them in one cell read as a riddle — August
                          rent falls due on 1 September, and two dates in one box
                          leaves the reader working out which is which. */}
                      {[
                        "Resident",
                        "Month",
                        "Due (NPR)",
                        "Paid",
                        "Status",
                        "Pay By",
                      ].map((heading) => (
                        <TableHead
                          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                          key={heading}
                        >
                          {heading}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredRows.map((row) => {
                      const name = row.resident.fullName;
                      // The move-in *instant* converted to a period, not a
                      // string prefix. `moveInDate` is an ISO timestamp and
                      // `month` is now `2083-05`, so the old `startsWith` could
                      // not match on any resident in any hostel — every
                      // mid-month intake lost its "(pro-rated)" note, which is
                      // the only thing on the row explaining a part-month
                      // amount.
                      const movedInThisMonth =
                        periodKey(new Date(row.resident.moveInDate)) === month;

                      return (
                        <TableRow
                          className="cursor-pointer"
                          key={row.resident.id}
                          onClick={() => setTrackResidentId(row.resident.id)}
                          tabIndex={0}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setTrackResidentId(row.resident.id);
                            }
                          }}
                          role="button"
                        >
                          <TableCell>
                            <div className="flex items-center gap-3">
                              <InitialsAvatar name={name} size="sm" tone="admin" />
                              <div>
                                <p className="font-semibold text-foreground">{name}</p>
                                <p className="text-xs text-muted-foreground">
                                  {row.resident.roomType
                                    ? `${roomTypeLabel(row.resident.roomType)} · `
                                    : ""}
                                  {row.resident.phone}
                                  {movedInThisMonth
                                    ? ` · moved in ${dayMonthYear(row.resident.moveInDate)} (pro-rated)`
                                    : ""}
                                </p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="font-medium text-foreground">
                            {row.payment ? monthLabel(row.payment.month) : monthLabel(month)}
                          </TableCell>
                          <TableCell className="font-medium">
                            {row.payment ? (
                              currency(row.payment.dueAmount)
                            ) : row.notBilled?.amount ? (
                              <span className="text-muted-foreground">{currency(row.notBilled.amount)}</span>
                            ) : (
                              "—"
                            )}
                            {row.payment ? (
                              <BillExtraTags
                                fineWaived={row.payment.fineWaived}
                                lines={row.payment.lines}
                                onWaive={
                                  row.displayStatus === "PAID"
                                    ? undefined
                                    : () => void waiveFine(row.payment!.id, name)
                                }
                              />
                            ) : null}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            <span className="inline-flex items-center gap-2">
                              {row.payment?.paymentMethod && row.payment.paidAmount > 0 ? (
                                <WalletMark name={row.payment.paymentMethod} size={22} />
                              ) : null}
                              {row.payment ? currency(row.payment.paidAmount) : "—"}
                            </span>
                          </TableCell>
                          <TableCell>
                            <SoftBadge
                              tone={
                                row.displayStatus === "NOT_BILLED"
                                  ? "slate"
                                  : statusToneFromLabel(row.displayStatus)
                              }
                            >
                              {row.displayStatus === "NOT_BILLED"
                                ? notBilledLabel(row.notBilled?.reason)
                                : row.displayStatus.replaceAll("_", " ")}
                            </SoftBadge>
                          </TableCell>
                          {/* Both calendars, BS leading, stacked rather than
                              joined: this is a column the owner scans down, and
                              a single line carrying two dates makes the eye do
                              the splitting on every row. Never "9/1/2026" —
                              which month that is depends on the reader's locale,
                              and rent is not a thing to be ambiguous about. */}
                          <TableCell className="text-muted-foreground">
                            {row.payment ? (
                              <>
                                <span className="block font-medium text-foreground">
                                  {dayMonthYearBs(row.payment.dueDate) ||
                                    dayMonthYear(row.payment.dueDate)}
                                </span>
                                <span className="block text-[11px]">
                                  {dayMonthYear(row.payment.dueDate)}
                                </span>
                              </>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </DataTable>
              ) : null}
            </div>
          </div>
        </SectionCard>
      </div>

      {reviewingProof ? (
        <ProofReviewModal
          onApprove={() => void reviewProof(reviewingProof.eventId, "approve")}
          onClose={() => setReviewingId("")}
          onReject={(reason) =>
            void reviewProof(reviewingProof.eventId, "reject", reason)
          }
          processing={processing?.id === reviewingProof.eventId ? processing.action : null}
          proof={reviewingProof}
          residentName={
            residentById.get(reviewingProof.residentId)
              ? `${residentById.get(reviewingProof.residentId)!.firstName} ${
                  residentById.get(reviewingProof.residentId)!.lastName
                }`
              : (reviewingProof.residentName ?? "Resident")
          }
        />
      ) : null}

      {trackResidentId ? (
        <ResidentPaymentTrackSheet
          onClose={() => setTrackResidentId("")}
          residentId={trackResidentId}
        />
      ) : null}
    </div>
  );
});
