import { PDFDocument } from "pdf-lib";

import { amountInWords } from "./amount-in-words";
import {
  bsFiscalYear,
  documentAdDate,
  documentAmount,
  documentBsDate,
  drawFooter,
  drawIssuer,
  drawTaxNote,
  loadInk,
  type Issuer,
} from "./document-parts";
import { Cursor } from "./layout";
import { COLORS, CONTENT_WIDTH, MARGIN, PAGE, SIZE, SPACE } from "./theme";

/**
 * The plan invoice — the demand for money, before any has arrived.
 *
 * ## What the page is arguing
 *
 * Read top to bottom it answers four questions in the order a person asks
 * them: who is billing me, how much and by when, what for, and how do I pay.
 * The status stamp and the amount due sit together in the top right because
 * that pair is the entire message for a reader who opens the file, looks once
 * and closes it — which is most readers, most of the time.
 *
 * ## The plan block is copy, not arithmetic
 *
 * Everything under `AMOUNT IN WORDS` — the plan name, its tagline, its feature
 * lines — comes from `buildPresentation()`, the same block that would have gone
 * to Softmato to print on their document. It is bounded, price-free and plain
 * text by the time it arrives here, and it changes nothing about what is
 * charged: the money on this page comes from the invoice row and is stated
 * exactly once, in the table. That separation is the reason a marketing edit to
 * a plan description cannot alter a bill.
 *
 * ## One line, and the table still exists
 *
 * A subscription invoice bills one thing. The table could have been a sentence
 * — but a table is what an accounts department's eye is trained to find, the
 * quantity and rate columns are what make the total checkable rather than
 * asserted, and a second line is one product decision away. The header row
 * survives on a one-row table for the same reason a receipt carries its amount
 * twice: the redundancy is the point.
 */

export type InvoiceLine = {
  amount: number;
  description: string;
  /** The BS month a recurring charge covers. Null on a one-off. */
  period: string | null;
  quantity: number;
  rate: number;
};

export type InvoicePresentation = {
  billingPeriod?: string;
  features?: string[];
  highlights?: string[];
  planName: string;
  tagline?: string;
};

export type InvoiceDocumentInput = {
  amountPaid: number;
  billedTo: {
    email: string;
    name: string;
    /** A hostel's own PAN, when we hold one. Blank prints "PAN not recorded". */
    pan?: string;
  };
  currency: string;
  /** `HH-INV-2083/84-000012`, or Softmato's own when they raised it. */
  documentNumber: string;
  issuedAt: Date;
  issuer: Issuer;
  lines: InvoiceLine[];
  /** How the reader can pay. Rendered as one sentence, never a form. */
  paymentMethods: string[];
  presentation: InvoicePresentation | null;
  status: "UNPAID" | "PARTLY PAID" | "PAID" | "VOID";
};

/** Where each column of the line table starts, from the left margin. */
const COLUMN = {
  amountRight: PAGE.width - MARGIN.right,
  description: MARGIN.left + 26,
  index: MARGIN.left,
  period: MARGIN.left + 218,
  qtyRight: MARGIN.left + 340,
  rateRight: MARGIN.left + 420,
} as const;

/** The totals block on the right, and how wide its rules run. */
const TOTALS = {
  labelX: MARGIN.left + 240,
  width: CONTENT_WIDTH - 240,
} as const;

export async function renderInvoiceDocument(
  input: InvoiceDocumentInput,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const ink = await loadInk(pdf);
  const cursor = new Cursor(page, ink);

  pdf.setTitle(`Invoice ${input.documentNumber}`);
  pdf.setProducer(input.issuer.legalName);
  pdf.setCreator(input.issuer.productName || input.issuer.legalName);
  // The document's own date, not the render's: the same invoice renders to the
  // same bytes, and the file's metadata agrees with the date printed on it.
  pdf.setCreationDate(input.issuedAt);
  pdf.setModificationDate(input.issuedAt);

  const subtotal = input.lines.reduce((sum, line) => sum + line.amount, 0);
  const due = Math.max(0, subtotal - input.amountPaid);

  /* ── Masthead, and the document's own identity opposite ─────────────── */

  const mastheadTop = cursor.top;

  drawIssuer(cursor, input.issuer);

  const afterIssuer = cursor.top;

  cursor.to(mastheadTop);
  cursor.title("right", "Invoice");
  cursor.down(SPACE.tight);

  const metaLabelX = PAGE.width - MARGIN.right - 250;

  cursor.field("Invoice No.", input.documentNumber, { labelX: metaLabelX });
  cursor.field("Fiscal Year", bsFiscalYear(input.issuedAt), {
    labelX: metaLabelX,
  });
  cursor.field("Invoice Date", documentBsDate(input.issuedAt), {
    labelX: metaLabelX,
    suffix: `(${documentAdDate(input.issuedAt)})`,
  });

  // Whichever column ran longer decides where the rule goes. Hard-coding it
  // would clip the address block the day an issuer types a second line.
  cursor.to(Math.min(afterIssuer, cursor.top) - SPACE.tight);
  cursor.ruleStrong();

  /* ── Who is being billed, and the headline ──────────────────────────── */

  const partiesTop = cursor.top;

  cursor.eyebrow(MARGIN.left, "Bill to");
  cursor.line(MARGIN.left, input.billedTo.name, {
    font: ink.bold,
    size: SIZE.partyName,
  });
  cursor.line(
    MARGIN.left,
    input.billedTo.pan ? `PAN: ${input.billedTo.pan}` : "PAN not recorded",
    { color: COLORS.muted, size: SIZE.label },
  );

  if (input.billedTo.email) {
    cursor.line(MARGIN.left, input.billedTo.email, {
      color: COLORS.accent,
      size: SIZE.label,
    });
  }

  const afterParties = cursor.top;

  cursor.to(partiesTop);
  cursor.eyebrow("right", "Status");

  /*
   * The stamp hangs from the cursor rather than sitting on it, so the eyebrow
   * above and the amount below both measure from a box of known height. `VOID`
   * is drawn in the muted ink: a withdrawn invoice is not a warning, it is a
   * document that no longer asks for anything.
   */
  const stamp = cursor.stamp(input.status, {
    color: input.status === "PAID" ? COLORS.accent : COLORS.text,
    top: cursor.top + SIZE.eyebrow,
  });

  cursor.down(stamp.height - SIZE.eyebrow + SPACE.tight);
  cursor.line("right", input.status === "PAID" ? "Amount received" : "Amount due", {
    color: COLORS.label,
    size: SIZE.label,
  });
  cursor.line(
    "right",
    `${input.currency} ${documentAmount(input.status === "PAID" ? subtotal : due)}`,
    { font: ink.monoBold, size: 15 },
  );

  cursor.to(Math.min(afterParties, cursor.top) - SPACE.tight);
  cursor.rule();

  /* ── The line table ─────────────────────────────────────────────────── */

  const header: [number | "right", string][] = [
    [COLUMN.index, "#"],
    [COLUMN.description, "Description"],
    [COLUMN.period, "Period"],
    [COLUMN.qtyRight, "Qty"],
    [COLUMN.rateRight, "Rate"],
    [COLUMN.amountRight, "Amount"],
  ];

  for (const [x, label] of header) {
    const text = label.toUpperCase();
    // The three money columns are right-aligned, so their heading has to hang
    // off the same edge the figures under it will.
    const right = x === COLUMN.qtyRight || x === COLUMN.rateRight || x === COLUMN.amountRight;
    const width = right ? cursor.width(text, { size: SIZE.eyebrow, tracking: 1 }) : 0;

    cursor.text(Number(x) - width, text, {
      color: COLORS.label,
      size: SIZE.eyebrow,
      tracking: 1,
    });
  }

  cursor.down(SPACE.line + 4);

  input.lines.forEach((line, index) => {
    cursor.text(COLUMN.index, String(index + 1), { font: ink.mono });
    cursor.text(COLUMN.description, line.description, { size: SIZE.body });
    cursor.text(COLUMN.period, line.period ?? "—", {
      color: line.period ? COLORS.text : COLORS.muted,
      font: ink.mono,
    });

    for (const [right, value] of [
      [COLUMN.qtyRight, String(line.quantity)],
      [COLUMN.rateRight, documentAmount(line.rate)],
      [COLUMN.amountRight, documentAmount(line.amount)],
    ] as const) {
      const width = cursor.width(value, { font: ink.mono, size: SIZE.body });

      cursor.text(right - width, value, { font: ink.mono, size: SIZE.body });
    }

    cursor.down(SPACE.line + 2);
  });

  /* ── Totals ─────────────────────────────────────────────────────────── */

  cursor.down(SPACE.tight);

  const totalRow = (
    label: string,
    value: number,
    options: { emphasis?: boolean; rule?: boolean } = {},
  ) => {
    if (options.rule) {
      cursor.page.drawLine({
        color: COLORS.rule,
        end: { x: COLUMN.amountRight, y: cursor.top + 9 },
        start: { x: TOTALS.labelX, y: cursor.top + 9 },
        thickness: 0.6,
      });
    }

    cursor.text(TOTALS.labelX, label, {
      color: options.emphasis ? COLORS.text : COLORS.label,
      font: options.emphasis ? ink.bold : ink.regular,
      size: options.emphasis ? SIZE.body + 0.5 : SIZE.label,
    });

    const figure = documentAmount(value);
    const font = options.emphasis ? ink.monoBold : ink.mono;
    const width = cursor.width(figure, { font, size: SIZE.body });

    cursor.text(COLUMN.amountRight - width, figure, { font, size: SIZE.body });
    cursor.down(SPACE.line + 2);
  };

  totalRow("Subtotal", subtotal, { rule: true });
  totalRow(`Total (${input.currency})`, subtotal, { emphasis: true, rule: true });
  totalRow("Amount paid", input.amountPaid, { rule: true });
  totalRow("Amount due", due, { emphasis: true, rule: true });

  cursor.down(SPACE.tight);
  cursor.rule();

  /* ── The amount, stated a second time ───────────────────────────────── */

  const wordsLabelWidth = cursor.text(MARGIN.left, "AMOUNT IN WORDS", {
    color: COLORS.label,
    size: SIZE.eyebrow,
    tracking: 1.2,
  });

  cursor.text(MARGIN.left + wordsLabelWidth + 12, amountInWords(subtotal), {
    size: SIZE.body,
  });
  cursor.down(SPACE.rule + 2);
  cursor.rule();

  /* ── What the plan is ───────────────────────────────────────────────── */

  if (input.presentation) {
    drawPresentation(cursor, input.presentation);
  }

  if (input.paymentMethods.length > 0) {
    cursor.line(MARGIN.left, `Pay via ${input.paymentMethods.join(" · ")}.`, {
      color: COLORS.label,
      size: SIZE.label,
    });
    cursor.down(SPACE.tight);
  }

  drawTaxNote(cursor, input.issuer, "document");

  drawFooter(cursor, {
    note: "This is a computer-generated invoice.",
    reference: input.documentNumber,
  });

  return pdf.save();
}

/**
 * The plan, in the platform's own words.
 *
 * Two columns for the feature list because the lines are short caps — "Up to
 * 500 beds", "3 warden accounts" — and a single column of them leaves two
 * thirds of the page width empty while pushing the tax note off the fold. The
 * fill order is across, not down: an eye scanning a two-column list of
 * unordered facts reads rows.
 */
function drawPresentation(cursor: Cursor, plan: InvoicePresentation): void {
  cursor.eyebrow(MARGIN.left, plan.planName);

  if (plan.tagline) {
    cursor.line(MARGIN.left, plan.tagline, {
      color: COLORS.accent,
      size: SIZE.label,
    });
  }

  const features = plan.features ?? [];

  if (features.length > 0) {
    cursor.down(4);

    const columnWidth = CONTENT_WIDTH / 2;

    for (let row = 0; row < Math.ceil(features.length / 2); row += 1) {
      for (const column of [0, 1]) {
        const feature = features[row * 2 + column];

        if (!feature) {
          continue;
        }

        const x = MARGIN.left + column * columnWidth;

        cursor.text(x, "•", { color: COLORS.label, size: SIZE.label });
        cursor.text(x + 9, feature, { color: COLORS.label, size: SIZE.label });
      }

      cursor.down(SPACE.line);
    }
  }

  if (plan.highlights?.length) {
    cursor.line(MARGIN.left, plan.highlights.join(" · "), {
      color: COLORS.accent,
      size: SIZE.label,
    });
  }

  cursor.down(SPACE.tight);
}
