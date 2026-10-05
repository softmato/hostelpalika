"use client";
import { downloadCsv } from "@/lib/downloads/downloader";

import {
  AlertTriangle,
  CalendarPlus,
  Clock3,
  CreditCard,
  Download,
  Plus,
  ReceiptText,
  WalletCards,
  X,
} from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { BillExtraTags, type BillLine } from "./khata-pages";

type MatrixRow = {
  displayStatus:
    | "PAID"
    | "PARTIAL"
    | "UNPAID"
    | "OVERDUE"
    | "PENDING_PROOF"
    | "NOT_BILLED";
  payment: (Payment & { lines?: BillLine[] }) | null;
  resident: Resident & {
    fullName: string;
    moveInDate: string;
    /** Bed type — the attribute the hostel identifies a resident by (§11.4). */
    roomType?: string | null;
  };
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
  const [showFeeRun, setShowFeeRun] = useState(false);
  /**
   * The month the billing dialog will bill, tracked here rather than left to the
   * form so the due-date field beside it can follow along. Seeded from the table
   * when the dialog opens — the owner has just been looking at that month.
   */
  const [billMonth, setBillMonth] = useState(defaultMonth);
  const [approvingAll, setApprovingAll] = useState(false);
  /** Whose month-by-month history is open in the side sheet. "" means none. */
  const [trackResidentId, setTrackResidentId] = useState("");
  /** Which claim is open in the full review modal (item 3, target §11.4). */
  const [reviewingId, setReviewingId] = useState("");
  const invalidate = useInvalidateResources();

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
  const rows = useMemo(() => matrixResource.data?.rows ?? [], [matrixResource.data]);
  const totals = matrixResource.data?.totals ?? null;
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
    );
  }, [invalidate]);

  const handleCreatePayment = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);

      try {
        await browserApi(hostelAdminEndpoints.transactions, {
          body: JSON.stringify({
            dueAmount: Number(field(form, "dueAmount")),
            dueDate: field(form, "dueDate"),
            month: field(form, "month"),
            residentId: field(form, "residentId"),
            remarks: optionalField(form, "remarks"),
          }),
          method: "POST",
        });
        formElement.reset();
        setShowCreate(false);
        setActionMessage("Payment record created.");
        refreshPayments();
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not create payment.",
        );
      }
    },
    [refreshPayments],
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
            <Button
              className="h-10 gap-2 rounded-xl"
              disabled={filteredRows.length === 0}
              onClick={() =>
                downloadCsv(
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
              type="button"
              variant="outline"
            >
              <Download className="size-4" />
              Export
            </Button>
            <Button
              className="h-10 gap-2 rounded-xl"
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
              onClick={() => setShowCreate((value) => !value)}
              tone="admin"
              type="button"
            >
              <Plus className="size-4" />
              Record Payment
            </RoleButton>
          </>
        }
        description="Manage hostel fee collections, payments and approvals."
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
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          active={filter === "PAID"}
          icon={WalletCards}
          label="Collected (all time)"
          onClick={() => filterBy("PAID")}
          tone="blue"
          trend={`${overall?.paid ?? 0} month(s) settled`}
          value={currency(overall?.collected ?? 0)}
        />
        <MetricCard
          active={filter === "UNPAID"}
          icon={ReceiptText}
          label="Outstanding (all time)"
          onClick={() => filterBy("UNPAID")}
          tone="cyan"
          trend={`${(overall?.unpaid ?? 0) + (overall?.partial ?? 0)} open records`}
          value={currency(overall?.outstanding ?? 0)}
        />
        <MetricCard
          active={filter === "PENDING_PROOF"}
          icon={Clock3}
          label="Pending Proofs"
          onClick={() => filterBy("PENDING_PROOF")}
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

      {showCreate ? (
        <SectionCard
          actions={
            <Button
              className="size-8"
              onClick={() => setShowCreate(false)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <X className="size-4" />
            </Button>
          }
          title="Create Payment Record"
        >
          <form className="grid gap-3 md:grid-cols-2" onSubmit={handleCreatePayment}>
            <FormSelect label="Resident" name="residentId" required>
              <option value="">Select resident</option>
              {residents.map((resident) => (
                <option key={resident.id} value={resident.id}>
                  {resident.firstName} {resident.lastName}
                </option>
              ))}
            </FormSelect>
            <MonthField label="Month" name="month" />
            <FormInput label="Due amount" name="dueAmount" required type="number" />
            <FormInput label="Due date" name="dueDate" required type="date" />
            <div className="md:col-span-2">
              <TextArea label="Remarks" name="remarks" />
            </div>
            <div className="md:col-span-2">
              <RoleButton className="w-full sm:w-auto" tone="admin" type="submit">
                <CreditCard className="size-4" />
                Create Record
              </RoleButton>
            </div>
          </form>
        </SectionCard>
      ) : null}

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
              Issues one rent invoice per active resident for the month you pick,
              priced from your fee schedule and each resident&apos;s bed type.
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

            <ul className="space-y-1.5 rounded-lg border border-border/70 bg-muted/20 p-3 text-[12px] text-muted-foreground">
              {/* The count comes from the table, which is loaded for one month.
                  Pick a different month to bill and the number no longer
                  describes it — so it is dropped rather than restated under the
                  wrong heading. A confident "0 residents" about a month nobody
                  has counted is the sentence that stops an owner billing. */}
              <li>
                {billMonth === month ? (
                  <>
                    <span className="font-semibold text-foreground">
                      {stats.notBilled} resident(s)
                    </span>{" "}
                    have no invoice for {monthLabel(month)} yet — only they will be
                    billed.
                  </>
                ) : (
                  <>
                    Every active resident with no invoice for{" "}
                    <span className="font-semibold text-foreground">
                      {monthLabel(billMonth)}
                    </span>{" "}
                    will be billed.
                  </>
                )}
              </li>
              <li>Residents who already have one are skipped, so running it twice is safe.</li>
              <li>
                Anyone your fee schedule cannot price is reported instead of billed zero.
              </li>
            </ul>

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
      <HostelAdminReviewQueue
        approvingAll={approvingAll}
        bedLabelByResidentId={bedLabelByResidentId}
        busy={approvingAll}
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
      />

      <div className="grid gap-5">
        <SectionCard>
          <Tabs onValueChange={setFilter} value={filter}>
            <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <TabsList
                className="h-auto flex-wrap rounded-none bg-transparent p-0"
                variant="line"
              >
                <TabsTrigger className="rounded-none px-3 pb-2" value="ALL">
                  All ({rows.length})
                </TabsTrigger>
                <TabsTrigger className="rounded-none px-3 pb-2" value="PAID">
                  Paid ({stats.paid})
                </TabsTrigger>
                <TabsTrigger className="rounded-none px-3 pb-2" value="UNPAID">
                  Unpaid ({stats.unpaid})
                </TabsTrigger>
                <TabsTrigger className="rounded-none px-3 pb-2" value="PARTIAL">
                  Partial ({stats.partial})
                </TabsTrigger>
                <TabsTrigger className="rounded-none px-3 pb-2" value="OVERDUE">
                  Overdue ({stats.overdue})
                </TabsTrigger>
                {/* The bucket target §11.4 opens with. Reachable from the
                    Pending Proofs card, so the filter it sets has a tab that
                    can show as active. */}
                <TabsTrigger className="rounded-none px-3 pb-2" value="PENDING_PROOF">
                  To review ({stats.toReview})
                </TabsTrigger>
              </TabsList>
              <MonthPicker
                months={periods}
                onChange={setMonth}
                value={month}
              />
            </div>

            <SearchField
              className="mb-4 max-w-none"
              onChange={setSearch}
              placeholder="Search by resident name or room type…"
              size="lg"
              value={search}
            />

            <TabsContent className="mt-0" value={filter}>
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
                                    ? `${row.resident.roomType} · `
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
                            {row.payment ? currency(row.payment.dueAmount) : "—"}
                            {row.payment ? (
                              <BillExtraTags
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
                            {row.payment ? currency(row.payment.paidAmount) : "—"}
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
                                ? "NO FEE SET"
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
            </TabsContent>
          </Tabs>
        </SectionCard>
      </div>

      {reviewingProof ? (
        <ProofReviewModal
          onApprove={() => void reviewProof(reviewingProof.eventId, "approve")}
          onClose={() => setReviewingId("")}
          onReject={(reason) =>
            void reviewProof(reviewingProof.eventId, "reject", reason)
          }
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
