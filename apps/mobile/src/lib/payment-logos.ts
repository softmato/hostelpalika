/**
 * Which logo a payment name or provider code resolves to.
 *
 * ## Why a resolver and not a lookup
 *
 * The provider codes are an enum — `ESEWA`, `KHALTI`, `FONEPAY` — and a map
 * would do. Bank names are not. `PayMethod.bankName` is **free text an owner
 * typed into their payment setup**, and the same institution arrives as
 * "Everest Bank", "Everest Bank Ltd", "Everest Bank Limited", "everest bank
 * ltd." or "EBL" depending on who filled the form. A statement import carries
 * whatever the bank wrote in its own export. Exact-matching any of those means
 * matching none of them.
 *
 * So this normalises, then matches on **distinctive words**.
 *
 * ## Matching is by whole words, longest phrase first
 *
 * Two rules, and both are load-bearing:
 *
 * 1. **Whole words, not substrings.** `nic` as a substring matches "technical";
 *    `sbi` matches nothing sensible but would if a bank were ever called
 *    "Sbicorp". A pattern matches only when its words appear as a contiguous
 *    run of the name's own words.
 * 2. **Longest phrase wins.** Four pairs in this list are prefixes of each
 *    other, and every one of them is a real bank that would otherwise be shown
 *    a competitor's mark:
 *
 *    | Name | Would wrongly match |
 *    | --- | --- |
 *    | Prabhu Mahalaxmi Bank | Prabhu Bank |
 *    | Siddhartha Women's Bikas Bank | Siddhartha Bank |
 *    | Nabil Bank (Formerly NCB) | Nabil Bank |
 *    | Womi Microfinance | Suryodaya Womi |
 *
 *    Sorting candidates by word count means the specific one is tested first.
 *
 * A name that matches nothing returns `null`, and the caller draws a glyph.
 * That is the whole point of returning a key rather than an image: **a wrong
 * bank logo on a screen telling somebody where to send money is worse than no
 * logo at all**, and this file is the only place that decision is made.
 *
 * ## Why this is a key and not a `require()`
 *
 * Vitest runs node-side with no Metro asset pipeline, so a module that
 * `require()`s a PNG cannot be imported by a test. The registry lives in
 * `components/ui/wallet-mark.tsx`; the matching — the part with the bugs in it —
 * lives here and is tested.
 */

/**
 * Every mark the app ships, as its asset slug.
 *
 * The three wallets came from the owner on 2026-09-05; the fifty banks were
 * extracted the same day from the Nepal Rastra Bank licensee sheet they
 * supplied. `wallet-mark.tsx` holds one `require()` per key and the compiler
 * checks the two lists agree.
 */
export const PAYMENT_LOGO_KEYS = [
  // Wallets and gateways.
  "esewa",
  "fonepay",
  "khalti",
  // Commercial banks.
  "agricultural-development",
  "citizens",
  "everest",
  "global-ime",
  "himalayan",
  "kumari",
  "laxmi-sunrise",
  "machhapuchchhre",
  "nabil",
  "nabil-ncb",
  "ncc",
  "nepal-bank",
  "nepal-investment-mega",
  "nepal-rastra",
  "nepal-sbi",
  "nic-asia",
  "nmb",
  "prabhu",
  "prime-commercial",
  "sanima",
  "siddhartha",
  "standard-chartered",
  // Development banks and finance companies.
  "ambe",
  "bank-of-kathmandu",
  "century-commercial",
  "civil",
  "development-credit",
  "garima",
  "janata",
  "jyoti",
  "kamana-sewa",
  "lumbini",
  "muktinath",
  "national-development",
  "prabhu-mahalaxmi",
  "shangri-la",
  "swbbl",
  // Laghubitta / microfinance.
  "asha",
  "chhimek",
  "deprosc",
  "first-microfinance",
  "forward-community",
  "grameen-bikas",
  "infinity",
  "mithila",
  "nerude",
  "sana-kisan",
  "suryodaya-womi",
  "suva",
  "womi",
] as const;

export type PaymentLogoKey = (typeof PAYMENT_LOGO_KEYS)[number];

/**
 * Banks an owner picks from when they add an account — Nepal's commercial
 * banks, then the development banks we hold a mark for. Picking one spells the
 * name the way `resolvePaymentLogoKey` already reads, so the logo follows it;
 * the field still takes free text for anyone else.
 */
export const BANK_NAMES = [
  "Nabil Bank",
  "NIC Asia Bank",
  "Global IME Bank",
  "Nepal Investment Mega Bank",
  "Himalayan Bank",
  "Everest Bank",
  "Kumari Bank",
  "Laxmi Sunrise Bank",
  "Machhapuchchhre Bank",
  "NMB Bank",
  "Prabhu Bank",
  "Prime Commercial Bank",
  "Sanima Bank",
  "Siddhartha Bank",
  "Citizens Bank International",
  "Nepal SBI Bank",
  "Standard Chartered Bank Nepal",
  "Nepal Bank",
  "Agricultural Development Bank",
  "Rastriya Banijya Bank",
  "Garima Bikas Bank",
  "Jyoti Bikas Bank",
  "Kamana Sewa Bikas Bank",
  "Lumbini Bikas Bank",
  "Muktinath Bikas Bank",
  "Shangri-la Development Bank",
] as const;

/**
 * The words a bank's name is recognised by, per key.
 *
 * Deliberately *not* the full registered name. "Everest Bank Limited" and
 * "Everest Bank Ltd." differ only in noise, and the distinctive part of both is
 * the single word `everest`. Abbreviations owners actually type — `ADBL`,
 * `BOK`, `NIMB` — are listed beside the words because they are what appears in
 * a payment-setup field somebody filled in a hurry.
 *
 * Every entry is matched word-wise, so a one-word pattern like `nic` cannot
 * fire inside a longer word.
 */
const PATTERNS: Record<PaymentLogoKey, readonly string[]> = {
  "agricultural-development": ["agricultural development", "adbl"],
  ambe: ["ambe"],
  asha: ["asha"],
  "bank-of-kathmandu": ["bank of kathmandu", "bank of kathmanda", "bok"],
  "century-commercial": ["century"],
  chhimek: ["chhimek", "chimek"],
  citizens: ["citizens"],
  civil: ["civil"],
  deprosc: ["deprosc", "deprox"],
  "development-credit": ["development credit"],
  esewa: ["esewa", "e sewa"],
  everest: ["everest", "ebl"],
  "first-microfinance": ["first microfinance"],
  fonepay: ["fonepay", "fone pay"],
  "forward-community": ["forward community", "forward"],
  garima: ["garima"],
  "global-ime": ["global ime", "globalime", "global"],
  "grameen-bikas": ["grameen"],
  himalayan: ["himalayan", "hbl"],
  infinity: ["infinity"],
  janata: ["janata"],
  jyoti: ["jyoti"],
  "kamana-sewa": ["kamana"],
  khalti: ["khalti"],
  kumari: ["kumari"],
  "laxmi-sunrise": ["laxmi sunrise", "laxmi", "sunrise"],
  lumbini: ["lumbini"],
  machhapuchchhre: [
    "machhapuchchhre",
    "machhapuchhre",
    "machhapuchchre",
    "machapuchhre",
    "mbl",
  ],
  mithila: ["mithila"],
  muktinath: ["muktinath"],
  nabil: ["nabil"],
  "nabil-ncb": ["nabil bank formerly ncb", "formerly ncb"],
  "national-development": ["national development"],
  ncc: ["ncc"],
  "nepal-bank": ["nepal bank"],
  "nepal-investment-mega": [
    "nepal investment mega",
    "nepal investment",
    "investment mega",
    "nimb",
  ],
  "nepal-rastra": ["nepal rastra", "rastra bank", "rastriya bank", "nrb"],
  "nepal-sbi": ["nepal sbi", "sbi"],
  nerude: ["nerude"],
  "nic-asia": ["nic asia", "nic"],
  nmb: ["nmb"],
  prabhu: ["prabhu"],
  "prabhu-mahalaxmi": ["prabhu mahalaxmi", "mahalaxmi"],
  "prime-commercial": ["prime commercial", "prime"],
  "sana-kisan": ["sana kisan"],
  sanima: ["sanima"],
  "shangri-la": ["shangri la", "shangrila"],
  siddhartha: ["siddhartha", "sidhartha"],
  "standard-chartered": ["standard chartered", "scb"],
  "suryodaya-womi": ["suryodaya womi", "suryodaya"],
  suva: ["suva"],
  swbbl: ["siddhartha womens bikas", "siddhartha women", "swbbl"],
  womi: ["womi microfinance"],
};

/**
 * Words that carry no identity and are dropped before matching.
 *
 * `bank` is **not** here, and that is deliberate: "Bank of Kathmandu" is
 * identified by the phrase, and dropping `bank` would leave "of kathmandu".
 * `nepal` is not here either — three different institutions are told apart by
 * where it falls ("Nepal Bank", "Nepal SBI", "Nepal Rastra").
 */
const NOISE = new Set([
  "co",
  "company",
  "limited",
  "ltd",
  "private",
  "pvt",
]);

/**
 * Lowercase, strip everything that is not a letter or digit, drop noise words.
 *
 * Punctuation goes rather than becoming a separator boundary problem:
 * "Shangri-La" and "Shangri La" have to normalise the same, and so do
 * "Women's" and "Womens". Devanagari is stripped along with it — the source
 * sheet writes "Rastra Bank (नेपाल राष्ट्र बैंक)" and the Latin half is enough
 * to identify it.
 */
export function normalisePaymentName(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    /*
     * Apostrophes are *deleted*, not turned into a separator.
     *
     * The generic strip below replaces every non-alphanumeric run with a space,
     * which turns "Women's" into the two words `women` and `s` — and the bank
     * whose registered name is "Siddhartha Women's Bikas Bank" then failed to
     * match its own pattern. Both the typewriter and the curly apostrophe, since
     * a name pasted out of a document carries the curly one.
     */
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0 && !NOISE.has(word));
}

/** Whether `needle`'s words appear as a contiguous run inside `words`. */
function containsPhrase(words: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > words.length) {
    return false;
  }

  for (let start = 0; start <= words.length - needle.length; start += 1) {
    let hit = true;

    for (let offset = 0; offset < needle.length; offset += 1) {
      if (words[start + offset] !== needle[offset]) {
        hit = false;
        break;
      }
    }

    if (hit) {
      return true;
    }
  }

  return false;
}

/**
 * Every pattern, flattened and ordered most-specific first.
 *
 * Built once at module load rather than per call: the resolver runs on every
 * row of a statement, and re-sorting two hundred patterns per row is the kind
 * of thing that only shows up on the phone with the slowest CPU.
 *
 * The sort is by **word count** descending, then by character length. Word
 * count is what actually decides the four prefix collisions documented at the
 * top of this file; character length is only a tiebreak so the order is stable.
 */
const RANKED: readonly { key: PaymentLogoKey; words: string[] }[] = Object.entries(
  PATTERNS,
)
  .flatMap(([key, patterns]) =>
    patterns.map((pattern) => ({
      key: key as PaymentLogoKey,
      words: pattern.split(" "),
    })),
  )
  .sort(
    (left, right) =>
      right.words.length - left.words.length ||
      right.words.join("").length - left.words.join("").length,
  );

/**
 * The logo for a bank name, a wallet name, or a provider enum — or `null`.
 *
 * Takes anything the product actually holds: `"ESEWA"`, `"BANK_TRANSFER"`,
 * `"Everest Bank Limited"`, `"nabil bank ltd."`. `BANK_TRANSFER`, `CASH` and
 * `OTHER` resolve to `null` on purpose — they are categories, not institutions,
 * and the caller draws a glyph for them.
 */
export function resolvePaymentLogoKey(
  value: string | null | undefined,
): PaymentLogoKey | null {
  if (!value) {
    return null;
  }

  const words = normalisePaymentName(value);

  if (words.length === 0) {
    return null;
  }

  for (const candidate of RANKED) {
    if (containsPhrase(words, candidate.words)) {
      return candidate.key;
    }
  }

  return null;
}
