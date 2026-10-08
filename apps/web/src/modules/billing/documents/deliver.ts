import "server-only";

import { Types } from "mongoose";

import { SubscriptionInvoiceModel } from "@hostel/db/models/SubscriptionInvoice";
import { SubscriptionPaymentModel } from "@hostel/db/models/SubscriptionPayment";
import { SoftmatoDocumentModel } from "@hostel/db/models/SoftmatoDocument";

import { connectToDatabase } from "@/lib/db";
import { isSoftmatoConfigured } from "@/modules/billing/softmato/config";
import { isSoftmatoDown } from "@/modules/billing/softmato/client";
import { SoftmatoUnavailableError } from "@/modules/billing/softmato/outage";
import {
  documentFilename as softmatoFilename,
  downloadInvoiceFile,
  downloadReceiptFile,
  isPdf,
} from "@/modules/billing/softmato/documents";

import {
  documentFileName,
  ensureLocalReceiptNumber,
  renderInvoiceForRow,
  renderReceiptForRow,
} from "./issue";

/**
 * One call for "give me this document", whoever issued it.
 *
 * Every reader of a plan invoice or receipt — the owner's billing screen, the
 * superadmin's ledger, the email that carries the PDF — comes through here, so
 * that the question of *who printed this* is answered in one place instead of
 * at each call site. A screen that had to ask whether Softmato was up before it
 * could offer a download would be a screen that stops working when they go
 * down, which is the exact situation this exists for.
 *
 * ## Theirs first, ours as the answer rather than the apology
 *
 * When Softmato raised the invoice, their PDF is the document: it is in their
 * ledger, under their PAN, and it is the one the payment was actually recorded
 * against. When they did not — unconfigured, unreachable, or the raise failed
 * and the retry has not landed — we print it, and it is a real document rather
 * than a placeholder. The reader is never shown an error for a document that
 * exists; they are shown the document.
 *
 * The fallback is also taken when their API *is* configured and simply fails to
 * answer. A download is a read: retrying it later costs nothing and duplicates
 * nothing, so there is no reason to fail a reader over a timeout when the same
 * page can be produced from rows we already hold.
 *
 * ## Tenancy is enforced here, not by them
 *
 * Every hostel on this platform shares one Softmato credential, so to their API
 * one hostel asking for another's receipt is the same application asking for
 * its own. `hostelIds` is the only check there is. Passing `null` means the
 * caller is the platform, which is entitled to any of them — and that is
 * spelled as an explicit `null` rather than an omitted argument so nobody
 * reaches it by forgetting to pass a scope.
 */

export type ResolvedDocument = {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
  /** Which side printed the bytes. Worth logging; never shown to a reader. */
  issuedBy: "softmato" | "platform";
};

/** `null` scope = the platform, entitled to every hostel's paperwork. */
export type HostelScope = string[] | null;

function scopeFilter(scope: HostelScope): Record<string, unknown> {
  if (scope === null) return {};

  return {
    hostelId: { $in: scope.map((id) => new Types.ObjectId(id)) },
  };
}

/**
 * Their bytes, or nothing, and never an exception.
 *
 * A download that throws would take a reader's billing screen down because a
 * third party was slow. The failure is logged loudly enough to be found — a
 * deployment silently serving its own documents for every customer is worth
 * knowing about — and then the caller falls through to rendering ours.
 */
/**
 * Softmato's own file: from the local copy, or fetched and copied. A Softmato
 * that cannot be reached is said so (503), never papered over with a redraw.
 *
 * One exception: their deployment answers HTML when its PDF engine fails
 * (`pdfFallbackReason`). Every reader asked for a PDF — the phone refuses to
 * save anything else — so `redraw` prints the same document, under the same
 * number, with our renderer. Not cached: the next download asks them again.
 */
export async function softmatoDocument(
  kind: "invoice" | "receipt",
  number: string,
  version: string,
  read: () => Promise<Awaited<ReturnType<typeof downloadInvoiceFile>>>,
  redraw: () => Promise<Uint8Array>,
): Promise<ResolvedDocument | null> {
  const cached = await SoftmatoDocumentModel.findOne({ kind, number, version })
    .lean<{ bytes: Buffer; contentType: string } | null>();

  if (cached) {
    return {
      bytes: new Uint8Array(cached.bytes),
      contentType: cached.contentType,
      filename: softmatoFilename(number, { contentType: cached.contentType, pdfFallbackReason: null }),
      issuedBy: "softmato",
    };
  }

  if (!isSoftmatoConfigured()) throw new SoftmatoUnavailableError();

  const file = await read().catch((error: unknown) => {
    if (isSoftmatoDown(error)) throw new SoftmatoUnavailableError();
    throw error;
  });

  if (!file) return null;

  if (!isPdf(file)) {
    console.error(
      JSON.stringify({
        action: "softmato_document_not_pdf",
        kind,
        level: "error",
        number,
        reason: file.pdfFallbackReason,
      }),
    );

    return {
      bytes: await redraw(),
      contentType: "application/pdf",
      filename: documentFileName(number),
      issuedBy: "platform",
    };
  }

  // Only a real PDF is kept.
  await SoftmatoDocumentModel.updateOne(
    { kind, number, version },
    { $setOnInsert: { bytes: Buffer.from(file.bytes), contentType: file.contentType } },
    { upsert: true },
  ).catch(() => undefined);

  return {
    bytes: new Uint8Array(file.bytes),
    contentType: file.contentType,
    filename: softmatoFilename(number, file),
    issuedBy: "softmato",
  };
}

/* ── Invoice ───────────────────────────────────────────────────────────── */

/**
 * `invoiceNumber` is **ours** — `SUB-0001-4F2A`.
 *
 * The URL carries our number rather than the one printed on the page, because
 * ours exists from the moment the obligation does and the printed one may not
 * exist yet. A link built from the printed number would 404 for exactly the
 * invoices this fallback is for.
 */
export async function resolveInvoiceDocument(
  invoiceNumber: string,
  scope: HostelScope,
): Promise<ResolvedDocument | null> {
  await connectToDatabase();

  const invoice = await SubscriptionInvoiceModel.findOne({
    ...scopeFilter(scope),
    invoiceNumber,
  }).lean<Parameters<typeof renderInvoiceForRow>[0] | null>();

  if (!invoice) return null;

  const drawOurs = async (documentNumber: string) =>
    renderInvoiceForRow(
      { ...invoice, localInvoiceNo: documentNumber },
      { amountPaid: await settledTotal(invoice._id), documentNumber },
    );

  // Softmato's invoice is the invoice. The status is the copy's version: paid prints differently.
  if (invoice.softmatoInvoiceNo) {
    const softmatoNo = invoice.softmatoInvoiceNo;
    const theirs = await softmatoDocument(
      "invoice",
      softmatoNo,
      String(invoice.status),
      () => downloadInvoiceFile(softmatoNo),
      () => drawOurs(softmatoNo),
    );

    /*
     * Their `RESOURCE_NOT_FOUND` for a number we hold means it was raised on a
     * Softmato from before the live integration and is gone from their ledger.
     * Ours was numbered alongside it, so the owner gets that rather than a 404.
     */
    if (theirs || !invoice.localInvoiceNo) return theirs;
  }

  // History printed here before Softmato issued everything, and invoices their ledger has lost.
  const documentNumber = invoice.localInvoiceNo;

  if (!documentNumber) return null;

  return {
    bytes: await drawOurs(documentNumber),
    contentType: "application/pdf",
    filename: documentFileName(documentNumber),
    issuedBy: "platform",
  };
}

/**
 * Everything actually collected against one invoice.
 *
 * `SETTLED` only, for the reason it is only ever `SETTLED` anywhere money is
 * counted in this codebase: a pending attempt is a promise being waited on, and
 * printing one on an invoice would show an owner a debt they have not cleared
 * as cleared.
 */
async function settledTotal(invoiceId: Types.ObjectId): Promise<number> {
  const rows = await SubscriptionPaymentModel.aggregate<{ total: number }>([
    { $match: { invoiceId, status: "SETTLED" } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);

  return rows[0]?.total ?? 0;
}

/* ── Receipt ───────────────────────────────────────────────────────────── */

/**
 * A receipt is addressed by whichever number the reader is holding.
 *
 * Three can identify one payment and all three are accepted: Softmato's
 * transaction number, our own statutory number, and the per-hostel receipt
 * reference support quotes. A reader holding a document should be able to fetch
 * it with the number printed on it, and which number that is depends on which
 * side printed the copy they have.
 */
export async function resolveReceiptDocument(
  number: string,
  scope: HostelScope,
): Promise<ResolvedDocument | null> {
  await connectToDatabase();

  const payment = await SubscriptionPaymentModel.findOne({
    ...scopeFilter(scope),
    $or: [
      { softmatoTransactionNo: number },
      { localTransactionNo: number },
      { receiptNumber: number },
    ],
  }).lean<Parameters<typeof renderReceiptForRow>[0] | null>();

  if (!payment || payment.status !== "SETTLED") return null;

  const drawOurs = async (documentNumber: string) => {
    const invoice = await SubscriptionInvoiceModel.findById(
      payment.invoiceId,
    ).lean<{
      amount: number;
      billedTo?: { email?: string; hostelName?: string; name?: string };
      invoiceNumber: string;
      localInvoiceNo?: string | null;
      softmatoInvoiceNo?: string | null;
    } | null>();

    return renderReceiptForRow(payment, {
      documentNumber,
      /*
       * The invoice as it is *printed*, not as we file it. A receipt whose
       * "Against Invoice" line quoted `SUB-0001-4F2A` would send an owner looking
       * for a number that appears nowhere on the invoice in their hand.
       */
      invoiceNumber:
        invoice?.softmatoInvoiceNo ??
        invoice?.localInvoiceNo ??
        invoice?.invoiceNumber ??
        "—",
      invoiceTotal: invoice?.amount ?? payment.amount,
      receivedFrom: {
        email: invoice?.billedTo?.email ?? "",
        name: invoice?.billedTo?.name || invoice?.billedTo?.hostelName || "",
      },
      totalReceived: invoice
        ? await settledTotal(payment.invoiceId)
        : payment.amount,
    });
  };

  if (payment.softmatoTransactionNo) {
    const softmatoNo = payment.softmatoTransactionNo;

    return softmatoDocument(
      "receipt",
      softmatoNo,
      "1",
      () => downloadReceiptFile(softmatoNo),
      () => drawOurs(softmatoNo),
    );
  }

  // Money Softmato never saw keeps the receipt printed here at the time.
  if (payment.method === "SOFTMATO") return null;

  const documentNumber =
    payment.localTransactionNo ?? (await ensureLocalReceiptNumber(payment._id));

  if (!documentNumber) return null;

  return {
    bytes: await drawOurs(documentNumber),
    contentType: "application/pdf",
    filename: documentFileName(documentNumber),
    issuedBy: "platform",
  };
}
