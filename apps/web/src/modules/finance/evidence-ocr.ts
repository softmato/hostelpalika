import { loadSharp } from "@/lib/sharp";
import {
  type EvidenceReadFailure,
  evidenceEngineMode,
  type OcrResult,
} from "@/modules/finance/evidence-engine";
import { readWithGemini } from "@/modules/finance/evidence-gemini";
import { readWithVision } from "@/modules/finance/evidence-vision";
import { extractReferenceCodes } from "@/modules/finance/reference-code";
import { transactionCodeProblem } from "@/modules/finance/transaction-code";

/**
 * Reading the numbers off the screenshot (gap fix 3, second half).
 *
 * Every other check in the claim pipeline verifies what the resident *typed*.
 * This is the only one that looks at what they *uploaded*: it OCRs the evidence
 * and asks whether the amount, the transaction id and the invoice's reference
 * code actually appear on the image. A photograph of a cat with a well-formed id
 * typed beside it used to satisfy all five checks; it cannot satisfy this one.
 *
 * **Three rules, and the whole design follows from them.**
 *
 * 1. **It never rejects.** OCR on a phone screenshot of a Nepali banking app is
 *    good, not certain — a dark-mode receipt, an unusual font or a 40 KB
 *    WhatsApp re-compression can all lose a digit. Auto-rejecting on a missed
 *    match would refuse real payments, so a miss is an amber flag: it keeps the
 *    row out of `Approve all` and puts it in front of a human who can read the
 *    image themselves. A *hit* is the valuable direction — it is the only signal
 *    in the system that says "the evidence says what the claim says".
 * 2. **It never fails a claim.** Everything here is wrapped so that a missing
 *    module, an unavailable model file, a corrupt image or a slow worker
 *    degrades to "no signal". A resident's rent must not be un-submittable
 *    because a WASM binary did not load.
 * 3. **Nothing is stored.** The text is matched in memory and discarded. A
 *    payment screenshot contains account numbers and balances, and keeping a
 *    transcript of one in Mongo would create a second, more searchable copy of
 *    the most sensitive thing a resident uploads.
 *
 * Set `EVIDENCE_OCR=off` to disable — the flags simply stop appearing.
 */

/** Flags this module can raise. All amber, none a rejection. */
export const OCR_FLAGS = {
  /** OCR ran and found no usable text at all — a photo, or an unreadable shot. */
  NO_TEXT: "EVIDENCE_NO_TEXT_FOUND",
  /** Text was read, but the claimed amount is not in it. */
  AMOUNT_ABSENT: "EVIDENCE_AMOUNT_NOT_ON_IMAGE",
  /** Text was read, but neither the transaction id nor the reference code is. */
  REFERENCE_ABSENT: "EVIDENCE_ID_NOT_ON_IMAGE",
  /**
   * Text was read and it is not a payment record — no provider, no currency, none
   * of a receipt's vocabulary. A photo, a chat screenshot, the wrong file.
   */
  NOT_A_RECEIPT: "EVIDENCE_NOT_A_PAYMENT_RECORD",
  /** The image says what the claim says. The one green signal here. */
  CONFIRMED: "EVIDENCE_TEXT_MATCHES_CLAIM",
  /**
   * The image carries *this invoice's* reference code — the strongest signal
   * available, and the only one autofill cannot manufacture.
   *
   * Worth separating because of a circularity the autofill introduced: since the
   * form fills the amount and the transaction id *from* the screenshot, "the
   * screenshot agrees with them" can mean no more than that the image agrees with
   * itself. The reference code does not come from the image — it comes from the
   * invoice, out of our own database — so finding it there says something no
   * amount of copying from the receipt could produce.
   */
  REFERENCE_ON_IMAGE: "EVIDENCE_REFERENCE_ON_IMAGE",
} as const;

/**
 * Exported because "switched off" and "tried and failed" must not look the same
 * to the caller. A hostel that turns OCR off gets no evidence flags at all and
 * keeps `Approve all` working exactly as it did before; a recogniser that fails
 * on a specific file flags that file.
 */
export function isEvidenceOcrEnabled(): boolean {
  return (process.env.EVIDENCE_OCR ?? "on").toLowerCase() !== "off";
}

/**
 * The text layer of a PDF receipt.
 *
 * **Not OCR, and much better than it.** A `Send Money` receipt exported by eSewa,
 * or a bank's e-statement, is a *generated* PDF: the characters are in the file as
 * characters. Extracting them is exact — no misread digits, no shape folding, no
 * tolerance — and it takes about 150 ms rather than a second.
 *
 * Which is why PDFs were the wrong thing to give up on. They were reported as
 * "nothing could read this file" while being the one format we could read
 * perfectly, and a resident whose bank only emails PDFs got no autofill and an
 * amber flag on every claim.
 *
 * Same failure contract as the recogniser: null on anything at all going wrong.
 */
async function readPdfText(bytes: Buffer | Uint8Array): Promise<string | null> {
  try {
    // Dynamic on purpose: a large optional dependency whose absence must cost a
    // signal, not a claim.
    const { extractText, getDocumentProxy } = await import("unpdf");
    // `unpdf` mutates the buffer it is handed, and these bytes are also hashed and
    // perceptually compared by the caller. A copy costs a few hundred KB once.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    const merged = Array.isArray(text) ? text.join("\n") : text;

    return merged.trim() || null;
  } catch {
    return null;
  }
}

/** Whether this evidence is read by its text layer rather than by recognition. */
export function isPdfEvidence(mimeType: string | undefined): boolean {
  return (mimeType ?? "").toLowerCase().includes("pdf");
}

/**
 * Upright, right-sized, and otherwise left alone.
 *
 * **Deliberately minimal, and that is a correction.** This module used to carry
 * a second preparation chain — greyscale, `normalise()`, downscale to 1600 —
 * tuned for the local recogniser, which reads a high-contrast bitonal image
 * best. Every step in it actively hurts a document recogniser, and it went with
 * that engine. Greyscale throws away the colour
 * Vision uses to segment a receipt card from the page behind it. `normalise()`
 * stretches the histogram and distorts the anti-aliasing that mobile text is
 * drawn with. Downscaling to 1600 discards resolution the recogniser can use.
 *
 * So the chain here does the two things that are unambiguously useful and
 * nothing else: apply the EXIF orientation a phone camera leaves behind — a
 * sideways photo of a bank slip reads as nothing without it — and cap the size
 * so a 12-megapixel photograph is not sent over the wire in full. Almost every
 * wallet screenshot is already under the cap and passes through untouched, which
 * is the point: Vision performs best on the original pixels.
 */
async function prepareForVision(
  bytes: Buffer | Uint8Array,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const sharp = await loadSharp();

  if (!sharp) return null;

  try {
    // Already upright, under the cap, and a format both engines take: send the
    // original. Re-encoding gains nothing here, costs a full decode + PNG
    // encode, and turns a 300 KB JPEG screenshot into a multi-megabyte PNG.
    const meta = await sharp(bytes).metadata();
    const passThrough: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
    const mimeType = passThrough[meta.format ?? ""];
    if (
      mimeType &&
      (meta.orientation ?? 1) === 1 &&
      Math.max(meta.width ?? Infinity, meta.height ?? Infinity) <= VISION_MAX_EDGE
    ) {
      return { bytes: Buffer.from(bytes), mimeType };
    }
  } catch {
    // Unreadable header: let the full preparation below decide.
  }

  try {
    const prepared = await sharp(bytes)
      .rotate()
      .resize({
        fit: "inside",
        height: VISION_MAX_EDGE,
        width: VISION_MAX_EDGE,
        // Never upscale. Enlarging a 460px crop invents pixels and gives the
        // recogniser interpolation artifacts to read.
        withoutEnlargement: true,
      })
      .png({ compressionLevel: 6 })
      .toBuffer();

    return { bytes: prepared, mimeType: "image/png" };
  } catch {
    return null;
  }
}

/** Longest edge sent to Vision. Above this, size costs bandwidth, not accuracy. */
const VISION_MAX_EDGE = 2400;

export type EvidenceRead = {
  /** Null when the read succeeded. Diagnostic only — nothing branches on it. */
  failure: EvidenceReadFailure | null;
  result: OcrResult;
};

/**
 * The evidence, read.
 *
 * Dispatches twice: on the format, because a PDF carries its text and an image
 * has to be recognised; and then on the configured engine.
 *
 * **Why the failure reason is returned rather than swallowed.** For the life of
 * this feature every failure collapsed into `null`, and `null` reached the
 * resident as a single sentence: "We could not read this one". The recogniser
 * was then dead in production for weeks — worker files a serverless bundler
 * could not trace — and the only visible symptom was residents being told their
 * receipts were unreadable, on files that read perfectly on any developer's
 * machine. One undifferentiated failure value is how a feature dies quietly.
 * Nothing acts on the reason; it is there so somebody can see it.
 */
export async function readEvidence(
  bytes: Buffer | Uint8Array,
  mimeType?: string,
): Promise<EvidenceRead> {
  if (!isEvidenceOcrEnabled()) return { failure: "disabled", result: null };

  if (isPdfEvidence(mimeType)) {
    const startedAt = Date.now();
    const text = await readPdfText(bytes);

    return text === null
      ? { failure: "empty", result: null }
      : {
          failure: null,
          result: {
            engine: "pdf-text",
            ms: Date.now() - startedAt,
            text,
            // A text layer has coordinates, but extracting them is a different
            // operation from extracting the text and nothing consumes them yet.
            words: [],
            },
        };
  }

  const mode = evidenceEngineMode();

  if (mode === "vision" || mode === "gemini" || mode === "vision+gemini") {
    /*
     * One preparation, whichever remote engine ends up reading it.
     *
     * Vision needs it. Gemini does not — it reads a raw phone screenshot fine —
     * but gets it anyway, because it bounds what is sent: `prepareForVision`
     * downscales and re-encodes, and every byte here becomes base64 in a JSON
     * body on a tier with a request-size limit. It also keeps the two remote
     * engines reading pixel-for-pixel the same image, which is the only way
     * comparing their answers — shadowed or fallen back to — means anything.
     */
    const prepared = await prepareForVision(bytes);

    // No decoder on this deployment. Distinct from an engine failure, and worth
    // saying so: it means `sharp` is missing, which breaks far more than this.
    if (!prepared) return { failure: "unknown", result: null };

    // Vision sniffs the bytes, but Gemini is told what it is being given — the
    // original's type when it passed through, PNG when it was re-encoded.
    if (mode === "gemini") return readWithGemini(prepared.bytes, prepared.mimeType);

    const vision = await readWithVision(prepared.bytes);

    if (mode === "vision" || !worthAskingTheOtherEngine(vision.failure)) {
      return vision;
    }

    /*
     * Loud on both sides, and deliberately so.
     *
     * A fallback that works silently is a fallback nobody notices is load-
     * bearing, and the bill for the engine that stopped answering keeps being
     * paid for months. These two lines are how somebody finds out that Vision
     * has been down since Tuesday while receipts kept reading fine.
     */
    console.error(
      `[evidence-fallback] vision returned nothing (${vision.failure}) — asking gemini`,
    );

    const gemini = await readWithGemini(prepared.bytes, prepared.mimeType);

    if (gemini.failure) {
      console.error(
        `[evidence-fallback] gemini returned nothing either (${gemini.failure}) — this file goes to a human`,
      );
    }

    return gemini;
  }

  /*
   * No engine is credentialled, so nothing looked at this image.
   *
   * Distinct from `unknown` on purpose. This module's governing rule is that a
   * read producing nothing must say *why* — the one time it did not, the
   * recogniser was dead in production for weeks and the only visible symptom
   * was residents being told their receipts were unreadable. "Nobody here is
   * configured to read this" is an operator's problem with an operator's fix,
   * and it must never reach anyone dressed up as a bad photograph.
   */
  return { failure: "not-configured", result: null };
}

/**
 * Whether a Vision non-answer is worth spending a second engine on.
 *
 * Everything except `empty`. `empty` is not a failure of Vision's at all — it
 * ran, it looked, and the page carries no text; that is a fact about the file,
 * and the correct response to it is not to ask a language model to look again at
 * a page already known to be blank, which is an invitation to find something
 * there that is not.
 *
 * Every other reason — no credential, a vendor error, a timeout, the monthly
 * breaker, an unhandled throw — means Vision did not answer the question, so the
 * question is still open and somebody else may as well be asked. The breaker is
 * on that list on purpose: `EVIDENCE_VISION_MONTHLY_CAP` bounds Vision's bill,
 * not the platform's ability to read a receipt, and Gemini has a cap of its own
 * so a runaway loop still hits a wall on the far side.
 */
function worthAskingTheOtherEngine(failure: EvidenceReadFailure | null): boolean {
  return failure !== null && failure !== "empty";
}

/**
 * The text on the evidence, or null when there is none to be had.
 *
 * The narrow contract every existing caller was written against, kept as a thin
 * wrapper so the engine swap is invisible to all of them. New callers that want
 * the word boxes or the failure reason should use {@link readEvidence}.
 */
export async function readEvidenceText(
  bytes: Buffer | Uint8Array,
  mimeType?: string,
): Promise<string | null> {
  return (await readEvidence(bytes, mimeType)).result?.text ?? null;
}

/** Devanagari digits, which Nepali banking apps mix into otherwise Latin text. */
const DEVANAGARI_DIGITS = "०१२३४५६७८९";

function normalizeDigits(value: string): string {
  return value.replace(/[०-९]/g, (digit) =>
    String(DEVANAGARI_DIGITS.indexOf(digit)),
  );
}

/**
 * Letters a recogniser produces where a digit was printed.
 *
 * Applied **only inside a run that already contains digits**, which is what keeps
 * it from inventing numbers: folding globally would turn the `S` of `Rs.` into a
 * 5 and put a spurious amount into the set.
 */
const DIGIT_CONFUSABLES: Record<string, string> = {
  B: "8",
  I: "1",
  O: "0",
  S: "5",
  l: "1",
  o: "0",
};

/** Every run of digits in the text, with thousands separators removed. */
function numbersIn(text: string): Set<string> {
  const normalized = normalizeDigits(text);
  const found = new Set<string>();

  for (const match of normalized.matchAll(/[\dOoIlBS][\dOoIlBS,\s]*(?:\.\d+)?/g)) {
    if (!/\d/.test(match[0])) continue;

    const raw = match[0]
      .replace(/[\s,]/g, "")
      .replace(/[OoIlBS]/g, (letter) => DIGIT_CONFUSABLES[letter] ?? letter);
    // A trailing `.00` is how every wallet prints a whole-rupee amount, and the
    // ledger holds whole rupees (ADR-1) — so both forms have to compare equal.
    const whole = raw.replace(/\.0+$/, "");

    found.add(whole);
    found.add(raw);
  }

  return found;
}

/** Uppercased and stripped of everything that is not a letter or digit. */
function canonical(value: string): string {
  return normalizeDigits(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * The same, with the letters a recogniser substitutes for digits folded back.
 *
 * **Measured, not assumed.** Asked to read `Transaction Code 8823119471` off a
 * clean 720×420 render, this engine returned `BB23118471`: two `8`s as `B`s and a
 * `9` as an `8`. Compared literally that is three mismatches, so a genuine
 * receipt reported "ID not on the image" — the exact false amber that teaches a
 * reviewer to stop reading flags.
 *
 * Applied to **both sides** of the comparison, so it cannot make two different
 * ids equal in only one direction, and used **only** for the transaction id. The
 * reference code must never be folded: its alphabet genuinely contains `B` and
 * `S`, and its check character is what makes a match trustworthy — folding would
 * destroy exactly the property being relied on.
 */
function canonicalDigits(value: string): string {
  return canonical(
    normalizeDigits(value)
      .toUpperCase()
      // `!` and `|` are what a thin `1` becomes; the rest are shape collisions.
      .replace(/[OQ]/g, "0")
      .replace(/[IL!|]/g, "1")
      .replace(/B/g, "8")
      .replace(/S/g, "5"),
  );
}

/**
 * Does `needle` appear in `haystack`, allowing for one misread character?
 *
 * **Measured, not assumed.** On a clean 720×420 synthetic receipt this
 * recogniser read `8823113471` for `8823119471` — a single 9→3 substitution on
 * text far crisper than a re-compressed phone screenshot. Exact substring
 * matching therefore reports "the ID is not on the image" for a genuine receipt,
 * which is a false amber on a real payment: not harmful, but it is the failure
 * that makes a reviewer stop reading the flags.
 *
 * One substitution, and only for ids of ten characters or more. The tolerance is
 * what makes it useful; the length floor is what keeps it safe — with a shorter
 * needle, one wildcard in a page of digits starts matching by chance, and a false
 * *confirmation* is the one outcome worse than a false amber, because it is the
 * signal a reviewer trusts without opening the file.
 */
function containsWithTolerance(haystack: string, needle: string): boolean {
  if (haystack.includes(needle)) return true;
  if (needle.length < 10) return false;

  const limit = haystack.length - needle.length;

  for (let start = 0; start <= limit; start += 1) {
    let mismatches = 0;

    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[start + index] !== needle[index]) {
        mismatches += 1;

        if (mismatches > 1) break;
      }
    }

    if (mismatches <= 1) return true;
  }

  return false;
}

export type ClaimFacts = {
  amount: number;
  referenceCode?: string | null;
  transactionCode?: string | null;
};

export type EvidenceTextMatch = {
  amountFound: boolean;
  /** The invoice's own reference code appears on the image. */
  referenceFound: boolean;
  /** The typed transaction id appears on the image. */
  transactionFound: boolean;
};

/**
 * Does the image say what the claim says?
 *
 * Pure and separately tested, because it carries the judgement while the
 * recognition above carries only the plumbing.
 *
 * The transaction id is matched on its canonical form — OCR keeps the characters
 * and loses the spacing, so `88 231 194 71` on a receipt has to match `8823119471`
 * as typed. Short ids are not matched at all: a five-character string appears by
 * chance in any page of digits, and a false confirmation is the one outcome worse
 * than no signal, since it is the signal a reviewer trusts.
 */
export function matchClaimFacts(text: string, facts: ClaimFacts): EvidenceTextMatch {
  const folded = canonicalDigits(text);
  const numbers = numbersIn(text);
  const typed = facts.transactionCode ? canonicalDigits(facts.transactionCode) : "";

  return {
    amountFound: numbers.has(String(facts.amount)),
    // The remarks field is free text, so the code may be spaced or hyphenated on
    // the image. The extractor validates the check character, which is what makes
    // a match here worth trusting.
    referenceFound: referenceOnEvidence(text, facts.referenceCode ?? ""),
    transactionFound: Boolean(
      typed.length >= 6 && containsWithTolerance(folded, typed),
    ),
  };
}

/**
 * Does *this invoice's* reference code appear on the evidence?
 *
 * Split out of {@link matchClaimFacts} because the claim form asks it on its own,
 * before there is a claim to match: the resident has uploaded a receipt and the
 * only question worth asking at that moment is whether they put the code in the
 * remarks. Same rule as the match — the code is never folded through the
 * confusable table, because its check character is the whole reason a hit is
 * worth believing.
 */
export function referenceOnEvidence(text: string, referenceCode: string): boolean {
  if (!referenceCode) return false;

  return (
    canonical(text).includes(canonical(referenceCode)) ||
    extractReferenceCodes(text).includes(referenceCode)
  );
}

/**
 * What the receipt appears to say, for filling the form in *before* the resident
 * types it.
 *
 * The mirror image of {@link matchClaimFacts}: that function is given the facts
 * and asks whether the image agrees, this one is given only the image and asks
 * what the facts might be. Which makes it the more dangerous of the two — a wrong
 * guess here becomes a number the resident submits, so every field is optional
 * and anything ambiguous is left blank for them to fill. **A blank field costs a
 * resident ten seconds of typing; a confidently wrong one costs a rejected claim.**
 *
 * Nothing here is authoritative. The form marks these as read-from-screenshot and
 * every one stays editable, and the claim is still checked against the invoice by
 * the same rules as a hand-typed one.
 */
export type ExtractedClaimFields = {
  /** Whole rupees, if exactly one plausible amount could be identified. */
  amount?: number;
  /** The payment method the receipt's own branding implies. */
  method?: string;
  /** An invoice reference code found in a remarks field — check character verified. */
  referenceCode?: string;
  /** The provider's transaction id, if a labelled one was found. */
  transactionCode?: string;
};

/** Brand names on a receipt, in the vocabulary the claim form uses. */
const METHOD_MARKERS: [RegExp, string][] = [
  [/\besewa\b/i, "ESEWA"],
  [/\bkhalti\b/i, "KHALTI"],
  [/\bfone\s?pay\b/i, "FONEPAY"],
  [/\bconnect\s?ips\b/i, "BANK_TRANSFER"],
  [/\b(bank|nabil|nic asia|global ime|siddhartha|prabhu|kumari|sanima|machhapuchchhre|nmb)\b/i, "BANK_TRANSFER"],
];

/**
 * Labels that precede a transaction id on a Nepali wallet or bank receipt.
 *
 * Label-anchored rather than "the longest number on the image": a receipt is full
 * of long numbers — account numbers, phone numbers, dates, balances — and picking
 * one by shape would fill the field with the resident's own account number often
 * enough to be worse than leaving it empty.
 */
const ID_LABELS =
  /(?:transaction\s*(?:code|id|no\.?|number)|txn\s*(?:id|no\.?)?|reference\s*(?:code|no\.?|number|id)|ref\s*no\.?|rrn|trace\s*(?:id|no\.?)?|receipt\s*no\.?|purchase\s*order\s*id)\s*[:\-#]?\s*([A-Za-z0-9][A-Za-z0-9\-/]{4,})/i;

/**
 * Labels that precede the amount actually paid.
 *
 * Anchored for the same reason, and ordered: `total` beats `amount` beats a bare
 * currency marker, because a receipt showing a fee breakdown has several of the
 * latter and only one of the former.
 *
 * The bare `Amount :` form is last and matters most for PDFs — eSewa's own
 * `PAYMENT RECEIPT` export writes `Amount : 60.00` with no currency marker
 * anywhere on the page, so a currency-anchored rule alone reads nothing off the
 * one format whose numbers are exact.
 */
const AMOUNT_LABELS = [
  /(?:total\s*(?:amount|paid)?|amount\s*paid|paid\s*amount)\s*[:\-]?\s*(?:rs\.?|npr|रु)?\s*([\d,]+(?:\.\d{1,2})?)/i,
  /\b(?:rs\.?|npr|रु)\s*([\d,]+(?:\.\d{1,2})?)/i,
  /\bamount\s*[:\-]?\s*([\d,]+(?:\.\d{1,2})?)/i,
];

/**
 * Whole rupees from a recognised amount string, or null when it is not one.
 *
 * Fractional paisa are dropped rather than rounded: the ledger is whole rupees
 * (ADR-1) and `1,290.50` on a receipt means the resident paid 1,290 as far as
 * every downstream check is concerned. Anything absurd is discarded — a
 * mis-recognised balance running to eight digits must not become the amount.
 */
function toWholeRupees(raw: string): number | null {
  const value = Number.parseFloat(raw.replace(/,/g, ""));

  if (!Number.isFinite(value) || value <= 0 || value > 10_000_000) {
    return null;
  }

  return Math.floor(value);
}

export function extractClaimFields(text: string): ExtractedClaimFields {
  const normalized = normalizeDigits(text);
  const fields: ExtractedClaimFields = {};

  for (const pattern of AMOUNT_LABELS) {
    const amount = pattern.exec(normalized)?.[1];
    const rupees = amount ? toWholeRupees(amount) : null;

    if (rupees !== null) {
      fields.amount = rupees;
      break;
    }
  }

  const id = ID_LABELS.exec(normalized)?.[1]?.trim();

  // Run through the same plausibility rules the submit path applies. An id this
  // would refuse must not be pre-filled — offering the resident a value that
  // will be rejected the moment they press submit is worse than offering none.
  if (id && !transactionCodeProblem(id)) {
    fields.transactionCode = id;
  }

  const [reference] = extractReferenceCodes(text);

  if (reference) {
    fields.referenceCode = reference;
  }

  for (const [marker, method] of METHOD_MARKERS) {
    if (marker.test(text)) {
      fields.method = method;
      break;
    }
  }

  return fields;
}

/**
 * Is this a payment record at all?
 *
 * The question worth asking before any of the matching: a photograph of a wall, a
 * selfie or a screenshot of a chat is not evidence of anything, and telling the
 * resident so *while they are still on the form* is worth more than every flag in
 * this module put together — they can fix it in ten seconds, and the reviewer
 * never sees it.
 *
 * **Signals, not a classifier.** No model is trained here and none is needed: a
 * payment receipt from any Nepali wallet or bank carries an unmistakable
 * vocabulary, and things that are not receipts carry none of it. Four independent
 * families of evidence, and two must be present:
 *
 * 1. a provider's own name — eSewa, Khalti, Fonepay, ConnectIPS, a bank;
 * 2. a currency marker against a number — `Rs.`, `NPR`, `रु`;
 * 3. the vocabulary of a transaction — *transaction*, *reference*, *balance*,
 *    *successful*, *transferred*, *receipt*;
 * 4. a date, in any of the three formats these receipts use.
 *
 * Two, not one, because single signals genuinely appear by accident: a chat
 * screenshot where somebody typed "Rs. 2000", a photo with a date stamp. Two
 * families at once is the point where "this is not a receipt" stops being a guess.
 *
 * Never a rejection, by the same rule as everything else here. A resident whose
 * unusual receipt scores one is warned and submits anyway; the reviewer gets the
 * flag and the image.
 */
const RECEIPT_SIGNALS: [string, RegExp][] = [
  [
    "provider",
    /\b(esewa|khalti|fone\s?pay|connect\s?ips|ime\s?pay|prabhu\s?pay|bank|nabil|nic asia|global ime|siddhartha|kumari|sanima|machhapuchchhre|nmb|laxmi|everest bank)\b/i,
  ],
  ["currency", /(?:rs\.?|npr|रु)\s*[\d०-९]/i],
  [
    "vocabulary",
    /\b(transaction|txn|reference|ref\s*no|rrn|trace|balance|successful|success|paid|payment|transferred|transfer|receipt|voucher|statement|remarks|debited|credited)\b/i,
  ],
  [
    "date",
    /(\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{2,4}\b)/i,
  ],
];

/** How many signal families must appear before the image counts as a receipt. */
const RECEIPT_SIGNAL_FLOOR = 2;

export function receiptSignals(text: string): string[] {
  return RECEIPT_SIGNALS.filter(([, pattern]) => pattern.test(text)).map(
    ([name]) => name,
  );
}

export function looksLikePaymentReceipt(text: string): boolean {
  return receiptSignals(text).length >= RECEIPT_SIGNAL_FLOOR;
}

/**
 * How much text has to come off a file before its *absence* of receipt vocabulary
 * means anything.
 *
 * OCR on a dark or skewed photo returns a handful of stray characters, and zero
 * signals in twenty characters says nothing about the file — only about the read.
 * Below this floor the answer is "unread", which never blocks.
 */
const REFUSAL_TEXT_FLOOR = 40;

/**
 * The one text verdict that **refuses the claim outright**: this file is not a
 * payment document of any kind.
 *
 * Deliberately a rung below {@link looksLikePaymentReceipt}, and the gap between
 * them is the whole design. That function asks "can I vouch for this?" and needs
 * two signal families; a genuine but oddly-worded receipt scoring one is warned
 * about and still submitted, because refusing a resident's real proof is far worse
 * than making a reviewer look at an image. This asks the much narrower question
 * "is there *any* trace of a payment here?" — no provider, no currency against a
 * number, no transaction vocabulary, no date, in a page of text we definitely
 * read. A photo of a notebook, a selfie, a meme, a lecture slide. Nothing that
 * came out of a wallet or a bank scores zero on all four.
 *
 * So the screen has three outcomes, not two: accepted, accepted-with-a-warning,
 * and refused — and only the last is certain enough to stand in a resident's way.
 */
export function isDefinitelyNotPaymentEvidence(text: string | null): boolean {
  if (text === null) return false;

  // Whitespace stripped: OCR padding a mostly-blank image with newlines must not
  // buy its way over the floor.
  if (text.replace(/\s+/g, "").length < REFUSAL_TEXT_FLOOR) return false;

  return receiptSignals(text).length === 0;
}

/**
 * The claim's OCR flags: at most one amber per missing fact, or the single green
 * `CONFIRMED` when the image corroborates both halves of the claim.
 */
export function evidenceTextFlags(
  text: string | null,
  facts: ClaimFacts,
): string[] {
  if (text === null) {
    // Not "unreadable" — unread. The caller distinguishes this from a decoded
    // image with no text in it, because only one of the two says anything about
    // the evidence.
    return [];
  }

  const match = matchClaimFacts(text, facts);

  // Asked first, because it is the more useful thing to be told: "this is not a
  // payment record" is actionable, while "the amount does not match" on a photo of
  // a wall is technically true and no help to anybody.
  if (!looksLikePaymentReceipt(text)) {
    return [OCR_FLAGS.NOT_A_RECEIPT];
  }

  if (!match.amountFound && !match.transactionFound && !match.referenceFound) {
    // A receipt by its vocabulary, but nothing on it corresponds to this claim —
    // most often last month's, or a receipt for something else entirely.
    return [OCR_FLAGS.NO_TEXT];
  }

  const flags: string[] = [];

  if (!match.amountFound) flags.push(OCR_FLAGS.AMOUNT_ABSENT);
  if (!match.transactionFound && !match.referenceFound) {
    flags.push(OCR_FLAGS.REFERENCE_ABSENT);
  }

  if (flags.length > 0) return flags;

  // Reported alongside the confirmation rather than instead of it, so a reviewer
  // reading the flags can tell the strong case from the merely consistent one.
  return match.referenceFound
    ? [OCR_FLAGS.CONFIRMED, OCR_FLAGS.REFERENCE_ON_IMAGE]
    : [OCR_FLAGS.CONFIRMED];
}
