import "server-only";

import type { Presentation } from "@softmato/sdk";

import type { PlansConfig } from "@/modules/platform-config/site-config.validation";

/**
 * The plan, in our words, printed on Softmato's invoice and checkout page.
 *
 * This is the one place our own copy reaches a customer through the parent
 * company, and it is **presentation, never arithmetic** — nothing here can
 * change what is charged. The amount comes from the invoice line, stated once,
 * by them. That is the only reason they accept integrator text on a statutory
 * document at all.
 *
 * ## Why the rules are enforced here as well as there
 *
 * Softmato rejects a presentation block that breaks any of them, with a `422`
 * naming the field. Every string below comes from the Plans & Pricing
 * catalogue, which a platform owner edits in a form — so the day someone types
 * "Pro — Rs. 5,000/month" into a plan description, the API would refuse the
 * invoice and *the hostel could not pay us*. A billing flow that a marketing
 * edit can break is a billing flow that will break.
 *
 * So this trims, strips and drops rather than passing text through and hoping.
 * A dropped feature line is a slightly plainer invoice; a rejected invoice is
 * an owner who cannot give us money.
 *
 * The rules, from the SDK's own `Presentation` doc:
 *
 * - plain text — no HTML, no Markdown;
 * - 8 features, 120 characters each; 3 highlights, 60 each;
 * - **no prices anywhere**, in any notation;
 * - nothing promising anything about payment, refunds, or Softmato;
 * - omit it entirely and nothing renders — no plan name is invented for us.
 */

const LIMITS = {
  billingPeriod: 60,
  feature: 120,
  features: 8,
  highlight: 60,
  highlights: 3,
  planName: 80,
  tagline: 140,
} as const;

/**
 * Anything that could read as an amount of money.
 *
 * Deliberately wider than the API's own check. A false positive costs one
 * bullet point; a false negative costs the whole invoice, and the failure
 * arrives as a `422` at the moment an owner presses Pay.
 *
 * What it catches: a currency token in any of the forms used locally, the
 * `/-` suffix, and comma-grouped figures. What it lets through: a bare number,
 * so "Up to 500 beds" and "2 warden seats" survive — those are the feature
 * lines worth having, and a plain integer is not a price in any notation.
 */
const PRICE_PATTERNS: RegExp[] = [
  /\b(?:npr|nrs|inr|rs)\b\.?/i,
  /[₹﷼]|रु|रू/,
  /\d\s*\/-/,
  /\d{1,3}(?:,\d{3})+/,
  /\bper\s+(?:month|year|bed)\b/i,
];

/** Payment, refund and Softmato promises are not ours to make on their paper. */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /\brefund/i,
  /\bmoney[-\s]?back\b/i,
  /\bsoftmato\b/i,
  /\bfree\s+trial\b/i,
];

/**
 * Plain text, or nothing.
 *
 * HTML is stripped rather than escaped because Softmato escapes it on render —
 * a `<b>` sent from here arrives on the invoice looking like a typo, which is
 * worse than the emphasis being lost.
 */
function plain(value: string | null | undefined): string {
  if (!value) return "";

  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/[*_`#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isSafe(value: string): boolean {
  if (!value) return false;

  return (
    !PRICE_PATTERNS.some((pattern) => pattern.test(value)) &&
    !FORBIDDEN_PATTERNS.some((pattern) => pattern.test(value))
  );
}

/**
 * Clean, check, and cut to length.
 *
 * Truncation is at a word boundary with no ellipsis: a bullet ending in "…"
 * on a tax document reads as a rendering failure, and there is nowhere for the
 * reader to click to see the rest.
 */
function fit(value: string | null | undefined, max: number): string | null {
  const text = plain(value);

  if (!isSafe(text)) return null;
  if (text.length <= max) return text;

  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");

  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim() || null;
}

type PlanTier = PlansConfig["plans"][number];

/**
 * The feature lines, derived from what the plan actually grants.
 *
 * Caps rather than adjectives: an owner comparing the invoice to what they
 * bought should be able to check every line against their own account. `null`
 * on a cap means unlimited, which is worth saying out loud — an absent line
 * reads as an omission.
 */
function featuresFor(plan: PlanTier): string[] {
  const lines: string[] = [];

  lines.push(
    plan.maxResidents === null
      ? "Unlimited residents"
      : `Up to ${plan.maxResidents} residents`,
  );

  const { cooks, wardens } = plan.portalAccess;

  lines.push(
    wardens === null ? "Unlimited warden accounts" : `${wardens} warden ${wardens === 1 ? "account" : "accounts"}`,
  );
  lines.push(
    cooks === null ? "Unlimited cook accounts" : `${cooks} cook ${cooks === 1 ? "account" : "accounts"}`,
  );

  if (plan.listingTier) {
    lines.push(`${plan.listingTier.label} badge in the public directory`);
  }

  return lines;
}

export interface PresentationInput {
  /** Overrides the "12 months" line — the lifetime deal says "Lifetime". */
  billingPeriod?: string;
  /** `Annual`, `6 months` — the catalogue's own label for the cycle. */
  cycleLabel: string;
  cycleMonths: number;
  /** The catalogue entry, or null when the plan has since been deleted. */
  plan: PlanTier | null;
  /** The name snapshotted on the subscription, which outlives the catalogue. */
  planName: string;
}

/**
 * Builds the block, or returns `undefined` to send none.
 *
 * `undefined` rather than an empty object: omitted entirely, nothing renders
 * and Softmato invents no plan name on our behalf. An object carrying only a
 * `plan_name` that failed its own checks would be worse than silence.
 */
export function buildPresentation(
  input: PresentationInput,
): Presentation | undefined {
  const planName = fit(
    `${input.planName} — ${input.cycleLabel}`,
    LIMITS.planName,
  );

  if (!planName) return undefined;

  const features = (input.plan ? featuresFor(input.plan) : [])
    .map((line) => fit(line, LIMITS.feature))
    .filter((line): line is string => line !== null)
    .slice(0, LIMITS.features);

  const highlights = (
    input.plan?.listingTier?.note ? [input.plan.listingTier.note] : []
  )
    .map((line) => fit(line, LIMITS.highlight))
    .filter((line): line is string => line !== null)
    .slice(0, LIMITS.highlights);

  const tagline = fit(input.plan?.description, LIMITS.tagline);
  const billingPeriod = fit(
    input.billingPeriod ??
      `${input.cycleMonths} ${input.cycleMonths === 1 ? "month" : "months"}`,
    LIMITS.billingPeriod,
  );

  return {
    plan_name: planName,
    ...(tagline ? { tagline } : {}),
    ...(features.length > 0 ? { features } : {}),
    ...(highlights.length > 0 ? { highlights } : {}),
    ...(billingPeriod ? { billing_period: billingPeriod } : {}),
  };
}
