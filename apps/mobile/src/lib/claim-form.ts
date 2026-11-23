/**
 * What has to be true before a payment claim is worth sending.
 *
 * Its own module so it can be tested — Vitest here is node-side with no React
 * Native shim, so nothing importing a component can be.
 *
 * The rules mirror `claim.validation.ts` on the server rather than inventing
 * softer ones. That is the point: the submit endpoint is rate-limited to **8 an
 * hour** because every call runs OCR over a full-size screenshot, so a client
 * that lets an invalid claim through burns one of a resident's eight attempts
 * to be told something the phone already knew.
 */

export type ClaimDraft = {
  amount: string;
  /**
   * One of `CLAIM_METHODS`, or `null` when the resident has not chosen yet.
   *
   * Typed as a bare string rather than importing `PaymentMethod` from
   * `finance-api`: that module pulls in the axios client, and this one has to
   * stay node-testable. The values are the same six, listed below.
   */
  method: string | null;
  proofAssetId: string | null;
  transactionCode: string;
};

export type ClaimErrors = Partial<Record<keyof ClaimDraft, string>>;

/** The server's `PAYMENT_METHODS`. No `CHEQUE`; `OTHER` is real. */
export const CLAIM_METHODS = [
  { label: "eSewa", value: "ESEWA" },
  { label: "Khalti", value: "KHALTI" },
  { label: "Fonepay", value: "FONEPAY" },
  { label: "Bank transfer", value: "BANK_TRANSFER" },
  { label: "Cash", value: "CASH" },
  { label: "Other", value: "OTHER" },
] as const;

/**
 * The `Method` select's own value for "read it off my receipt", and its default.
 *
 * Not a payment method and never sent to the server — {@link resolveClaimMethod}
 * turns it into one. It leads the list because **we are better at this than the
 * resident is**: the receipt names its own issuer and the server reads it off a
 * known layout, while the resident is picking from memory, in an app that is not
 * the one they paid with. That is exactly how a Khalti receipt gets filed as
 * eSewa, which sends the hostel looking through the wrong statement and earns an
 * amber flag nobody needed.
 */
export const AUTO_METHOD = "AUTO";

/**
 * What the resident actually declared, given the select's value and what the
 * receipt turned out to say.
 *
 * Kept apart from the select's own value deliberately: the trigger has to keep
 * showing `Auto` after a receipt resolves to eSewa, or the setting changes under
 * the resident and their *next* upload is locked to the app the *last* one
 * happened to be.
 *
 * Returns null for `Auto` with nothing read yet — an honest "we do not know",
 * which the screen asks about rather than guessing. A default here would put a
 * wallet payment the resident never made onto their own record.
 *
 * A detected value that is not one of the six is discarded rather than passed
 * through: it would be refused at the boundary, and being refused for a method
 * nobody chose is the least explicable rejection on this screen.
 */
export function resolveClaimMethod(
  selection: string,
  detected: string | null | undefined,
): string | null {
  if (selection !== AUTO_METHOD) {
    return selection;
  }

  const known = CLAIM_METHODS.some((option) => option.value === detected);

  return known ? (detected as string) : null;
}

/**
 * Where the transaction id actually is, per app.
 *
 * The same navigation the web form carries, because it is the same six apps and
 * the same question. Written out rather than illustrated: the annotated
 * screenshots the mockup asks for do not exist yet, and prose is the part that
 * goes stale slowest. When the images land they belong above these steps.
 */
export const WHERE_TO_LOOK: Record<string, string[]> = {
  BANK_TRANSFER: [
    "Open your bank's app and go to your statement or transaction history.",
    "Tap the transfer you just made.",
    "The ID is the long number labelled Reference No, Transaction ID or RRN.",
  ],
  ESEWA: [
    "Open eSewa and tap the menu, then Transaction History.",
    "Tap the payment you just made.",
    "The ID sits at the top, labelled Transaction Code — it looks like 8823119471.",
  ],
  FONEPAY: [
    "Open the app you scanned the QR with and find its transaction history.",
    "Tap the payment you just made.",
    "Use the number labelled Transaction ID, Trace ID or Reference.",
  ],
  KHALTI: [
    "Open Khalti and tap Transactions at the bottom.",
    "Tap the payment you just made.",
    "The ID is shown as Transaction ID or Purchase Order ID.",
  ],
  OTHER: [
    "Find the payment in whatever app or receipt you paid with.",
    "Use whichever number it calls a transaction, reference or receipt ID.",
  ],
};

/** The steps for a method, falling back to the generic ones. */
export function whereToLook(method: string | null): string[] {
  return (method && WHERE_TO_LOOK[method]) || WHERE_TO_LOOK.OTHER;
}

/**
 * A submit the server refused outright, as something worth putting on a screen.
 *
 * These never reach the owner's review queue, so this is the only place the
 * resident learns anything — which is why it names what collided and when, and
 * leaves them on a form they can correct rather than sending them back a step.
 */
export type ClaimRejection = { detail: string; title: string };

/** What the server attaches to an instant rejection (§11.3). */
export type ClaimRejectionDetails = {
  priorPeriod?: string | null;
  priorSubmittedAt?: string | null;
  transactionCode?: string | null;
};

/**
 * Turns a refused submit into the rejection card, or null when it is an ordinary
 * failure that belongs in a toast.
 *
 * Branching on `errorCode`, never on the message text: the codes are the stable
 * contract and the copy is not.
 *
 * `describe` is injected rather than imported so this module stays free of the
 * calendar — the phone renders a Bikram Sambat month and node-side tests do not
 * need to. Everything a rejection says about *when* comes through it.
 */
export function claimRejection(
  errorCode: string | null,
  message: string,
  details: ClaimRejectionDetails | null,
  describe: { day: (iso: string) => string; month: (period: string) => string },
): ClaimRejection | null {
  const when = details?.priorSubmittedAt
    ? `It was submitted on ${describe.day(details.priorSubmittedAt)}`
    : "It was already submitted";
  const forWhat = details?.priorPeriod
    ? ` for ${describe.month(details.priorPeriod)} rent.`
    : ".";

  switch (errorCode) {
    case "EVIDENCE_ALREADY_USED":
      return {
        detail: `${when}${forWhat} Please upload the screenshot for THIS payment. If you think this is a mistake, speak to your hostel.`,
        title: "This screenshot was already used",
      };

    case "EVIDENCE_NOT_READABLE":
      return {
        detail:
          "It is blank or too small to read. Please upload the screenshot from the app you paid with — the one showing the amount and the transaction ID.",
        title: "That image cannot be read",
      };

    case "EVIDENCE_NOT_A_PAYMENT":
      return {
        detail:
          "There is no app name, no amount and no transaction ID on it. Please upload the screenshot or receipt from the app you paid with — the one showing the money leaving your account.",
        title: "That is not a payment receipt",
      };

    /*
     * Both of these carry the server's own sentence, verbatim. It names the
     * account or the direction it actually read — which of the three refusals
     * fired, and against what — and a fixed string here could only say something
     * vaguer about the resident's own file.
     */
    case "EVIDENCE_WRONG_TRANSACTION":
      return { detail: message, title: "This receipt cannot be used as proof" };

    case "EVIDENCE_IS_SYSTEM_DOCUMENT":
      return { detail: message, title: "That is a receipt we issued" };

    case "TXN_ID_ALREADY_CLAIMED":
      return {
        detail: `${details?.transactionCode ?? "That ID"} was ${
          details?.priorPeriod
            ? `used for ${describe.month(details.priorPeriod)} rent`
            : "already recorded"
        }. Each payment has its own ID.`,
        title: "Transaction ID already recorded",
      };

    default:
      return null;
  }
}

/**
 * A file the *upload* refused, as something worth putting on a screen.
 *
 * The gap this closes: {@link claimRejection} covers everything the server
 * decides about a file it accepted, and there was nothing at all for the files
 * it never accepted. `/files/{id}/complete` re-reads the stored object and turns
 * away an image it cannot decode, a type that is not what was declared, and
 * bytes that do not match — and on this screen that arrived as a cleared preview
 * and a toast that scrolls away. The resident was left looking at an empty
 * dropzone with no idea what was wrong with the photo they just chose, which is
 * how somebody picks the same bad file twice.
 *
 * Same shape and same rules as {@link claimRejection}: branch on the code, never
 * on the copy, and say what to do next rather than what went wrong internally.
 */
export function uploadRejection(
  errorCode: string | null,
  message: string,
): ClaimRejection | null {
  switch (errorCode) {
    /*
     * Refused at presign, before a byte moved: these bytes are already behind a
     * payment here. The server's sentence names it ("You already sent this
     * receipt for Rs 5,000 for Poush 2083 BS"), which no fixed copy can (ch 35).
     */
    case "EVIDENCE_ALREADY_USED":
      return { detail: message, title: "This receipt was already used" };

    /*
     * A file with an image extension whose bytes are not a decodable image —
     * a truncated download, a half-copied file, a renamed document. Worth its
     * own sentence because "damaged" is a thing the resident can check, and
     * re-picking the same file will fail identically.
     */
    case "UPLOAD_IMAGE_UNDECODABLE":
      return {
        detail:
          "It may be damaged, or it may not be a picture at all. Try taking the screenshot again, or send your bank's PDF receipt instead.",
        title: "That image could not be opened",
      };

    /*
     * The stored object contradicts what the phone declared at presign. Almost
     * always a file type we do not accept wearing the wrong extension.
     */
    case "UPLOAD_TYPE_MISMATCH":
      return {
        detail:
          "We accept a JPEG, PNG or WebP screenshot, or a PDF receipt. Please pick one of those.",
        title: "That kind of file is not supported",
      };

    /*
     * Refused at presign, before a byte moved — the earliest and commonest of
     * these, covering both a type we do not accept and a file over the size
     * limit.
     *
     * The server's own sentence is deliberately **not** passed through: for the
     * size case it reads "Image exceeds the 10485760 byte upload limit", and a
     * raw byte count is not something to put in front of a resident holding a
     * phone. One code carries both causes, so the copy names both — the action
     * is the same either way, and guessing which one fired by matching on the
     * message would be branching on prose the server is free to reword.
     */
    case "FILE_TYPE_NOT_ALLOWED":
      return {
        detail:
          "Please attach a JPEG, PNG or WebP screenshot, or a PDF receipt — and if it is a very large photo, a screenshot of the payment will be smaller.",
        title: "That file cannot be uploaded",
      };

    case "UPLOAD_SIZE_MISMATCH":
    case "UPLOAD_CONTENT_MISMATCH":
      return {
        detail:
          "The file changed while it was being sent, so we cannot vouch for it. Please attach it again.",
        title: "That upload did not arrive intact",
      };

    /*
     * The object is not in storage at all — the PUT never landed. Genuinely
     * worth retrying, unlike everything above it, so the wording asks for a
     * retry rather than a different file.
     */
    case "UPLOAD_NOT_FOUND":
    case "UPLOAD_UNREADABLE":
    case "UPLOAD_VERIFICATION_FAILED":
      return {
        detail: `${message} Please attach it again.`,
        title: "That upload did not finish",
      };

    /*
     * Everything else — a dropped connection, a 500, storage refusing the PUT.
     * Deliberately null: those are transient and the global upload toaster
     * already reports them with the reason. A second, permanent notice on the
     * screen would read as a second failure and send the resident looking for a
     * different file when the one they have is fine.
     */
    default:
      return null;
  }
}

/**
 * Methods where the transaction id is not optional.
 *
 * The server's `CODE_REQUIRED_METHODS`. Every one of these hands the payer a
 * reference on a confirmation screen, and without it a claim cannot be
 * reconciled against the provider's statement — it can only be believed. Cash
 * has no id to give and `OTHER` is the escape hatch for the case nobody
 * anticipated, so neither is required.
 */
const CODE_REQUIRED_METHODS = new Set([
  "BANK_TRANSFER",
  "ESEWA",
  "FONEPAY",
  "KHALTI",
]);

export function transactionCodeRequired(method: string | null): boolean {
  return method !== null && CODE_REQUIRED_METHODS.has(method);
}

/** Separators a resident might copy along with the id. Not part of its value. */
function canonicalize(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s\-_/.]/g, "");
}

/**
 * Words that are never an id, however they are decorated.
 *
 * Matched against the canonical form, so `test`, `TEST` and `t-e-s-t` are the
 * same entry. Checked as a whole-value equality *or* against the entire
 * alphabetic part — which for a value carrying digits is never equal to it, so
 * the second arm only ever fires on letters-only strings.
 *
 * That is narrow on purpose, and it is the server's rule verbatim. `TEST1234`
 * gets through, and so does a real `TESTA9481203` from a bank whose prefix
 * happens to contain those letters. Refusing a genuine reference is worse than
 * passing a fabricated one to a reviewer who can see the screenshot beside it.
 */
const PLACEHOLDERS = new Set([
  "ABC",
  "ASDF",
  "DEMO",
  "DUMMY",
  "FAKE",
  "NA",
  "NIL",
  "NONE",
  "NOTHING",
  "PAID",
  "QWERTY",
  "SAMPLE",
  "TEST",
  "TESTING",
  "UNKNOWN",
  "XXX",
  "YES",
]);

/**
 * The shortest a real reference can be. Six — wallet ids run eight to twenty
 * characters and the shortest bank reference seen in testing was seven digits.
 */
const MIN_CODE_LENGTH = 6;

function isRepeatedCharacter(value: string): boolean {
  return value.length > 1 && new Set(value).size === 1;
}

/** `123456`, `ABCDEF`, `654321` — a run of consecutive code points either way. */
function isSequentialRun(value: string): boolean {
  if (value.length < 3) return false;

  const step = value.charCodeAt(1) - value.charCodeAt(0);

  if (step !== 1 && step !== -1) return false;

  return value
    .split("")
    .every(
      (character, index) =>
        index === 0 || character.charCodeAt(0) - value.charCodeAt(index - 1) === step,
    );
}

/**
 * Why this cannot be a transaction id, or null when it could be.
 *
 * A port of the server's `transactionCodeProblem`, rule for rule and message for
 * message. Nothing here can tell a *fabricated* id from a real one — only the
 * provider knows that, and until statement reconciliation matches it against the
 * provider's own export the id is a resident's assertion. What it refuses is the
 * ids that cannot possibly be real: `dummy`, `1234`, `aaaa`, `paid`.
 *
 * **Shape-based rather than per-provider, deliberately.** eSewa, Khalti, Fonepay
 * and eighteen Nepali banks all format their references differently and change
 * them without telling anyone, so a per-provider regex would start rejecting
 * real payments the first time a provider added a character. Every rule is a
 * property no provider's id has ever had.
 *
 * The duplication with the server is the point rather than a smell: this is the
 * only way a resident learns about a placeholder id *before* it costs one of
 * their eight submits an hour. The server still checks — a client is not a
 * gate — and a divergence between the two shows up as the phone letting through
 * something the server refuses, which is the direction that fails safely.
 */
export function transactionCodeProblem(raw: string | null | undefined): string | null {
  const value = canonicalize(raw ?? "");

  if (!value) return null;

  if (value.length < MIN_CODE_LENGTH) {
    return "That transaction ID looks too short. Open the app you paid with and copy the full transaction or reference ID from the payment receipt.";
  }

  const letters = value.replace(/[^A-Z]/g, "");

  if (PLACEHOLDERS.has(value) || (letters === value && PLACEHOLDERS.has(letters))) {
    return "Please enter the real transaction ID from your payment receipt, not a placeholder.";
  }

  if (isRepeatedCharacter(value) || isSequentialRun(value)) {
    return "That does not look like a transaction ID. Open the app you paid with and copy the ID from the payment receipt.";
  }

  // Every provider's reference carries digits — a wallet id, a bank's serial, a
  // Fonepay trace. A purely alphabetic string is a word, and the word is
  // overwhelmingly "paid" or the resident's own name.
  if (!/[0-9]/.test(value)) {
    return "A transaction ID contains numbers. Open the app you paid with and copy the ID from the payment receipt.";
  }

  return null;
}

/**
 * Whole rupees only.
 *
 * Not a formatting preference — whole rupees are the ledger's foundation
 * (ADR-1) and the server rejects a fractional claim at the boundary rather than
 * rounding one three layers down. Catching it here means the resident sees
 * "whole rupees" next to the field instead of a 422 after the upload.
 */
export function parseClaimAmount(raw: string): number | null {
  const cleaned = raw.replace(/[\s,]/g, "");

  if (!/^\d+$/.test(cleaned)) {
    return null;
  }

  const value = Number(cleaned);

  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function validateClaim(draft: ClaimDraft): ClaimErrors {
  const errors: ClaimErrors = {};

  if (!draft.amount.trim()) {
    errors.amount = "Enter the amount you paid.";
  } else if (parseClaimAmount(draft.amount) === null) {
    errors.amount = "Enter a whole rupee amount, with no paisa.";
  }

  /*
   * No default.
   *
   * The field used to initialise to `BANK_TRANSFER`, so a resident who paid by
   * eSewa and never opened the select filed a claim asserting a bank transfer.
   * That is a wrong fact inside the evidence record — it sends the hostel
   * looking for the payment in the wrong statement, and OCR on the screenshot
   * then disagrees with the claim it is supposed to be corroborating.
   */
  if (!draft.method) {
    errors.method = "Choose how you paid.";
  }

  if (!draft.proofAssetId) {
    // The screenshot is the whole claim. Without it there is nothing for the
    // hostel to check against their statement, and the server refuses it.
    errors.proofAssetId = "Attach a screenshot or photo of your payment.";
  }

  const code = draft.transactionCode.trim();

  if (code.length > 120) {
    errors.transactionCode = "That transaction code is too long.";
  } else if (!code) {
    /*
     * Required for the four methods that issue one — `TXN_ID_REQUIRED` on the
     * server, and until this check existed the phone would send the claim, spend
     * one of the eight submits, and come back with the same sentence.
     *
     * Silent while the method is still unknown: `Auto` before a receipt has been
     * read has no answer yet, and demanding an id for a payment whose kind we
     * have not established is a red field nobody can clear.
     */
    if (transactionCodeRequired(draft.method)) {
      errors.transactionCode =
        "Enter the transaction ID from your payment. It is on the confirmation screen of the app you paid with.";
    }
  } else {
    /*
     * Only where the field is an id. For cash the same input is labelled "Who
     * did you give the cash to?" and holds a person's name, which fails every
     * shape rule by design — and `OTHER` is free text for the same reason.
     */
    const problem = transactionCodeRequired(draft.method)
      ? transactionCodeProblem(code)
      : null;

    if (problem) {
      errors.transactionCode = problem;
    }
  }

  return errors;
}

export function hasErrors(errors: ClaimErrors): boolean {
  return Object.keys(errors).length > 0;
}
