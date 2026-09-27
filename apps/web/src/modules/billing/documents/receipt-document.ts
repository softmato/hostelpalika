import { PDFDocument } from "pdf-lib";

import { amountInWords } from "./amount-in-words";
import {
  bsFiscalYear,
  documentAdDate,
  documentAmount,
  documentBsDate,
  documentInstant,
  drawFooter,
  drawIssuer,
  drawTaxNote,
  loadInk,
  type Issuer,
} from "./document-parts";
import { Cursor } from "./layout";
import { COLORS, MARGIN, PAGE, SIZE, SPACE } from "./theme";

/**
 * The receipt — money that has arrived, and nothing else.
 *
 * ## It is centred, and the invoice is not
 *
 * An invoice is a form: two parties in columns, a table, a totals block hanging
 * off the right rule. It is read across. A receipt has one fact — this much was
 * received — and everything else on the page is provenance for it. So the
 * amount sits alone in the middle at three times the size of anything near it,
 * and the page is symmetrical around it. The two documents look like siblings
 * rather than twins on purpose: a reader must never mistake one for the other,
 * because the difference between them is whether they still owe money.
 *
 * ## It never exists before the money does
 *
 * There is no draft receipt, no pending receipt and no receipt for a payment
 * that failed. Every caller reaches this from a `SETTLED` row, and the reason
 * is not procedural: a receipt is an assertion that a specific sum was
 * received, and issuing one for a payment still in flight puts a document into
 * the world stating something that is not yet true and may never be.
 *
 * ## The balance line is on it even when it is zero
 *
 * `Balance due 0.00` under `PAID IN FULL` is redundant twice over, and it stays.
 * A part payment and a full one then produce the same document with a different
 * number in the same place, so an owner who has seen one can read the other —
 * and a receipt that silently omitted the balance whenever it was cleared would
 * make its absence, rather than its value, the thing carrying the meaning.
 */

export type ReceiptDocumentInput = {
  amount: number;
  currency: string;
  /** `HH-TXN-2083/84-00000008`, or Softmato's own. */
  documentNumber: string;
  /** What the invoice asked for in total. */
  invoiceTotal: number;
  /** Our invoice's own number, and the fiscal year it was raised in. */
  invoiceNumber: string;
  issuer: Issuer;
  /** `eSewa`, `Khalti`, `Cash`. */
  method: string;
  paidAt: Date;
  /** The payer, as the invoice addressed them. */
  receivedFrom: { email: string; name: string };
  /** Our internal handle, printed at the foot. `SRC-0001-4F2A`. */
  reference: string;
  /** Everything received against the invoice, this payment included. */
  totalReceived: number;
  /** The gateway's own id. Absent on cash, which has no gateway. */
  transactionId: string | null;
};

export async function renderReceiptDocument(
  input: ReceiptDocumentInput,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const ink = await loadInk(pdf);
  const cursor = new Cursor(page, ink);

  pdf.setTitle(`Receipt ${input.documentNumber}`);
  pdf.setProducer(input.issuer.legalName);
  pdf.setCreator(input.issuer.productName || input.issuer.legalName);
  // The payment's date, not the render's: the same receipt renders to the same
  // bytes, and the file's metadata agrees with the date printed on it.
  pdf.setCreationDate(input.paidAt);
  pdf.setModificationDate(input.paidAt);

  const balance = Math.max(0, input.invoiceTotal - input.totalReceived);
  const settled = balance === 0;

  /* ── Masthead ───────────────────────────────────────────────────────── */

  drawIssuer(cursor, input.issuer, { compact: true });
  cursor.down(SPACE.tight);
  cursor.ruleStrong();

  cursor.down(SPACE.tight);
  cursor.title("center", "Payment Receipt");
  cursor.down(SPACE.tight);

  /* ── Which document, and when ───────────────────────────────────────── */

  cursor.field("Receipt No.", input.documentNumber, {
    valueColor: COLORS.accent,
  });
  cursor.field("Receipt Date", documentBsDate(input.paidAt), {
    suffix: `(${documentAdDate(input.paidAt)})`,
  });
  cursor.field("Against Invoice", input.invoiceNumber, {
    suffix: `(FY ${bsFiscalYear(input.paidAt)})`,
  });

  cursor.down(SPACE.tight);
  cursor.rule();

  /* ── Who paid ───────────────────────────────────────────────────────── */

  cursor.eyebrow(MARGIN.left, "Received from");
  cursor.line(MARGIN.left, input.receivedFrom.name, {
    font: ink.bold,
    size: SIZE.partyName,
  });

  if (input.receivedFrom.email) {
    cursor.line(MARGIN.left, input.receivedFrom.email, {
      color: COLORS.accent,
      size: SIZE.label,
    });
  }

  cursor.down(SPACE.tight);
  cursor.rule();

  /* ── The one fact ───────────────────────────────────────────────────── */

  cursor.down(SPACE.tight);
  cursor.eyebrow("center", "Amount received");

  /*
   * A full block, not the usual tight gap. The figure below is drawn from its
   * baseline at three times the eyebrow's size, so its ascenders climb back
   * into any ordinary line gap and collide with the words above it. This is the
   * one place on either document where the type sizes are far enough apart for
   * the rhythm to need saying out loud.
   */
  cursor.down(SPACE.block);

  cursor.line("center", `${input.currency} ${documentAmount(input.amount)}`, {
    font: ink.monoBold,
    size: SIZE.amount,
  });

  cursor.down(4);
  cursor.line("center", amountInWords(input.amount), {
    color: COLORS.accent,
    size: SIZE.label,
  });

  cursor.down(SPACE.block);
  cursor.rule();

  /* ── How it arrived ─────────────────────────────────────────────────── */

  cursor.field("Payment method", input.method, {
    valueColor: COLORS.accent,
    valueFont: ink.regular,
  });

  if (input.transactionId) {
    cursor.field("Transaction ID", input.transactionId, {
      valueColor: COLORS.accent,
    });
  }

  cursor.field("Paid at", documentInstant(input.paidAt));

  if (input.issuer.productName) {
    cursor.field("For", input.issuer.productName, {
      valueFont: ink.regular,
    });
  }

  cursor.down(SPACE.tight);
  cursor.rule();

  /* ── Where that leaves the invoice ──────────────────────────────────── */

  const ledgerTop = cursor.top;

  for (const [label, value] of [
    ["Invoice total", input.invoiceTotal],
    ["Total received", input.totalReceived],
    ["Balance due", balance],
  ] as const) {
    cursor.text(MARGIN.left, label, { color: COLORS.label, size: SIZE.label });
    cursor.text(MARGIN.left + 170, documentAmount(value), {
      font: ink.mono,
      size: SIZE.body,
    });
    cursor.down(SPACE.line + 2);
  }

  /*
   * The stamp is hung from the middle of the three ledger rows rather than the
   * top of the block, so it reads as a verdict on all three rather than a label
   * on the first. `PARTLY PAID` in the plain ink for the reason `VOID` is on the
   * invoice: an instalment paid on time is not a failure, and a red stamp on a
   * receipt would tell an owner who has just paid us that something went wrong.
   */
  cursor.to(ledgerTop - (SPACE.line + 2));
  cursor.stamp(settled ? "Paid in full" : "Partly paid", {
    color: settled ? COLORS.accent : COLORS.text,
    top: ledgerTop + SIZE.body,
    width: 145,
  });

  cursor.to(ledgerTop - (SPACE.line + 2) * 3);
  cursor.down(SPACE.tight);
  cursor.rule();

  drawTaxNote(cursor, input.issuer, "document");

  drawFooter(cursor, {
    note: "Computer-generated receipt. No signature required.",
    reference: input.reference,
  });

  return pdf.save();
}
