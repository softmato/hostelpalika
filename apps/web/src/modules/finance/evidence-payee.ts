/**
 * Who actually received the money.
 *
 * This is the check the whole claim pipeline was missing, and the reason it was
 * missing is worth stating plainly: **every other check verifies something the
 * payer controls.** The amount, the transaction ID, the reference code in the
 * remarks — a resident who sends 8,500 to a friend's wallet and types
 * `EDU-0002-P` in the remark box produces a receipt that satisfies all of them,
 * because all of them are true. The money is real, the receipt is real, the code
 * is real. It simply went to the wrong account, and the friend withdraws it while
 * the hostel books a payment it never received.
 *
 * The only field on that receipt the resident does *not* control is the payee. So
 * that is what this reads, and it compares it against the accounts the hostel
 * registered on its own payment profile — data from our database, not from the
 * image.
 *
 * **Three verdicts, and the asymmetry is deliberate.**
 *
 * - `MATCHED` — the payee is one of ours. The only genuinely corroborating
 *   signal in the system that a payer cannot manufacture.
 * - `FOREIGN` — a payee line was read cleanly and names somebody who is not us.
 *   **Refused at submission.** This is a positive read of a foreign identifier,
 *   not a failure to find ours, and the existing `WRONG_ACCOUNT` rejection reason
 *   says exactly this in the reviewer's vocabulary.
 * - `UNKNOWN` — no payee line, or nothing to compare it against. Amber. Never a
 *   refusal, and never green: it keeps the row out of `Approve all` and puts the
 *   image in front of a human.
 *
 * A hostel that has not filled in its payment profile gets `UNKNOWN` on every
 * claim rather than `FOREIGN` on every claim. A fraud control that refuses every
 * resident of an unconfigured hostel would be turned off inside a day.
 */

/** What a hostel's registered accounts look like once flattened for matching. */
export type HostelPayeeIdentity = {
  /**
   * Digits-only identifiers: eSewa/Khalti wallet numbers, bank account numbers.
   * Compared by suffix, because a receipt commonly masks the leading digits.
   */
  accountIds: string[];
  /** Every name the hostel is known by on a receipt — profile, bank, hostel. */
  names: string[];
};

export type PayeeVerdict = "FOREIGN" | "MATCHED" | "UNKNOWN";

export type PayeeRead = {
  /** What was on the payee line, as printed. Null when no line was found. */
  payeeOnEvidence: string | null;
  /** Which of our identifiers matched, for the reviewer's detail line. */
  matchedOn: string | null;
  verdict: PayeeVerdict;
};

type ProfileLike = {
  bankAccountName?: string | null;
  extraAccounts?: Array<{ accountName?: string | null; number?: string | null }> | null;
  bankAccountNumber?: string | null;
  bankName?: string | null;
  displayName?: string | null;
  esewaId?: string | null;
  khaltiId?: string | null;
  qrPayeeName?: string | null;
  qrPayeeNumber?: string | null;
};

/**
 * The hostel's accounts, flattened into the two things a receipt can be matched
 * against.
 *
 * `bankName` is **not** a payee name. It is the institution, not the account
 * holder, and including it would match every receipt drawn on that bank — which
 * for a hostel banking with NIC Asia means matching most of Kathmandu.
 */
export function hostelPayeeIdentity(
  profile: ProfileLike | null,
  hostelName?: string | null,
): HostelPayeeIdentity {
  // `qrPayeeName` is on equal footing with the typed fields on purpose: for a
  // hostel that uploaded a poster and filled in nothing else, it is the only
  // name we hold, and it is the name the receipt will print.
  const names = [
    profile?.displayName,
    profile?.bankAccountName,
    ...(profile?.extraAccounts ?? []).map((account) => account.accountName),
    profile?.qrPayeeName,
    hostelName,
  ]
    .map((value) => (value ?? "").trim())
    .filter((value) => value.length > 0);

  const accountIds = [
    profile?.esewaId,
    profile?.khaltiId,
    profile?.bankAccountNumber,
    ...(profile?.extraAccounts ?? []).map((account) => account.number),
    profile?.qrPayeeNumber,
  ]
    .map((value) => digitsOnly(value ?? ""))
    // Below eight digits an "account number" is not distinctive enough to
    // identify anyone — it would match a date, an amount or a page number.
    .filter((value) => value.length >= 8);

  return { accountIds, names };
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Words that carry no identifying power in a Nepali hostel's registered name.
 *
 * Without this list, `Sunrise Boys Hostel` and `Himalaya Boys Hostel` match on
 * `BOYS` and `HOSTEL` — which would turn the one check that cannot be forged into
 * one that passes for any hostel in the country.
 */
const NAME_STOPWORDS = new Set([
  "AND",
  "BOYS",
  "CO",
  "COMPANY",
  "GIRLS",
  "HOME",
  "HOSTEL",
  "HOSTELS",
  "HOUSE",
  "LIMITED",
  "LTD",
  "NEPAL",
  "PG",
  "PRIVATE",
  "PVT",
  "RESIDENCY",
  "THE",
]);

function nameTokens(value: string): string[] {
  return value
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter((token) => token.length >= 3 && !NAME_STOPWORDS.has(token));
}

/**
 * Labels that introduce the payee on a Nepali wallet or bank receipt.
 *
 * Label-anchored, and the labels are the *receiving* side only. `From`, `Sender`
 * and `Debited from` name the resident and matching on those would compare the
 * hostel's name against the resident's own — always a mismatch, and so a refusal
 * on every genuine claim.
 */
const PAYEE_LABELS =
  /(?:^|\n)\s*(?:sent\s+to|send\s+to|paid\s+to|pay\s+to|payment\s+to|transferred\s+to|transfer\s+to|credited\s+to|receiver(?:'s)?(?:\s+name)?|recipient(?:'s)?(?:\s+name)?|beneficiary(?:\s+name)?|payee(?:\s+name)?|(?:q\.?r\.?\s*)?merchant(?:\s+name)?|to)\s*[:\-–]\s*([^\n]{2,80})/i;

/**
 * The same labels again, for a receipt laid out as a **table**.
 *
 * Everest Bank's `Payment Receipt` is two columns with no punctuation between
 * them: `Qr Merchant Name` in one cell and `TEA TIME ANYTIME CAFETERIA` in the
 * next. Recognised, that becomes either a run of spaces or a line break — never
 * the colon the pattern above requires — so the payee on the commonest receipt in
 * Nepal was invisible, and a payment to a cafeteria read as *no payee found*.
 *
 * The bare `to` is deliberately **not** in this list. Without a colon to anchor
 * it, `to` matches the middle of any sentence on the page, and a payee read off a
 * footer is worse than no payee at all — this verdict can refuse a resident.
 */
const PAYEE_LABELS_TABULAR =
  /(?:^|\n)[ \t|]*(?:sent\s+to|paid\s+to|transferred\s+to|credited\s+to|receiver(?:'s)?(?:\s+name)?|recipient(?:'s)?(?:\s+name)?|beneficiary(?:\s+name)?|payee(?:\s+name)?|(?:q\.?r\.?\s*)?merchant(?:\s+name)?)[ \t|]*(?:\n[ \t|]*)?([^\n]{2,80})/i;

/**
 * The payee as printed, or null.
 *
 * Trailing account numbers and masks are kept on the line — they are part of the
 * identity and `matchesIdentity` searches the whole text for account digits
 * anyway. What is stripped is the punctuation a label leaves behind.
 */
export function extractPayee(text: string): string | null {
  // The punctuated form first: it is the more certain of the two, and on a
  // receipt carrying both a `Sent to:` line and a table the colon is the one
  // that was written as a label rather than inferred from a layout.
  const raw = (PAYEE_LABELS.exec(text)?.[1] ?? PAYEE_LABELS_TABULAR.exec(text)?.[1])
    ?.trim();

  if (!raw) return null;

  const cleaned = raw.replace(/\s{2,}/g, " ").replace(/[.,;]+$/, "").trim();

  // A line with no letters is an account number on its own, or a stray. It
  // identifies nobody by name, and calling it a foreign payee on that basis
  // would refuse a real receipt.
  return /[A-Za-zऀ-ॿ]/.test(cleaned) ? cleaned : null;
}

/**
 * Does this hostel's identity appear on the evidence?
 *
 * Two independent ways to match, either of which is enough:
 *
 * 1. **An account identifier**, searched across the whole text rather than the
 *    payee line, because receipts print the wallet number on its own row below
 *    the name. Matched on the last eight digits so a masked `98XXXXXX07` still
 *    identifies the account it belongs to — and never on fewer, because a
 *    four-digit suffix collides with an amount often enough to matter.
 * 2. **A distinctive name token** shared with the payee line.
 */
function matchesIdentity(
  text: string,
  payee: string | null,
  identity: HostelPayeeIdentity,
): string | null {
  const digits = digitsOnly(text);

  for (const accountId of identity.accountIds) {
    const suffix = accountId.slice(-8);

    if (suffix.length >= 8 && digits.includes(suffix)) {
      return accountId;
    }
  }

  if (!payee) return null;

  const payeeTokens = new Set(nameTokens(payee));

  for (const name of identity.names) {
    const tokens = nameTokens(name);

    if (tokens.length > 0 && tokens.some((token) => payeeTokens.has(token))) {
      return name;
    }

    // A registered name made entirely of stopwords — `The Boys Hostel` — has no
    // distinctive token to match on, so it falls back to the whole string. Rare,
    // and the alternative is that such a hostel can never reach `MATCHED`.
    if (
      tokens.length === 0 &&
      name.replace(/[^A-Za-z]/g, "").toUpperCase().length >= 4 &&
      payee.replace(/[^A-Za-z]/g, "").toUpperCase().includes(
        name.replace(/[^A-Za-z]/g, "").toUpperCase(),
      )
    ) {
      return name;
    }
  }

  return null;
}

/**
 * Who the evidence says was paid, judged against who the hostel says it is.
 *
 * Pure. The profile lookup happens in the caller so this stays testable against a
 * literal identity, and so one database read serves the claim path and the
 * resident's live form read alike.
 */
export function readPayeeOnEvidence(
  text: string | null,
  identity: HostelPayeeIdentity,
  /**
   * The payee read off this provider's own template, when one recognised the
   * document (`evidence-receipt.ts`).
   *
   * Preferred over the generic scan because it comes from a *named field* on a
   * *known layout* rather than from whichever label matched first, and the
   * difference matters most on the receipts where the generic scan is weakest —
   * a bank's two-column voucher, or a wallet card whose payee label this module
   * has never seen. Null whenever no template applied, which is most files.
   */
  templatePayee?: string | null,
): PayeeRead {
  if (!text) {
    return { matchedOn: null, payeeOnEvidence: null, verdict: "UNKNOWN" };
  }

  const payee = templatePayee?.trim() || extractPayee(text);

  // Nothing registered means nothing to compare against. Every claim is amber,
  // which is honest — we genuinely do not know where this hostel takes money —
  // and the setup screen is where that gets fixed.
  if (identity.accountIds.length === 0 && identity.names.length === 0) {
    return { matchedOn: null, payeeOnEvidence: payee, verdict: "UNKNOWN" };
  }

  const matchedOn = matchesIdentity(text, payee, identity);

  if (matchedOn) {
    return { matchedOn, payeeOnEvidence: payee, verdict: "MATCHED" };
  }

  // **The narrow condition for a refusal.** A payee line has to have been read,
  // with a real name on it, and none of our identifiers may appear anywhere on
  // the file. Absence of our name is not enough on its own — a receipt that
  // simply does not print a payee is common, and it is amber.
  if (payee) {
    return { matchedOn: null, payeeOnEvidence: payee, verdict: "FOREIGN" };
  }

  return { matchedOn: null, payeeOnEvidence: null, verdict: "UNKNOWN" };
}

/**
 * The refusal sentence for a payment made to somebody else, or null.
 *
 * Names the account the receipt shows, because the resident is about to be told
 * their payment does not count and the only thing that makes that bearable is
 * being told exactly what we read. Non-accusatory: paying an old account the
 * hostel has stopped using, or a warden's personal wallet on their say-so, is far
 * likelier than fraud — and both are things the resident needs to raise with the
 * hostel rather than fix on this form.
 */
export function payeeRefusal(read: PayeeRead): string | null {
  if (read.verdict !== "FOREIGN") return null;

  return `That receipt shows the money went to ${read.payeeOnEvidence}, which is not an account this hostel collects payments in. If you were asked to pay that account, please check with the hostel office before submitting — payments to any other account cannot be credited to your invoice.`;
}
