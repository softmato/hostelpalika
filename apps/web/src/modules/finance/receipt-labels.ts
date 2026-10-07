import type { ExpenseCategoryKey } from "@hostel/shared/expenses/categories";

/**
 * Two labels the share sheet pre-fills from a receipt's text: what an expense
 * was for, and which bank sent the money. Both are suggestions on an editable
 * form — the sheet marks them "Auto" — so a miss costs one tap, and a wrong
 * guess is worse than none: when in doubt these return null and the sheet keeps
 * its default.
 */

/** Billers whose name alone says what the money was for. Safe to find anywhere on the page. */
const BILLERS: [RegExp, ExpenseCategoryKey][] = [
  [/\b(nea|nepal electricity authority)\b/i, "ELECTRICITY"],
  [/\b(kukl|kathmandu upatyaka khanepani|khanepani)\b/i, "WATER"],
  [/\b(worldlink|world link|vianet|subisu|classic tech|dishhome|dish home|ntc ftth|techminds)\b/i, "INTERNET"],
  [/\b(bhat-?bhateni|big mart|salesway|daraz mart)\b/i, "GROCERIES"],
];

/**
 * Words a person types as the purpose of a payment. Only read from the
 * receipt's remarks and payee: on the rest of the page "Bill Payment",
 * "Service charge" and bank boilerplate would match nearly every rule.
 */
const WORDS: [RegExp, ExpenseCategoryKey][] = [
  [/\b(electricity|bijuli|light bill)\b/i, "ELECTRICITY"],
  [/\b(water|jar|tanker|khanepani)\b/i, "WATER"],
  [/\b(internet|wi-?fi|broadband|ftth)\b/i, "INTERNET"],
  [/\b(gas|lpg|cylinder)\b/i, "GAS"],
  [/\b(salary|salaries|wages?|talab|tankha|payroll)\b/i, "SALARY"],
  [/\b(rent|bhada|bhaada)\b/i, "RENT"],
  [/\b(vegetables?|veg|tarkari|sabji|meat|masu|chicken|mutton|buff|fish|eggs?|fruits?)\b/i, "VEGETABLES_MEAT"],
  [/\b(grocer(?:y|ies)|kirana|mart|rice|chamal|dal|daal|oil|ration)\b/i, "GROCERIES"],
  [/\b(repair|plumb(?:er|ing)|electrician|maintenance|marmat|hardware|paint)\b/i, "REPAIR"],
  [/\b(clean(?:ing|er)?|sweeper|detergent|phenyl|laundry|safai)\b/i, "CLEANING"],
];

export function receiptCategory(
  text: string | null,
  receipt: { payee: string | null; remarks: string | null },
): ExpenseCategoryKey | null {
  const typed = [receipt.remarks, receipt.payee].filter(Boolean).join(" \n ");

  for (const [pattern, category] of WORDS) {
    if (typed && pattern.test(typed)) return category;
  }

  for (const [pattern, category] of BILLERS) {
    if (text && pattern.test(text)) return category;
  }

  return null;
}

/**
 * The commercial banks the sheet carries a logo for, keyed as the mobile app's
 * `payment-logos` keys so both draw the same mark.
 */
const BANKS: [RegExp, string, string][] = [
  [/\bnabil\b/i, "nabil", "Nabil Bank"],
  [/\bnic\s*asia\b/i, "nic-asia", "NIC Asia"],
  [/\bglobal\s*ime\b/i, "global-ime", "Global IME"],
  [/\bhimalayan\s+bank\b/i, "himalayan", "Himalayan Bank"],
  [/\bkumari\s+bank\b/i, "kumari", "Kumari Bank"],
  [/\b(laxmi\s+sunrise|laxmi\s+bank|sunrise\s+bank)\b/i, "laxmi-sunrise", "Laxmi Sunrise"],
  [/\bmachh?apuchh?h?re\b/i, "machhapuchchhre", "Machhapuchchhre"],
  [/\bnepal\s+bank\b/i, "nepal-bank", "Nepal Bank"],
  [/\b(nepal\s+investment|nimb|mega\s+bank)\b/i, "nepal-investment-mega", "NIMB"],
  [/\b(nepal\s+sbi|sbi\s+bank)\b/i, "nepal-sbi", "Nepal SBI"],
  [/\bnmb\b/i, "nmb", "NMB Bank"],
  [/\bprabhu\s+bank\b/i, "prabhu", "Prabhu Bank"],
  [/\bprime\s+(commercial|bank)\b/i, "prime-commercial", "Prime Bank"],
  [/\bsanima\b/i, "sanima", "Sanima Bank"],
  [/\bsiddhartha\s+bank\b/i, "siddhartha", "Siddhartha Bank"],
  [/\bstandard\s+chartered\b/i, "standard-chartered", "Standard Chartered"],
  [/\beverest\s+bank\b/i, "everest", "Everest Bank"],
  [/\bcitizens\s+bank\b/i, "citizens", "Citizens Bank"],
  [/\b(agricultural\s+development|adbl)\b/i, "agricultural-development", "ADBL"],
];

/**
 * The bank named first on the page — on a bank's own receipt that is the bank
 * that issued it, which is the one the money left from. Null when none is named.
 */
export function receiptBank(text: string | null): { key: string; name: string } | null {
  if (!text) return null;

  let best: { at: number; key: string; name: string } | null = null;

  for (const [pattern, key, name] of BANKS) {
    const at = text.search(pattern);
    if (at !== -1 && (best === null || at < best.at)) best = { at, key, name };
  }

  return best ? { key: best.key, name: best.name } : null;
}
