import { GetObjectCommand } from "@aws-sdk/client-s3";
import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { getR2Client } from "@/lib/r2";
import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { auditFinanceAction } from "@/modules/finance/audit-finance";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import {
  type CreditClassification,
  type MatchContext,
  classifyCredit,
  loadMatchContext,
} from "@/modules/finance/matching/ladder.service";
import {
  appendEvent,
  confirmSettlementByStatement,
  settleEvent,
} from "@/modules/finance/payment-event.service";
import { withRun } from "@/modules/finance/reconciliation/run-recorder";
import { resolveParser } from "@/modules/finance/statements/parsers/registry";
import {
  type StatementBytes,
  readStatementTable,
} from "@/modules/finance/statements/parsers/source";
import {
  type StatementProvider,
  type StatementRow,
  StatementParseError,
} from "@/modules/finance/statements/parsers/types";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { HostelPaymentProfileModel } from "@hostel/db/models/HostelPaymentProfile";
import { PaymentEventModel } from "@hostel/db/models/PaymentEvent";
import { StatementImportModel } from "@hostel/db/models/StatementImport";

/**
 * Statement import — the Tier 0.5 pipeline (target §6.4).
 *
 * The owner exports their own eSewa/Khalti/bank statement and uploads it. This
 * reads it, runs every credit through the matching ladder, and leaves behind the
 * three buckets the reconcile screen renders. It is the only place in the
 * product where an **independent** record of the money exists — everything at
 * Tier 0 is the resident's word plus a screenshot — which is why a fabricated
 * transaction id is caught here and nowhere earlier (target §8).
 *
 * Two properties this service must not lose:
 *
 * **Re-uploading an overlapping range creates zero duplicate events.** Owners
 * export "last 30 days" every week; overlap is the normal case, not an edge one.
 * The guarantee is structural, not a check: `{hostelId, provider, providerTxnId}`
 * is a unique index, so a row we already hold cannot be written twice even if
 * every check here were deleted. The pre-pass below only turns that collision
 * into a *counted duplicate* instead of a raised error.
 *
 * **A file that cannot be fully read imports nothing.** The parse happens before
 * any event is written, so a statement that fails at row 60 of 84 leaves a
 * `FAILED` import row and no half-ingested money.
 */

export type StatementImportSummary = {
  creditCount: number;
  duplicateCount: number;
  fileName: string | null;
  matchedCount: number;
  orphanCount: number;
  parserVersion: string;
  periodEnd: Date | null;
  periodStart: Date | null;
  provider: StatementProvider;
  rowCount: number;
  runId: string;
  statementImportId: string;
  status: "FAILED" | "READY";
  suggestedCount: number;
};

/** 10 MB matches the platform's document limit; a CSV this size is ~100k rows. */
const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;

export async function importStatement(input: {
  assetId: string;
  hostelId: Types.ObjectId | string;
  principal: ApiPrincipal;
  provider: StatementProvider;
}): Promise<StatementImportSummary> {
  await connectToDatabase();

  const asset = await loadStatementAsset(input.assetId, input.hostelId);

  // The import row is created *before* parsing so a file that cannot be read
  // leaves a record saying so. An owner who uploads a broken export and sees
  // nothing at all will assume the upload failed and try again forever.
  const statementImport = await StatementImportModel.create({
    fileName: asset.fileName ?? null,
    hostelId: input.hostelId,
    parserVersion: "unknown",
    provider: input.provider,
    sourceAssetId: asset._id,
    status: "PARSING",
    uploadedAt: new Date(),
    uploadedBy: input.principal.userId,
  });

  let rows: StatementRow[];
  let parserVersion: string;

  try {
    const source = await readStatementBytes(asset);
    const parser = resolveParser(input.provider, source);

    parserVersion = parser.version;
    rows = parser.parseTable(readStatementTable(source, parser.headerAnchors));
  } catch (error) {
    const detail =
      error instanceof StatementParseError || error instanceof FinanceServiceError
        ? error.message
        : "This file could not be read.";

    await StatementImportModel.updateOne(
      { _id: statementImport._id },
      { $set: { completedAt: new Date(), errorDetail: detail, status: "FAILED" } },
    );

    throw error;
  }

  await StatementImportModel.updateOne(
    { _id: statementImport._id },
    { $set: { parserVersion } },
  );

  const credits = rows.filter((row) => row.direction === "CREDIT");
  const { periodEnd, periodStart } = periodOf(rows);

  const { result, runId } = await withRun(
    {
      hostelId: input.hostelId,
      kind: "STATEMENT_MATCH",
      triggeredBy: input.principal.userId,
    },
    async (recorder) => {
      recorder.count("scanned", rows.length);
      recorder.count("credits", credits.length);

      const known = await knownTransactionIds(
        input.hostelId,
        input.provider,
        credits.map((row) => row.providerTxnId),
      );
      const fresh = credits.filter((row) => !known.has(row.providerTxnId));

      recorder.count("duplicates", credits.length - fresh.length);

      const context = await loadMatchContext(input.hostelId);
      const counts = { matched: 0, orphan: 0, suggested: 0 };

      for (const row of fresh) {
        const classification = classifyCredit(row, context);

        // One bad row is a finding, not the end of the file: an event already written
        // stays PENDING for "Approve all" to finish (FIN-11).
        try {
          await ingest({
            classification,
            context,
            hostelId: input.hostelId,
            principal: input.principal,
            provider: input.provider,
            row,
            statementImportId: statementImport._id,
          });
        } catch (error) {
          recorder.count("failed");
          recorder.finding({
            code: "ROW_FAILED",
            detail: `row ${row.rowNumber} (${row.providerTxnId}): ${
              error instanceof Error ? error.message : "failed"
            }`,
            severity: "ERROR",
          });
          continue;
        }

        if (classification.tier === "B") {
          counts.matched += 1;
          recorder.count("matched");
        } else if (classification.tier === "C") {
          counts.suggested += 1;
          recorder.count("suggested");
        } else {
          counts.orphan += 1;
          recorder.count("orphan");
          recorder.finding({
            code: "UNMATCHED_CREDIT",
            detail: `${row.amount} on ${row.occurredAt.toISOString().slice(0, 10)}: ${classification.why}`,
            severity: "WARN",
          });
        }
      }

      return { counts, duplicateCount: credits.length - fresh.length };
    },
  );

  await StatementImportModel.updateOne(
    { _id: statementImport._id },
    {
      $set: {
        completedAt: new Date(),
        creditCount: credits.length,
        duplicateCount: result.duplicateCount,
        matchedCount: result.counts.matched,
        orphanCount: result.counts.orphan,
        periodEnd,
        periodStart,
        rowCount: rows.length,
        status: "READY",
        suggestedCount: result.counts.suggested,
      },
    },
  );

  // Drives the nudge banner (4.5). Written on success only: a failed parse is
  // not a statement the hostel has actually reconciled.
  await HostelPaymentProfileModel.updateOne(
    { hostelId: input.hostelId },
    { $set: { lastStatementUploadAt: new Date() } },
    { upsert: true },
  );

  await auditFinanceAction(input.principal, {
    action: "STATEMENT_IMPORTED",
    // No balance changed by the import itself; each auto-settled event audits
    // its own before/after through `settleEvent`.
    amountAfter: 0,
    amountBefore: 0,
    entityId: statementImport._id,
    entityType: "StatementImport",
    hostelId: input.hostelId,
    source: "STATEMENT_IMPORT",
  });

  await publishResourceChange({
    hostelIds: [input.hostelId.toString()],
    topics: [REALTIME_TOPIC.PAYMENTS],
  });

  return {
    creditCount: credits.length,
    duplicateCount: result.duplicateCount,
    fileName: asset.fileName ?? null,
    matchedCount: result.counts.matched,
    orphanCount: result.counts.orphan,
    parserVersion,
    periodEnd,
    periodStart,
    provider: input.provider,
    rowCount: rows.length,
    runId,
    statementImportId: statementImport._id.toString(),
    status: "READY",
    suggestedCount: result.counts.suggested,
  };
}

/**
 * Writes one classified credit to the ledger.
 *
 * Tier B settles; C and D are appended `PENDING` and wait for a person. The
 * `rawPayload` carries the statement row verbatim plus the ladder's reasoning,
 * so the reconcile screen can show *why* without re-running the ladder — and so
 * a suggestion an owner accepted six months ago can still be explained.
 */
async function ingest(input: {
  classification: CreditClassification;
  context: MatchContext;
  hostelId: Types.ObjectId | string;
  principal: ApiPrincipal;
  provider: StatementProvider;
  row: StatementRow;
  statementImportId: Types.ObjectId;
}): Promise<void> {
  const { classification, row } = input;
  const matched = classification.tier === "B" ? classification.invoice : null;
  const claim = classification.tier === "C" ? classification.claim : undefined;

  const { created, event } = await appendEvent({
    amount: row.amount,
    confirmation: "UNCONFIRMED",
    hostelId: input.hostelId,
    // §5.2. The import id makes the key unique per upload; cross-upload
    // deduplication is the `providerTxnId` index's job, not this string's.
    idempotencyKey: `statement:${input.statementImportId.toString()}:${input.provider}:${row.providerTxnId}`,
    invoiceId: matched?.invoiceId ?? claim?.invoiceId ?? null,
    occurredAt: row.occurredAt,
    provider: input.provider,
    providerTxnId: row.providerTxnId,
    rawPayload: {
      counterpartyName: row.counterpartyName,
      ladderTier: classification.tier,
      ladderWhy: classification.why,
      remarks: row.remarks,
      row: row.raw,
      rowNumber: row.rowNumber,
      suggestions:
        classification.tier === "C"
          ? (classification.suggestions ?? []).map((suggestion) => ({
              confidence: suggestion.confidence,
              invoiceId: suggestion.candidate.invoiceId,
              residentId: suggestion.candidate.residentId,
              residentName: suggestion.candidate.residentName,
              score: suggestion.score,
              why: suggestion.why,
            }))
          : [],
      ...(claim ? { claimEventId: claim.eventId } : {}),
      // The claim was already approved and already counted, so this row is
      // *evidence about it*, not a second credit (item E.5). Recorded on the
      // event so the reconcile screen can say so without re-running the ladder.
      ...(claim?.settled ? { confirmsClaimEventId: claim.eventId } : {}),
    },
    referenceCode: matched?.referenceCode ?? null,
    residentId: matched?.residentId ?? claim?.residentId ?? null,
    source: "STATEMENT_IMPORT",
    statementImportId: input.statementImportId,
    status: "PENDING",
  });

  if (!created) {
    return;
  }

  /**
   * The credit that proves a provisionally-settled claim (item E.5).
   *
   * **This row must never settle.** The claim already moved the money when the
   * warden approved it; settling the statement event too would credit the same
   * rent twice, against the same invoice, from the same transaction — and it
   * would look entirely correct on the reconcile screen, because both rows are
   * real. The statement's job here is confirmation, and confirmation is a
   * promotion on the event that already holds the money.
   */
  if (claim?.settled) {
    await confirmSettlementByStatement(claim.eventId, {
      confirmedAt: row.occurredAt,
      principal: input.principal,
      statementImportId: input.statementImportId,
    });

    return;
  }

  if (!matched) {
    return;
  }

  // Tier B only. `STATEMENT_MATCH` rather than `GATEWAY_VERIFIED`: the screen
  // must be able to say this was reference-matched, not confirmed by a provider
  // API, because those are different amounts of certainty (P4).
  await settleEvent(event._id, {
    confirmation: "STATEMENT_MATCH",
    principal: input.principal,
    settledAt: row.occurredAt,
  });
}

/**
 * Transaction ids this hostel has already ingested for this provider.
 *
 * One query for the whole file rather than a duplicate-key error per row: a
 * weekly export of a 30-day window is mostly rows we already hold, and letting
 * every one of them throw and be caught would make the normal case the slow
 * path.
 */
async function knownTransactionIds(
  hostelId: Types.ObjectId | string,
  provider: StatementProvider,
  txnIds: string[],
): Promise<Set<string>> {
  if (txnIds.length === 0) {
    return new Set();
  }

  const existing = await PaymentEventModel.find({
    hostelId,
    provider,
    providerTxnId: { $in: txnIds },
  })
    .select("providerTxnId")
    .lean<{ providerTxnId?: string | null }[]>();

  return new Set(
    existing
      .map((event) => event.providerTxnId)
      .filter((id): id is string => Boolean(id)),
  );
}

function periodOf(rows: StatementRow[]): {
  periodEnd: Date | null;
  periodStart: Date | null;
} {
  if (rows.length === 0) {
    return { periodEnd: null, periodStart: null };
  }

  const times = rows.map((row) => row.occurredAt.getTime());

  return {
    periodEnd: new Date(Math.max(...times)),
    periodStart: new Date(Math.min(...times)),
  };
}

type StatementAsset = {
  _id: Types.ObjectId;
  bucket: string;
  fileName?: string;
  key: string;
  sizeBytes?: number;
};

/**
 * The uploaded file, checked the way payment evidence is (target §13.2/§13.3).
 *
 * Hostel-scoped and upload-verified: without the first, an owner could paste
 * another hostel's asset id and reconcile against a statement that is not
 * theirs; without the second, the row is a presign reservation and the bytes may
 * not exist.
 */
async function loadStatementAsset(
  assetId: string,
  hostelId: Types.ObjectId | string,
): Promise<StatementAsset> {
  const asset = Types.ObjectId.isValid(assetId)
    ? await FileAssetModel.findOne({
        _id: assetId,
        isDeleted: false,
        status: "ACTIVE",
      }).lean<
        | (StatementAsset & { hostelId?: Types.ObjectId; uploadCompletedAt?: Date })
        | null
      >()
    : null;

  if (!asset || asset.hostelId?.toString() !== hostelId.toString()) {
    throw new FinanceServiceError(
      "That file does not belong to this hostel. Upload the statement again.",
      "ASSET_NOT_OWNED",
    );
  }

  if (!asset.uploadCompletedAt) {
    throw new FinanceServiceError(
      "That file did not finish uploading. Please upload the statement again.",
      "ASSET_UPLOAD_INCOMPLETE",
    );
  }

  if ((asset.sizeBytes ?? 0) > MAX_STATEMENT_BYTES) {
    throw new FinanceServiceError(
      "That statement is too large to read. Export a shorter date range.",
      "AMOUNT_OUT_OF_BOUNDS",
    );
  }

  return asset;
}

/**
 * The stored object as raw bytes.
 *
 * Deliberately **not** decoded to text here: a `.xls` is a binary compound file
 * and a `.xlsx` is a zip, so decoding before the format is known would corrupt
 * both beyond recovery. The format is decided from magic bytes downstream.
 */
async function readStatementBytes(asset: StatementAsset): Promise<StatementBytes> {
  const object = await getR2Client().send(
    new GetObjectCommand({ Bucket: asset.bucket, Key: asset.key }),
  );
  const bytes = await object.Body?.transformToByteArray();

  if (!bytes) {
    throw new StatementParseError("The uploaded statement could not be read back.");
  }

  return { bytes: Buffer.from(bytes), fileName: asset.fileName ?? null };
}
