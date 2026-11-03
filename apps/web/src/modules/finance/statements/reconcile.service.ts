import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { inTransaction } from "@/lib/transaction";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { auditFinanceAction } from "@/modules/finance/audit-finance";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import {
  findOrphanClaims,
  loadMatchContext,
} from "@/modules/finance/matching/ladder.service";
import { settleEvent } from "@/modules/finance/payment-event.service";
import type { StatementRow } from "@/modules/finance/statements/parsers/types";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { PaymentEventModel } from "@hostel/db/models/PaymentEvent";
import { ResidentModel } from "@hostel/db/models/Resident";
import { StatementImportModel } from "@hostel/db/models/StatementImport";
import { UserModel } from "@hostel/db/models/User";

/**
 * The reconciliation screen's service — three buckets (target §11.5).
 *
 * This is the screen that sells the product: forty-one residents, three
 * decisions, about ninety seconds. Everything here is shaped by that claim, and
 * the shape is **two buckets the owner touches and one they only read**:
 *
 * 1. `matched` — a real transaction, reference and amount agreeing. Already
 *    settled by the import, or one tap away because a resident's claim named
 *    exactly this transaction. Nothing to decide.
 * 2. `claimedNoTransaction` — a resident says they paid and the hostel's own
 *    statement disagrees (Tier E). Reject, approve anyway, or ask.
 * 3. `orphans` — money that arrived belonging to nobody yet (Tiers C and D),
 *    with a suggestion the owner confirms.
 *
 * **`Approve anyway` exists on purpose** (target §11.5). Statements lag; an
 * owner trapped behind incomplete data abandons the feature. What it does is
 * record *who* clicked it, which is the maker-checker trail.
 */

export type MatchedRow = {
  amount: number;
  /** Set when a resident's claim named this exact transaction — one tap. */
  claimEventId: string | null;
  /**
   * True when this credit confirmed a claim the hostel had already approved
   * (item E.5) — nothing to tap, and nothing to settle. The row is shown because
   * it is the good news: the money a warden took on trust is now in the account.
   */
  confirmsClaim: boolean;
  eventId: string;
  occurredAt: Date;
  period: string | null;
  providerTxnId: string | null;
  referenceCode: string | null;
  residentName: string;
  /** SETTLED when the import auto-settled it; PENDING when it awaits the tap. */
  status: string;
  why: string;
};

export type ClaimedNoTransactionRow = {
  amount: number;
  bedLabel: string | null;
  claimEventId: string;
  period: string | null;
  residentId: string;
  residentName: string;
  transactionCode: string | null;
  why: string;
};

export type OrphanRow = {
  amount: number;
  counterpartyName: string | null;
  eventId: string;
  occurredAt: Date;
  providerTxnId: string | null;
  remarks: string | null;
  suggestions: {
    confidence: string;
    invoiceId: string;
    residentId: string;
    residentName: string;
    why: string;
  }[];
};

/**
 * A claim a warden approved that no statement has ever carried (item E.6).
 *
 * **This is where the fraud actually surfaces, and it surfaces about a week
 * late.** Payee matching on a screenshot is best-effort — a crop, an unfamiliar
 * template or a competent forgery defeats it — so the only guarantee the product
 * can offer is that the money either appears in the hostel's own account or this
 * row appears instead. It names the approving warden as well as the resident,
 * because "approved on trust and never arrived" is a fact about two people and
 * showing only one of them is how a collusive approval stays invisible.
 */
export type ApprovedNotInStatementRow = {
  amount: number;
  approvedAt: Date | null;
  approvedByName: string | null;
  claimEventId: string;
  period: string | null;
  residentId: string;
  residentName: string;
  transactionCode: string | null;
  why: string;
};

export type ReconciliationView = {
  buckets: {
    approvedNotInStatement: ApprovedNotInStatementRow[];
    claimedNoTransaction: ClaimedNoTransactionRow[];
    matched: MatchedRow[];
    orphans: OrphanRow[];
  };
  fileName: string | null;
  matchedTotal: number;
  parserVersion: string;
  periodEnd: Date | null;
  periodStart: Date | null;
  provider: string;
  rowCount: number;
  statementImportId: string;
  status: string;
  uploadedAt: Date;
};

type StatementEvent = {
  _id: Types.ObjectId;
  amount: number;
  confirmation: string;
  occurredAt: Date;
  providerTxnId?: string | null;
  rawPayload?: {
    claimEventId?: string;
    confirmsClaimEventId?: string;
    counterpartyName?: string | null;
    ladderTier?: string;
    ladderWhy?: string;
    remarks?: string | null;
    suggestions?: OrphanRow["suggestions"];
  };
  referenceCode?: string | null;
  residentId?: Types.ObjectId | null;
  invoiceId?: Types.ObjectId | null;
  status: string;
};

export async function listStatementImports(
  hostelId: Types.ObjectId | string,
  limit = 20,
) {
  await connectToDatabase();

  const imports = await StatementImportModel.find({ hostelId })
    .sort({ uploadedAt: -1 })
    .limit(limit)
    .lean<
      {
        _id: Types.ObjectId;
        errorDetail?: string;
        fileName?: string;
        matchedCount?: number;
        orphanCount?: number;
        provider: string;
        rowCount?: number;
        status: string;
        suggestedCount?: number;
        uploadedAt: Date;
      }[]
    >();

  return imports.map((row) => ({
    errorDetail: row.errorDetail ?? null,
    fileName: row.fileName ?? null,
    matchedCount: row.matchedCount ?? 0,
    orphanCount: row.orphanCount ?? 0,
    provider: row.provider,
    rowCount: row.rowCount ?? 0,
    statementImportId: row._id.toString(),
    status: row.status,
    suggestedCount: row.suggestedCount ?? 0,
    uploadedAt: row.uploadedAt,
  }));
}

/**
 * The three buckets of one import.
 *
 * Tier E is recomputed here rather than stored at import time, deliberately: a
 * claim submitted *after* the file was read is not evidence of anything, and a
 * frozen list would keep accusing a resident whose payment has since been
 * verified by other means.
 */
export async function getReconciliation(
  statementImportId: string,
  hostelIds: string[],
): Promise<ReconciliationView> {
  await connectToDatabase();

  const record = await StatementImportModel.findOne({
    _id: Types.ObjectId.isValid(statementImportId)
      ? statementImportId
      : new Types.ObjectId(),
    hostelId: { $in: hostelIds },
  }).lean<{
    _id: Types.ObjectId;
    fileName?: string;
    hostelId: Types.ObjectId;
    parserVersion: string;
    periodEnd?: Date;
    periodStart?: Date;
    provider: string;
    rowCount?: number;
    status: string;
    uploadedAt: Date;
  } | null>();

  if (!record) {
    // Out-of-scope and non-existent answer identically (RULES.md §3).
    throw new FinanceServiceError(
      "That statement import was not found.",
      "STATEMENT_NOT_FOUND",
    );
  }

  if (record.status !== "READY") {
    throw new FinanceServiceError(
      record.status === "FAILED"
        ? "That statement could not be read, so it has nothing to reconcile."
        : "That statement is still being read.",
      "STATEMENT_NOT_READY",
    );
  }

  const events = await PaymentEventModel.find({
    statementImportId: record._id,
  })
    .sort({ occurredAt: 1 })
    .lean<StatementEvent[]>();

  const residentNames = await namesFor(
    events.map((event) => event.residentId).filter(Boolean) as Types.ObjectId[],
  );
  const periods = await periodsFor(
    events.map((event) => event.invoiceId).filter(Boolean) as Types.ObjectId[],
  );

  const matched: MatchedRow[] = [];
  const orphans: OrphanRow[] = [];

  // Read once for the whole view, so a row whose claim was approved *after* this
  // file was imported renders as already-recorded rather than as one tap away
  // from crediting the same transfer twice. `confirmsClaimEventId` alone cannot
  // know this: it is written at import time.
  const settledClaimIds = await settledClaimsAmong(
    events
      .map((event) => event.rawPayload?.claimEventId)
      .filter((id): id is string => Boolean(id)),
  );

  for (const event of events) {
    const tier = event.rawPayload?.ladderTier;
    const claimEventId = event.rawPayload?.claimEventId ?? null;

    if (tier === "B" || claimEventId) {
      matched.push({
        amount: event.amount,
        claimEventId,
        confirmsClaim:
          Boolean(event.rawPayload?.confirmsClaimEventId) ||
          (claimEventId !== null && settledClaimIds.has(claimEventId)),
        eventId: event._id.toString(),
        occurredAt: event.occurredAt,
        period: event.invoiceId
          ? (periods.get(event.invoiceId.toString()) ?? null)
          : null,
        providerTxnId: event.providerTxnId ?? null,
        referenceCode: event.referenceCode ?? null,
        residentName: event.residentId
          ? (residentNames.get(event.residentId.toString())?.name ?? "")
          : "",
        status: event.status,
        why: event.rawPayload?.ladderWhy ?? "",
      });

      continue;
    }

    // Everything else is money without an owner: Tier C suggestions and Tier D
    // alike. The mockup's third box is one list with a suggestion attached, not
    // two lists the owner has to learn the difference between.
    if (event.status === "PENDING") {
      orphans.push({
        amount: event.amount,
        counterpartyName: event.rawPayload?.counterpartyName ?? null,
        eventId: event._id.toString(),
        occurredAt: event.occurredAt,
        providerTxnId: event.providerTxnId ?? null,
        remarks: event.rawPayload?.remarks ?? null,
        suggestions: event.rawPayload?.suggestions ?? [],
      });
    }
  }

  const context = await loadMatchContext(record.hostelId);
  const rows: StatementRow[] = events.map((event) => ({
    amount: event.amount,
    counterpartyName: event.rawPayload?.counterpartyName ?? null,
    direction: "CREDIT",
    occurredAt: event.occurredAt,
    providerTxnId: event.providerTxnId ?? "",
    raw: {},
    remarks: event.rawPayload?.remarks ?? null,
    rowNumber: 0,
  }));

  const unmatchedClaims = findOrphanClaims(context, rows, record.periodEnd ?? null);

  // Split by whether anyone has already acted, because the two are different
  // decisions (item E.6). An unapproved claim with no credit behind it is a
  // question for the resident; an *approved* one is a question about money the
  // hostel has already told them it received.
  const claimedNoTransaction = unmatchedClaims
    .filter((orphan) => !orphan.claim.settled)
    .map((orphan) => ({
      amount: orphan.claim.amount,
      bedLabel:
        context.openInvoices.find(
          (invoice) => invoice.residentId === orphan.claim.residentId,
        )?.bedLabel ?? null,
      claimEventId: orphan.claim.eventId,
      period: orphan.claim.period,
      residentId: orphan.claim.residentId,
      residentName: orphan.claim.residentName,
      transactionCode: orphan.claim.transactionCode,
      why: orphan.why,
    }));

  const approvedClaims = unmatchedClaims.filter((orphan) => orphan.claim.settled);
  const approvers = await approverNamesFor(
    approvedClaims.map((orphan) => orphan.claim.eventId),
  );

  const approvedNotInStatement = approvedClaims.map((orphan) => ({
    amount: orphan.claim.amount,
    approvedAt: approvers.get(orphan.claim.eventId)?.reviewedAt ?? null,
    approvedByName: approvers.get(orphan.claim.eventId)?.name ?? null,
    claimEventId: orphan.claim.eventId,
    period: orphan.claim.period,
    residentId: orphan.claim.residentId,
    residentName: orphan.claim.residentName,
    transactionCode: orphan.claim.transactionCode,
    why: orphan.why,
  }));

  return {
    buckets: { approvedNotInStatement, claimedNoTransaction, matched, orphans },
    fileName: record.fileName ?? null,
    matchedTotal: matched.reduce((total, row) => total + row.amount, 0),
    parserVersion: record.parserVersion,
    periodEnd: record.periodEnd ?? null,
    periodStart: record.periodStart ?? null,
    provider: record.provider,
    rowCount: record.rowCount ?? 0,
    statementImportId: record._id.toString(),
    status: record.status,
    uploadedAt: record.uploadedAt,
  };
}

/**
 * Assigns orphan money to an invoice (target §7 Tier D).
 *
 * Settles with `MANUAL_REVIEW`, never `STATEMENT_MATCH`: the confirmation field
 * records *how strongly* this is believed, and a human picking a name off a list
 * is a different kind of certainty from a reference code that verified. The
 * audit entry names who picked.
 */
export async function assignOrphanCredit(
  eventId: string,
  input: { invoiceId: string; principal: ApiPrincipal },
): Promise<{ eventId: string; settledAmount: number }> {
  await connectToDatabase();

  const event = await PaymentEventModel.findOne({
    _id: Types.ObjectId.isValid(eventId) ? eventId : new Types.ObjectId(),
    hostelId: { $in: input.principal.hostelIds },
    source: "STATEMENT_IMPORT",
  }).lean<StatementEvent & { hostelId: Types.ObjectId } | null>();

  if (!event) {
    throw new FinanceServiceError("That payment was not found.", "EVENT_NOT_FOUND");
  }

  if (event.status !== "PENDING") {
    throw new FinanceServiceError(
      "That payment has already been assigned.",
      "EVENT_ALREADY_ASSIGNED",
    );
  }

  const invoice = await InvoiceModel.findOne({
    _id: Types.ObjectId.isValid(input.invoiceId)
      ? input.invoiceId
      : new Types.ObjectId(),
    hostelId: event.hostelId,
  }).lean<{ _id: Types.ObjectId; residentId: Types.ObjectId } | null>();

  if (!invoice) {
    throw new FinanceServiceError("That invoice was not found.", "INVOICE_NOT_FOUND");
  }

  // Written before settlement: `settleEvent` recomputes the balance of whatever
  // invoice the event points at, so pointing it first is what makes the
  // recomputation land on the right one. One transaction, so a failed settle no
  // longer leaves the event assigned but PENDING (FIN-13).
  const { balance } = await inTransaction(async () => {
    await PaymentEventModel.updateOne(
      { _id: event._id, status: "PENDING" },
      { $set: { invoiceId: invoice._id, residentId: invoice.residentId } },
    );

    return settleEvent(event._id, {
      confirmation: "MANUAL_REVIEW",
      principal: input.principal,
    });
  });

  await publishResourceChange({
    hostelIds: [event.hostelId.toString()],
    topics: [REALTIME_TOPIC.PAYMENTS],
  });

  return {
    eventId: event._id.toString(),
    settledAmount: balance?.settledAmount ?? event.amount,
  };
}

/**
 * Settles every matched row of an import that is still pending.
 *
 * "Matched" here means the import found a real transaction *and* a resident
 * claim naming it — the row the owner would approve one at a time without
 * reading, forty times. Tier B rows are already settled and are skipped rather
 * than re-settled.
 */
export async function approveMatchedRows(
  statementImportId: string,
  principal: ApiPrincipal,
): Promise<{ approved: number; skipped: number }> {
  await connectToDatabase();

  const view = await getReconciliation(statementImportId, principal.hostelIds);
  // A confirming row is deliberately left pending forever and must never be
  // swept (item E.5): the claim it confirms already holds this money, so
  // settling it here would credit the same transfer to the same invoice twice.
  const pending = view.buckets.matched.filter(
    (row) => row.status === "PENDING" && !row.confirmsClaim,
  );

  /**
   * The mirror of `assertNotAlreadyRecordedFromStatement`, and the half that
   * catches the *other* order.
   *
   * `confirmsClaim` is decided at import time, so it only knows about claims that
   * were already approved when the file was read. A warden who approves the claim
   * an hour *after* the upload leaves a row that still looks tappable — and
   * tapping it credits the same transfer a second time. So the claim's status is
   * read again here, at the write, rather than trusted from the import.
   */
  const settledClaimIds = await settledClaimsAmong(
    pending.map((row) => row.claimEventId).filter((id): id is string => Boolean(id)),
  );

  let approved = 0;
  let skipped = 0;

  for (const row of pending) {
    if (row.claimEventId && settledClaimIds.has(row.claimEventId)) {
      skipped += 1;
      continue;
    }

    try {
      await settleEvent(row.eventId, {
        confirmation: "STATEMENT_MATCH",
        principal,
      });
      approved += 1;
    } catch {
      // Somebody settled it between the read and the write. A losing writer in a
      // bulk sweep is not an error worth failing the other thirty-seven rows for.
      skipped += 1;
    }
  }

  return { approved, skipped };
}

/**
 * "Ask resident" (target §11.5).
 *
 * A templated in-app message rather than a free-text box: the owner is being
 * asked to chase a discrepancy, not to compose an accusation, and a fixed
 * sentence is one they can send in a second without deciding how to word it.
 * The claim stays PENDING — asking is not a decision.
 */
export async function askResidentAboutClaim(
  claimEventId: string,
  principal: ApiPrincipal,
): Promise<{ notified: boolean }> {
  await connectToDatabase();

  const claim = await PaymentEventModel.findOne({
    _id: Types.ObjectId.isValid(claimEventId) ? claimEventId : new Types.ObjectId(),
    hostelId: { $in: principal.hostelIds },
    source: "RESIDENT_CLAIM",
  }).lean<
    | (StatementEvent & {
        hostelId: Types.ObjectId;
        rawPayload?: { transactionCode?: string | null };
      })
    | null
  >();

  if (!claim) {
    throw new FinanceServiceError("Payment claim was not found.", "CLAIM_NOT_FOUND");
  }

  const resident = claim.residentId
    ? await ResidentModel.findOne({ _id: claim.residentId, isDeleted: false })
        .select("userId")
        .lean<{ userId?: Types.ObjectId } | null>()
    : null;

  if (!resident?.userId) {
    return { notified: false };
  }

  await createInAppNotification({
    body: `We could not find your payment of NPR ${claim.amount.toLocaleString(
      "en-IN",
    )} in our account statement. Please check the transaction ID and send a clearer screenshot.`,
    category: "PAYMENT",
    hostelId: claim.hostelId.toString(),
    title: "Please confirm your payment details",
    userId: resident.userId.toString(),
  });

  await auditFinanceAction(principal, {
    action: "PAYMENT_CLAIM_QUERIED",
    // Asking changes no balance; both sides are the claim's own amount so the
    // envelope still records what was being discussed.
    amountAfter: claim.amount,
    amountBefore: claim.amount,
    entityId: claim._id,
    entityType: "PaymentEvent",
    eventId: claim._id.toString(),
    hostelId: claim.hostelId,
    source: "STATEMENT_RECONCILE",
  });

  return { notified: true };
}

/**
 * Who approved each of these claims, and when (item E.6).
 *
 * Two queries and only for the rows that need it — the bucket is normally empty,
 * and paying for a join on every reconciliation view to fill a list nobody sees
 * is the wrong trade.
 */
/**
 * Which of these claims a human has already settled.
 *
 * `SETTLED` alone, not `status: { $ne: "PENDING" }`: a rejected claim moved no
 * money, so the statement row that carries it is still the credit and must stay
 * tappable — the reviewer turned down the resident's *evidence*, not the transfer.
 */
async function settledClaimsAmong(claimEventIds: string[]): Promise<Set<string>> {
  if (claimEventIds.length === 0) {
    return new Set();
  }

  const settled = await PaymentEventModel.find({
    _id: { $in: claimEventIds },
    status: "SETTLED",
  })
    .select("_id")
    .lean<{ _id: Types.ObjectId }[]>();

  return new Set(settled.map((event) => event._id.toString()));
}

async function approverNamesFor(eventIds: string[]) {
  const empty = new Map<string, { name: string | null; reviewedAt: Date | null }>();

  if (eventIds.length === 0) {
    return empty;
  }

  const events = await PaymentEventModel.find({ _id: { $in: eventIds } })
    .select("reviewedAt reviewedBy")
    .lean<
      { _id: Types.ObjectId; reviewedAt?: Date; reviewedBy?: Types.ObjectId }[]
    >();

  const users = await UserModel.find({
    _id: { $in: events.map((event) => event.reviewedBy).filter(Boolean) },
  })
    .select("name")
    .lean<{ _id: Types.ObjectId; name?: string }[]>();

  const nameById = new Map(
    users.map((user) => [user._id.toString(), user.name ?? null]),
  );

  return new Map(
    events.map((event) => [
      event._id.toString(),
      {
        name: event.reviewedBy
          ? (nameById.get(event.reviewedBy.toString()) ?? null)
          : null,
        reviewedAt: event.reviewedAt ?? null,
      },
    ]),
  );
}

async function namesFor(ids: Types.ObjectId[]) {
  if (ids.length === 0) {
    return new Map<string, { name: string }>();
  }

  const residents = await ResidentModel.find({ _id: { $in: ids } })
    .select("firstName lastName")
    .lean<{ _id: Types.ObjectId; firstName?: string; lastName?: string }[]>();

  return new Map(
    residents.map((resident) => [
      resident._id.toString(),
      { name: [resident.firstName, resident.lastName].filter(Boolean).join(" ") },
    ]),
  );
}

async function periodsFor(ids: Types.ObjectId[]) {
  if (ids.length === 0) {
    return new Map<string, string | null>();
  }

  const invoices = await InvoiceModel.find({ _id: { $in: ids } })
    .select("period")
    .lean<{ _id: Types.ObjectId; period?: string | null }[]>();

  return new Map(
    invoices.map((invoice) => [invoice._id.toString(), invoice.period ?? null]),
  );
}
