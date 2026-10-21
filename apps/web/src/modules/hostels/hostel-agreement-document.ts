import { LineCapStyle, PDFDocument, type PDFFont, type RGB } from "pdf-lib";

import {
  documentAdDate,
  documentBsDate,
  documentInstant,
  loadInk,
  type Issuer,
} from "@/modules/billing/documents/document-parts";
import { Cursor } from "@/modules/billing/documents/layout";
import { COLORS, CONTENT_WIDTH, MARGIN, PAGE, SIZE } from "@/modules/billing/documents/theme";
import {
  AGREEMENT_TITLE,
  agreementIntro,
  type AgreementParties,
  type AgreementSection,
} from "@/modules/hostels/hostel-agreement-terms";
import { SIGNATURE_HEIGHT, SIGNATURE_WIDTH } from "@/lib/signature";
import type { AgreementSeals } from "@/modules/hostels/agreement-seals";

/**
 * The signed service agreement as a PDF, printed on Softmato's letterhead —
 * the same paper as the printed agreement (`marketing/agreement/`). The
 * letterhead brings the company name, the logo swoosh and the address footer,
 * so this draws only the agreement itself, in the space between them, and
 * flows onto as many pages as the text needs.
 *
 * Everything printed comes from the signature record: the parties and terms as
 * the owner read them, their drawn signature, and the signing trail (when,
 * from which account and device, and the text's SHA-256). Built when needed,
 * never stored — the record is the agreement, this is its print.
 */

export type AgreementDocumentInput = {
  approvedByName: string;
  /** `null` with `refCode`: not issued yet — a preview for the platform, with the company side left empty. */
  issuedAt: Date | null;
  issuer: Issuer;
  ip: string;
  parties: AgreementParties;
  refCode: string | null;
  /** The founders' signatures and the stamp (`agreement-seals.ts`), on an issued agreement. */
  seals: AgreementSeals | null;
  signature: string;
  signedAt: Date;
  signerName: string;
  terms: AgreementSection[];
  textHash: string;
  userAgent: string;
};

/**
 * The printed copy, filled in and signed by hand — the field team's paper
 * (`marketing/agreement/hostel-register-agreement.pdf`, built by
 * `scripts/build-paper-agreement.mts`). Same paper, same terms.
 */
export type PaperAgreementInput = {
  issuer: Issuer;
  parties: AgreementParties;
  terms: AgreementSection[];
  /** Who signs for the company on paper. */
  companySigners: string;
};

/** Distances from the top of the page, where the letterhead's parts sit. */
const BODY_TOP = 198;
/** Below this the swoosh is gone and lines run the full width. */
const SWOOSH_BOTTOM = 292;
/** The lowest a line may sit, clear of the letterhead's footer rule (769pt). */
const BODY_BOTTOM_Y = 98;
const PAGE_NUMBER_Y = 80;

/**
 * The swoosh's left edge, top-down from where the body starts (184pt), with
 * clearance — the same outline the printed agreement wraps its text around.
 */
const SWOOSH = [
  [0, 404],
  [16, 424],
  [40, 455],
  [64, 492],
  [88, 534],
  [96, 545],
] as const;

const BODY = 9;
const BULLET_INDENT = 11;
/** Room the signature block needs (measured: ~206pt); it never splits across pages. */
const SIGN_BLOCK = 208;
const PREVIEW = "PREVIEW - not issued";

/** How far right a line whose glyph tops sit at `fromTop` may run. */
function rightEdge(fromTop: number) {
  const full = PAGE.width - MARGIN.right;
  const offset = fromTop - 184;

  if (offset >= SWOOSH[SWOOSH.length - 1]![0]) return full;
  if (offset <= 0) return SWOOSH[0][1];

  const at = SWOOSH.findIndex(([y]) => y >= offset);
  const [y0, x0] = SWOOSH[at - 1]!;
  const [y1, x1] = SWOOSH[at]!;

  return Math.min(full, x0 + ((x1 - x0) * (offset - y0)) / (y1 - y0));
}

/** WinAnsi cannot draw Devanagari; a name degrades to `?` rather than throwing. */
function ascii(text: string) {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/[^\x20-\x7E]/g, "?");
}

let letterhead: Promise<Uint8Array> | null = null;

function loadLetterhead() {
  letterhead ??= import("@/modules/hostels/agreement-letterhead").then(({ AGREEMENT_LETTERHEAD_BASE64 }) =>
    Uint8Array.from(Buffer.from(AGREEMENT_LETTERHEAD_BASE64, "base64")),
  );

  return letterhead;
}

export function renderAgreementDocument(input: AgreementDocumentInput) {
  return render(input);
}

export function renderPaperAgreement(input: PaperAgreementInput) {
  return render({ ...input, paper: true });
}

async function render(input: AgreementDocumentInput | (PaperAgreementInput & { paper: true })): Promise<Uint8Array> {
  const paperCopy = "paper" in input;
  const pdf = await PDFDocument.create();
  const ink = await loadInk(pdf);
  const [paper] = await pdf.embedPdf(await loadLetterhead(), [0]);
  const cursors: Cursor[] = [];
  const newPage = () => {
    const page = pdf.addPage([PAGE.width, PAGE.height]);

    page.drawPage(paper!, { height: PAGE.height, width: PAGE.width, x: 0, y: 0 });

    const next = new Cursor(page, ink);

    next.to(PAGE.height - BODY_TOP);
    cursors.push(next);

    return next;
  };
  let cursor = newPage();
  /** Keeps `points` together, starting a new page when they would run into the footer. */
  const room = (points: number) => {
    if (cursor.top - points < BODY_BOTTOM_Y) cursor = newPage();
  };
  /** Puts a full-width block below the swoosh. */
  const clearSwoosh = () => cursor.to(Math.min(cursor.top, PAGE.height - SWOOSH_BOTTOM));
  const hairline = () => {
    cursor.down(4);
    cursor.page.drawLine({
      color: COLORS.rule,
      end: { x: rightEdge(PAGE.height - cursor.top), y: cursor.top },
      start: { x: MARGIN.left, y: cursor.top },
      thickness: 0.6,
    });
    cursor.down(14);
  };
  /** Wraps `text` line by line, each line as wide as the swoosh allows at its height. */
  const flow = (
    text: string,
    options: { bullet?: boolean; color?: RGB; font?: PDFFont; indent?: number; size?: number } = {},
  ) => {
    const size = options.size ?? BODY;
    const font = options.font ?? ink.regular;
    const left = MARGIN.left + (options.indent ?? 0);
    const leading = size * 1.4;
    const words = ascii(text).split(/\s+/).filter(Boolean);
    let first = true;

    while (words.length) {
      room(leading);

      const width = rightEdge(PAGE.height - cursor.top - size) - left;
      let line = words.shift()!;

      while (words.length && font.widthOfTextAtSize(`${line} ${words[0]}`, size) <= width) {
        line += ` ${words.shift()}`;
      }

      if (first && options.bullet) cursor.text(MARGIN.left + 2, "-", { size });
      cursor.text(left, line, { color: options.color, font, size });
      cursor.down(leading);
      first = false;
    }
  };
  const { company, hostel, owner } = input.parties;

  pdf.setTitle(paperCopy ? AGREEMENT_TITLE : `${AGREEMENT_TITLE} ${input.refCode ?? PREVIEW}`);
  pdf.setAuthor(input.issuer.legalName);
  pdf.setProducer(input.issuer.legalName);
  pdf.setCreator(input.issuer.productName || input.issuer.legalName);

  // The heading sits left of the swoosh, like the printed agreement's.
  cursor.eyebrow(MARGIN.left, "Agreement");
  cursor.down(4);
  cursor.line(MARGIN.left, AGREEMENT_TITLE, { color: COLORS.accent, font: ink.bold, size: 16 });
  cursor.line(MARGIN.left, "Hostel management software and online listing", { size: SIZE.label });
  cursor.down(4);

  /** A space to write in by hand. */
  const blank = (x: number, width: number) =>
    cursor.page.drawLine({
      color: COLORS.rule,
      end: { x: x + width, y: cursor.top - 2 },
      start: { x, y: cursor.top - 2 },
      thickness: 0.6,
    });

  for (const [label, value] of paperCopy
    ? ([["Ref. No.", "SMT/HP/"], ["Date", ""]] as const)
    : ([
        ["Agreement No.", input.refCode ?? PREVIEW],
        ["Signed on", `${documentBsDate(input.signedAt)} (${documentAdDate(input.signedAt)})`],
      ] as const)) {
    const width = cursor.text(MARGIN.left, `${label}  `, { font: ink.bold, size: SIZE.label });
    const drawn = cursor.text(MARGIN.left + width, value, { size: SIZE.label });

    if (paperCopy) blank(MARGIN.left + width + drawn, 130 - drawn);
    cursor.down(SIZE.label + 7);
  }

  clearSwoosh();
  hairline();

  // The two parties side by side.
  const top = cursor.top;
  const column = (x: number, eyebrow: string, name: string, lines: string[]) => {
    cursor.to(top);
    cursor.eyebrow(x, eyebrow);
    cursor.line(x, ascii(name), { font: ink.bold, size: SIZE.partyName });

    for (const value of lines.filter(Boolean)) {
      cursor.line(x, ascii(value), { size: SIZE.label });
    }

    return cursor.top;
  };
  const left = column(MARGIN.left, "HostelPalika", company.legalName, [
    company.address,
    company.pan ? `PAN: ${company.pan}` : "",
    company.email,
    company.supportPhone || company.phone,
  ]);
  const ownerX = MARGIN.left + CONTENT_WIDTH / 2 + 8;
  const right = paperCopy
    ? (() => {
        // Filled in by hand, the way the printed agreement always was.
        cursor.to(top);
        cursor.eyebrow(ownerX, "Hostel owner");

        for (const label of [
          "Full name",
          "Citizenship No.",
          "Phone",
          "Email",
          "Hostel name",
          "Hostel address",
          "Hostel type",
          "Total beds",
          "PAN / VAT No.",
          "Registered by",
        ]) {
          const width = cursor.text(ownerX, label, { color: COLORS.label, size: SIZE.label });

          if (label === "Hostel type") {
            cursor.text(ownerX + 78, "[  ] Boys   [  ] Girls   [  ] Co-living", { size: SIZE.label });
          } else {
            blank(ownerX + Math.max(width + 6, 78), PAGE.width - MARGIN.right - ownerX - Math.max(width + 6, 78));
          }

          cursor.down(17);
        }

        return cursor.top;
      })()
    : column(ownerX, "Hostel owner", owner.name, [hostel.name, hostel.address, owner.email, owner.phone]);

  cursor.to(Math.min(left, right));
  hairline();
  flow(agreementIntro(input.parties));
  cursor.down(6);

  for (const section of input.terms) {
    room(BODY * 1.4 * 3);
    cursor.down(5);
    flow(section.heading, { color: COLORS.accent, font: ink.bold, size: 9.5 });
    cursor.down(1);

    for (const point of section.points) {
      flow(point, { bullet: true, indent: BULLET_INDENT });
    }
  }

  // Signatures: the owner's drawn one on the left, the company's approval on the right.
  if (paperCopy) {
    // Room to sign, then the lines the two signatures go on.
    room(108);
    clearSwoosh();
    cursor.down(36);

    const line = cursor.top;
    const rightX = MARGIN.left + CONTENT_WIDTH / 2 + 8;
    const width = CONTENT_WIDTH / 2 - 20;

    for (const x of [MARGIN.left, rightX]) {
      cursor.page.drawLine({ color: COLORS.ruleStrong, end: { x: x + width, y: line }, start: { x, y: line }, thickness: 0.8 });
    }

    cursor.down(12);
    cursor.line(MARGIN.left, "Owner's signature", { font: ink.bold, size: SIZE.label });
    cursor.text(MARGIN.left, "Name", { size: SIZE.label });
    blank(MARGIN.left + 34, width - 34);
    cursor.down(17);
    cursor.text(MARGIN.left, "Date", { size: SIZE.label });
    blank(MARGIN.left + 34, width - 34);
    cursor.down(17);
    cursor.line(MARGIN.left, "Hostel stamp (if any)", { color: COLORS.muted, size: SIZE.footnote });
    cursor.to(line - 12);
    cursor.line(rightX, `For ${ascii(company.legalName)}`, { font: ink.bold, size: SIZE.label });
    cursor.line(rightX, ascii(input.companySigners), { size: SIZE.label });
    cursor.line(rightX, "Signature & company stamp", { color: COLORS.muted, size: SIZE.footnote });
    cursor.down(3);
    cursor.text(rightX, "Date", { size: SIZE.label });
    blank(rightX + 34, width - 34);

    cursors.forEach((page, index) => {
      page.to(PAGE_NUMBER_Y);
      page.text(MARGIN.left, "Owner's initials", { color: COLORS.muted, size: SIZE.footnote });
      page.page.drawLine({
        color: COLORS.rule,
        end: { x: MARGIN.left + 150, y: PAGE_NUMBER_Y - 2 },
        start: { x: MARGIN.left + 60, y: PAGE_NUMBER_Y - 2 },
        thickness: 0.6,
      });
      page.text("right", `Page ${index + 1} of ${cursors.length}`, { color: COLORS.muted, size: SIZE.footnote });
    });

    return pdf.save();
  }

  room(SIGN_BLOCK);
  cursor.down(8);
  clearSwoosh();

  const box = { height: (CONTENT_WIDTH / 2 - 20) / (SIGNATURE_WIDTH / SIGNATURE_HEIGHT), width: CONTENT_WIDTH / 2 - 20 };
  const signTop = cursor.top;
  const rightX = MARGIN.left + CONTENT_WIDTH / 2 + 8;

  if (input.signature) {
    cursor.page.drawSvgPath(input.signature, {
      borderColor: COLORS.text,
      borderLineCap: LineCapStyle.Round,
      borderWidth: 5,
      scale: box.width / SIGNATURE_WIDTH,
      x: MARGIN.left,
      y: signTop,
    });
  }

  const line = signTop - box.height - 4;
  const seals = input.refCode ? input.seals : null;
  const signers = seals?.signatures.filter((signer) => signer.image) ?? [];

  if (!input.refCode) {
    cursor.to(signTop - box.height * 0.55);
    cursor.text(rightX, "Awaiting KYC approval", { color: COLORS.muted, font: ink.bold, size: 10 });
  } else if (signers.length === 0) {
    cursor.to(signTop - box.height * 0.55);
    cursor.text(rightX, "Approved electronically", { color: COLORS.accent, font: ink.bold, size: 10 });
  } else {
    // The founders' signatures side by side on the line, the stamp over the end of it.
    let x = rightX;

    for (const signer of signers) {
      const image = await pdf.embedPng(signer.image!);
      const size = image.scaleToFit(92, 38);

      cursor.page.drawImage(image, { height: size.height, width: size.width, x, y: line + 3 });
      x += size.width + 8;
    }
  }

  if (seals?.stamp) {
    const stamp = await pdf.embedPng(seals.stamp);
    const size = stamp.scaleToFit(74, 74);

    cursor.page.drawImage(stamp, {
      height: size.height,
      opacity: 0.9,
      width: size.width,
      x: rightX + box.width - size.width + 4,
      y: line - 12,
    });
  }

  cursor.to(line);

  for (const x of [MARGIN.left, rightX]) {
    cursor.page.drawLine({
      color: COLORS.ruleStrong,
      end: { x: x + box.width, y: cursor.top },
      start: { x, y: cursor.top },
      thickness: 0.8,
    });
  }

  cursor.down(12);

  const signRows = cursor.top;

  cursor.line(MARGIN.left, ascii(input.signerName), { font: ink.bold, size: SIZE.label });
  cursor.line(MARGIN.left, `Owner, ${ascii(hostel.name)}`, { size: SIZE.label });
  cursor.line(MARGIN.left, documentInstant(input.signedAt), { size: SIZE.label });
  cursor.to(signRows);
  cursor.line(rightX, `For ${ascii(company.legalName)}`, { font: ink.bold, size: SIZE.label });

  if (signers.length) {
    cursor.line(rightX, `${signers.map((signer) => signer.name).join(" & ")}, ${signers[0]!.title}s`, { size: SIZE.label });
  }

  if (input.issuedAt) {
    cursor.line(rightX, input.approvedByName ? `KYC approved by ${ascii(input.approvedByName)}` : "KYC approved", {
      size: SIZE.label,
    });
    cursor.line(rightX, documentInstant(input.issuedAt), { size: SIZE.label });
  } else {
    cursor.line(rightX, "Not issued yet", { color: COLORS.muted, size: SIZE.label });
  }

  cursor.to(Math.min(cursor.top, signRows - 3 * (SIZE.label + 4.5)));
  cursor.down(8);

  // The signing trail: what a dispute would ask for first.
  cursor.eyebrow(MARGIN.left, "Signing record");

  for (const line of [
    `Signed in the HostelPalika account ${owner.email || "of the owner"} on ${documentInstant(input.signedAt)}.`,
    `Device: ${input.userAgent || "not recorded"}${input.ip ? ` - IP ${input.ip}` : ""}`,
    `Agreement fingerprint (SHA-256): ${input.textHash}`,
  ]) {
    flow(line, { color: COLORS.muted, size: SIZE.footnote });
  }

  // Above the letterhead's own footer, which carries the address.
  cursors.forEach((page, index) => {
    page.to(PAGE_NUMBER_Y);
    page.text(MARGIN.left, `Signed electronically - Page ${index + 1} of ${cursors.length}`, {
      color: COLORS.muted,
      size: SIZE.footnote,
    });
    page.text("right", input.refCode ?? PREVIEW, { color: COLORS.muted, font: ink.mono, size: SIZE.footnote });
  });

  return pdf.save();
}
