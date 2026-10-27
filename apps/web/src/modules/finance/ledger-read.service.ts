import { Types } from "mongoose";
import type { PipelineStage } from "mongoose";

import { InvoiceModel } from "@hostel/db/models/Invoice";

/**
 * The one place anything reads the ledger (ADR-3, D3).
 *
 * Eight services used to query `Payment` directly. Routing them through this
 * facade in item 2.3 is what made the cutover a change inside one file instead
 * of eight — and item 2.8 is that change: `Payment` is gone, and every function
 * below now answers from `Invoice` + `InvoiceBalance` + `PaymentEvent`.
 *
 * ## The scope type is still the point
 *
 * Consumers pass a {@link LedgerScope} — hostels, residents, periods — never a
 * Mongo filter. That is why none of them needed touching when the source
 * changed underneath them.
 *
 * ## Vocabulary
 *
 * {@link LedgerInvoice} still speaks `UNPAID` and `BANK_TRANSFER` where the
 * models say `OPEN` and `BANK`. The translation stays until Block 3 moves the
 * screens over one at a time; doing it here means the cutover did not have to
 * be a simultaneous rewrite of every consumer, which is the whole point of the
 * facade. `LEGACY_STATUS_BY_INVOICE_STATUS` is the list of what still has to
 * change, and it shrinks as Block 3 lands.
 *
 * `FINANCE_LEDGER_SOURCE` is gone with `Payment`: there is no longer a second
 * source to select, and a flag that can only take one value is a lie about what
 * is configurable.
 */

/**
 * What slice of the ledger a caller wants.
 *
 * Every field is optional and they combine with AND. An empty scope means
 * platform-wide, which is only ever reachable from a platform-admin route.
 */
export type LedgerScope = {
  hostelId?: Types.ObjectId | string;
  hostelIds?: (Types.ObjectId | string)[];
  invoiceIds?: (Types.ObjectId | string)[];
  /** "YYYY-MM". */
  period?: string;
  periods?: string[];
  residentId?: Types.ObjectId | string;
  residentIds?: (Types.ObjectId | string)[];
  /** Money that settled in a window — what the revenue trends are built from. */
  settledFrom?: Date;
  settledTo?: Date;
  /** Only invoices still owing something. */
  unsettledOnly?: boolean;
};

/**
 * An invoice as the rest of the product sees it.
 *
 * Deliberately not `Invoice`'s shape: it is the intersection the consumers
 * actually use. `paidAmount` is **derived** — the settled event sum, never a
 * stored column, which is the property the whole overhaul exists to create.
 */
export type LedgerInvoice = {
  createdAt?: Date;
  dueAmount: number;
  dueDate?: Date;
  hostelId: string;
  id: string;
  method?: string;
  paidAmount: number;
  paidDate?: Date;
  /** The bill's lines (rent, discount, fine, khata), where the read carried them. */
  lines?: { amount: number; basis: string; description: string }[];
  /**
   * `null` for a one-off — an admission fee, a fine, a deposit adjustment.
   * `Invoice.period` is nullable by design (see the model) and this type used to
   * claim otherwise, which is how a period-less invoice reached a `localeCompare`
   * sort in `getPeriodSummary` and pushed a phantom month to the front of the
   * roll-up. Consumers already wrote `invoice.period ?? …`; the type now agrees
   * with them.
   */
  period: string | null;
  remarks?: string;
  residentId: string;
  status: string;
};

/** Invoice statuses that still owe something. `DRAFT` is not yet an obligation. */
const LEDGER_UNSETTLED_STATUSES = ["OPEN", "PARTIAL", "OVERDUE"];

/**
 * `Invoice.status` → the word the consumers still branch on.
 *
 * `VOID` never appears: voided invoices are filtered out of every read below,
 * because a cancelled obligation is not a smaller obligation. `WRITTEN_OFF`
 * passes through under its own name — inventing an alias would either overstate
 * the debt or understate the loss.
 */
const LEGACY_STATUS_BY_INVOICE_STATUS: Record<string, string> = {
  DRAFT: "UNPAID",
  OPEN: "UNPAID",
  OVERDUE: "OVERDUE",
  PAID: "PAID",
  PARTIAL: "PARTIAL",
  WRITTEN_OFF: "WRITTEN_OFF",
};

/** `PaymentEvent.provider` → the payment-method word the screens show. */
const LEGACY_METHOD_BY_PROVIDER: Record<string, string> = {
  BANK: "BANK_TRANSFER",
  CASH: "CASH",
  ESEWA: "ESEWA",
  FONEPAY: "FONEPAY",
  KHALTI: "KHALTI",
};

/**
 * Translates a scope into an `Invoice` filter.
 *
 * Exported for its tests: a wrong translation is the only way this facade can
 * silently answer the wrong question.
 */
/**
 * Every id in this filter has to be a real `ObjectId`, never the string form.
 *
 * This filter is spent inside an **aggregation** `$match`, and Mongoose does not
 * cast aggregation pipelines the way it casts `find()`. A caller holding an id
 * as a string — anything that came out of a URL segment, a JSON body or a
 * `toString()` — therefore matched *nothing*, silently and with no error: the
 * screen rendered "no invoices" for a resident who has three. Casting here
 * rather than at each call site is deliberate; the trap is invisible at the call
 * site, so the boundary that knows about it should be the one that closes it.
 */
function oid(value: Types.ObjectId | string): Types.ObjectId | string {
  // A malformed id is left alone rather than thrown on: it matches nothing,
  // which is the same answer the caller would get anyway, and a read must not
  // turn a bad id into a 500.
  return typeof value === "string" && Types.ObjectId.isValid(value)
    ? new Types.ObjectId(value)
    : value;
}

export function ledgerFilterFor(scope: LedgerScope): Record<string, unknown> {
  const filter: Record<string, unknown> = {};

  if (scope.hostelId) {
    filter.hostelId = oid(scope.hostelId);
  }

  if (scope.hostelIds) {
    filter.hostelId = { $in: scope.hostelIds.map(oid) };
  }

  if (scope.residentId) {
    filter.residentId = oid(scope.residentId);
  }

  if (scope.residentIds) {
    filter.residentId = { $in: scope.residentIds.map(oid) };
  }

  if (scope.period) {
    filter.period = scope.period;
  }

  if (scope.periods) {
    filter.period = { $in: scope.periods };
  }

  if (scope.invoiceIds) {
    filter._id = { $in: scope.invoiceIds.map(oid) };
  }

  // A voided invoice is a decision to un-bill, not a balance of zero, and it
  // must not appear in a total, a count or a list. Applied last so
  // `unsettledOnly` — whose own list already excludes VOID — can overwrite it.
  filter.status = scope.unsettledOnly
    ? { $in: LEDGER_UNSETTLED_STATUSES }
    : { $ne: "VOID" };

  return filter;
}

/**
 * The pipeline every read starts from: invoices, joined to their cached balance
 * and their most recent settlement.
 *
 * The balance join is against `InvoiceBalance` rather than a `$group` over the
 * events, because that cache exists precisely so a page load does not sum an
 * event log. When the cache is wrong, `verify-finance-ledger.mjs` says so — a
 * read is not the place to discover it, and certainly not the place to fix it.
 *
 * The second join reproduces two columns that have no invoice-level equivalent:
 * `paidDate` and `method` are properties of *a payment*, and the ledger's answer
 * is "the latest settled one".
 */
function ledgerPipeline(scope: LedgerScope): PipelineStage[] {
  const stages: PipelineStage[] = [
    { $match: ledgerFilterFor(scope) },
    {
      $lookup: {
        as: "balance",
        foreignField: "invoiceId",
        from: "invoicebalances",
        localField: "_id",
      },
    },
    {
      $lookup: {
        as: "lastSettled",
        from: "paymentevents",
        let: { invoiceId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$invoiceId", "$$invoiceId"] },
              direction: "CREDIT",
              status: "SETTLED",
            },
          },
          { $sort: { settledAt: -1 } },
          { $limit: 1 },
          { $project: { provider: 1, settledAt: 1 } },
        ],
      },
    },
    {
      // A claim awaiting review is the state the screens call `PENDING_PROOF`.
      // It is a property of the events, not of the invoice.
      $lookup: {
        as: "pendingClaims",
        from: "paymentevents",
        let: { invoiceId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$invoiceId", "$$invoiceId"] },
              direction: "CREDIT",
              status: "PENDING",
            },
          },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
      },
    },
    {
      $addFields: {
        hasPendingClaim: { $gt: [{ $size: "$pendingClaims" }, 0] },
        method: { $arrayElemAt: ["$lastSettled.provider", 0] },
        paidAmount: { $ifNull: [{ $arrayElemAt: ["$balance.settledAmount", 0] }, 0] },
        paidDate: { $arrayElemAt: ["$lastSettled.settledAt", 0] },
      },
    },
  ];

  if (scope.settledFrom || scope.settledTo) {
    // Applied one stage later than a filter would be: `paidDate` does not exist
    // until the join above has run.
    stages.push({
      $match: {
        paidDate: {
          ...(scope.settledFrom ? { $gte: scope.settledFrom } : {}),
          ...(scope.settledTo ? { $lt: scope.settledTo } : {}),
        },
      },
    });
  }

  return stages;
}

type LedgerInvoiceRow = {
  _id: Types.ObjectId;
  createdAt?: Date;
  dueDate?: Date;
  hasPendingClaim?: boolean;
  hostelId: Types.ObjectId;
  lines?: { amount: number; basis: string; description: string }[];
  method?: string;
  paidAmount: number;
  paidDate?: Date;
  period: string | null;
  residentId: Types.ObjectId;
  status: string;
  totalAmount: number;
};

/**
 * The word the screens use for an invoice's state.
 *
 * `PENDING_PROOF` outranks `UNPAID` and `PARTIAL` only — a paid or overdue
 * invoice keeps its own status, because a pending claim must not hide an
 * overdue invoice from the one list an owner chases.
 */
export function legacyStatusFor(status: string, hasPendingClaim = false): string {
  const mapped = LEGACY_STATUS_BY_INVOICE_STATUS[status] ?? status;

  return hasPendingClaim && (mapped === "UNPAID" || mapped === "PARTIAL")
    ? "PENDING_PROOF"
    : mapped;
}

function fromLedgerRow(row: LedgerInvoiceRow): LedgerInvoice {
  return {
    createdAt: row.createdAt,
    dueAmount: row.totalAmount,
    dueDate: row.dueDate,
    hostelId: row.hostelId?.toString() ?? "",
    id: row._id.toString(),
    ...(row.lines
      ? { lines: row.lines.map(({ amount, basis, description }) => ({ amount, basis, description })) }
      : {}),
    method: row.method ? LEGACY_METHOD_BY_PROVIDER[row.method] : undefined,
    paidAmount: row.paidAmount ?? 0,
    paidDate: row.paidDate,
    period: row.period,
    residentId: row.residentId?.toString() ?? "",
    status: legacyStatusFor(row.status, row.hasPendingClaim),
  };
}

/* -------------------------------------------------------------------------- */
/*                                 the facade                                  */
/* -------------------------------------------------------------------------- */

/**
 * A resident's invoices, newest first.
 *
 * Serves the resident dashboard and the guardian view, both of which show a
 * short recent history rather than everything.
 */
export async function listResidentInvoices(
  scope: LedgerScope & { residentId: Types.ObjectId | string },
  options: { limit?: number } = {},
): Promise<LedgerInvoice[]> {
  const stages: PipelineStage[] = [...ledgerPipeline(scope), { $sort: { dueDate: -1 } }];

  if (options.limit) {
    stages.push({ $limit: options.limit });
  }

  const rows = await InvoiceModel.aggregate<LedgerInvoiceRow>(stages);

  return rows.map(fromLedgerRow);
}

/**
 * What a resident still owes across every unsettled invoice.
 *
 * Used by the move-out checklist, which snapshots it as `pendingFeeAmount`.
 * Clamped per invoice, not in total, so an overpaid month cannot silently
 * cancel out an unpaid one — that would understate the debt at exactly the
 * moment it matters.
 */
export async function outstandingForResident(
  scope: LedgerScope & { residentId: Types.ObjectId | string },
): Promise<number> {
  const rows = await InvoiceModel.aggregate<{ outstanding: number }>([
    ...ledgerPipeline({ ...scope, unsettledOnly: true }),
    {
      $group: {
        _id: null,
        outstanding: {
          $sum: { $max: [{ $subtract: ["$totalAmount", "$paidAmount"] }, 0] },
        },
      },
    },
  ]);

  return rows[0]?.outstanding ?? 0;
}

export type LedgerTotals = {
  dueAmount: number;
  paidAmount: number;
};

/** Billed and collected across a scope. The number every report card shows. */
export async function collectionTotals(scope: LedgerScope): Promise<LedgerTotals> {
  const [result] = await InvoiceModel.aggregate<LedgerTotals>([
    ...ledgerPipeline(scope),
    {
      $group: {
        _id: null,
        dueAmount: { $sum: "$totalAmount" },
        paidAmount: { $sum: "$paidAmount" },
      },
    },
  ]);

  return {
    dueAmount: result?.dueAmount ?? 0,
    paidAmount: result?.paidAmount ?? 0,
  };
}

/**
 * How many invoices sit in each value of a field across a scope.
 *
 * `field` is one of the facade's own dimensions, not a database column.
 */
export async function countInvoicesByField(
  scope: LedgerScope,
  field: "method" | "status",
): Promise<Record<string, number>> {
  // Grouped on the raw values and translated afterwards: two invoice statuses
  // can map to one word, so the counts have to be summed after translation.
  const rows = await InvoiceModel.aggregate<{
    _id: { hasPendingClaim?: boolean; value?: string };
    count: number;
  }>([
    ...ledgerPipeline(scope),
    {
      $group: {
        _id:
          field === "method"
            ? { value: "$method" }
            : { hasPendingClaim: "$hasPendingClaim", value: "$status" },
        count: { $sum: 1 },
      },
    },
  ]);

  const counts: Record<string, number> = {};

  for (const row of rows) {
    const raw = row._id?.value;
    const key =
      field === "method"
        ? ((raw ? LEGACY_METHOD_BY_PROVIDER[raw] : undefined) ?? "UNKNOWN")
        : legacyStatusFor(raw ?? "UNKNOWN", row._id?.hasPendingClaim);

    counts[key] = (counts[key] ?? 0) + row.count;
  }

  return counts;
}

export async function countInvoicesByStatus(
  scope: LedgerScope,
): Promise<Record<string, number>> {
  return countInvoicesByField(scope, "status");
}

/**
 * The most recently *created* invoices in a scope — the "recent activity" feed
 * on the admin and platform payment screens. Ordered by creation rather than by
 * due date, because the question those screens answer is "what just happened".
 */
export async function listRecentInvoices(
  scope: LedgerScope,
  limit: number,
): Promise<LedgerInvoice[]> {
  const rows = await InvoiceModel.aggregate<LedgerInvoiceRow>([
    ...ledgerPipeline(scope),
    { $sort: { createdAt: -1 } },
    { $limit: limit },
  ]);

  return rows.map(fromLedgerRow);
}

/** Invoices by id, keyed for lookup. Used to attach an invoice to a claim. */
export async function invoicesByIds(
  invoiceIds: (Types.ObjectId | string)[],
): Promise<Map<string, LedgerInvoice>> {
  if (invoiceIds.length === 0) {
    return new Map();
  }

  const rows = await InvoiceModel.aggregate<LedgerInvoiceRow>(
    ledgerPipeline({ invoiceIds }),
  );

  return new Map(rows.map((row) => [row._id.toString(), fromLedgerRow(row)]));
}

export type MonthlyLedgerPoint = {
  dueAmount: number;
  paidAmount: number;
  period: string;
  /** Distinct residents billed in the period, not invoice count. */
  residentCount: number;
};

/**
 * Billed-versus-collected per month, for the report charts.
 *
 * Returns a point for **every** requested period, zero-filled. A chart that
 * silently omits an empty month misreads as a gap in time rather than a month
 * where nothing was billed.
 */
export async function monthlySeries(
  scope: LedgerScope,
  periods: string[],
): Promise<MonthlyLedgerPoint[]> {
  const rows = await InvoiceModel.aggregate<{
    _id: string;
    dueAmount: number;
    paidAmount: number;
    residentCount: number;
  }>([
    ...ledgerPipeline({ ...scope, periods }),
    {
      $group: {
        _id: "$period",
        dueAmount: { $sum: "$totalAmount" },
        paidAmount: { $sum: "$paidAmount" },
        residents: { $addToSet: "$residentId" },
      },
    },
    {
      $project: {
        dueAmount: 1,
        paidAmount: 1,
        residentCount: { $size: "$residents" },
      },
    },
  ]);

  const byPeriod = new Map(rows.map((row) => [row._id, row]));

  return periods.map((period) => ({
    dueAmount: byPeriod.get(period)?.dueAmount ?? 0,
    paidAmount: byPeriod.get(period)?.paidAmount ?? 0,
    period,
    residentCount: byPeriod.get(period)?.residentCount ?? 0,
  }));
}

export type PeriodTotalsRow = {
  dueAmount: number;
  hostelId?: string;
  invoiceCount: number;
  paidAmount: number;
  period: string;
};

/**
 * Totals grouped by period, optionally split by hostel — what the CSV exports
 * are built from.
 *
 * Newest period first and capped by `limit`, matching the export convention
 * that a report is an aggregate rather than a row dump: a CSV of every invoice
 * would put resident names in a downloaded file for no reporting benefit.
 */
export async function periodTotals(
  scope: LedgerScope,
  options: { groupByHostel?: boolean; limit: number },
): Promise<PeriodTotalsRow[]> {
  const rows = await InvoiceModel.aggregate<{
    _id: { hostelId?: Types.ObjectId; period: string };
    dueAmount: number;
    invoiceCount: number;
    paidAmount: number;
  }>([
    ...ledgerPipeline(scope),
    {
      $group: {
        _id: options.groupByHostel
          ? { hostelId: "$hostelId", period: "$period" }
          : { period: "$period" },
        dueAmount: { $sum: "$totalAmount" },
        invoiceCount: { $sum: 1 },
        paidAmount: { $sum: "$paidAmount" },
      },
    },
    { $sort: { "_id.period": -1 } },
    { $limit: options.limit },
  ]);

  return rows.map((row) => ({
    dueAmount: row.dueAmount,
    hostelId: row._id.hostelId?.toString(),
    invoiceCount: row.invoiceCount,
    paidAmount: row.paidAmount,
    period: row._id.period,
  }));
}

/** Platform-wide totals. Only ever reached behind a platform-admin guard. */
export async function platformRollup(): Promise<LedgerTotals> {
  return collectionTotals({});
}

/**
 * The most recent invoice per resident, for the platform directory's
 * "last payment" column.
 */
export async function latestInvoicePerResident(
  residentIds: (Types.ObjectId | string)[],
): Promise<Map<string, LedgerInvoice>> {
  if (residentIds.length === 0) {
    return new Map();
  }

  const rows = await InvoiceModel.aggregate<LedgerInvoiceRow>([
    ...ledgerPipeline({ residentIds }),
    { $sort: { dueDate: -1 } },
  ]);

  const latest = new Map<string, LedgerInvoice>();

  // Sorted newest first, so the first row seen for a resident is their latest.
  for (const row of rows) {
    const invoice = fromLedgerRow(row);

    if (!latest.has(invoice.residentId)) {
      latest.set(invoice.residentId, invoice);
    }
  }

  return latest;
}
