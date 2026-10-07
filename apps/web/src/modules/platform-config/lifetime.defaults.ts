import type { LifetimeConfig } from "./site-config.validation";

/**
 * The launch lifetime deal: the first 50 hostels, split 18 / 16 / 16 across
 * Go, Pro and Max, for one month from the day it opened. Every figure here is
 * edited in Platform → Website Config → Plans & Pricing → Lifetime; this is
 * only what a fresh database shows before anyone has saved that tab.
 */
export const DEFAULT_LIFETIME: LifetimeConfig = {
  badge: "Founding 50 · Lifetime",
  ctaLabel: "Claim lifetime",
  enabled: true,
  endsOn: "2026-11-07",
  note: "One payment, no renewals. A lifetime plan starts the day it is paid — it does not come with free months, and event offers and referral time do not apply to it. Prices are per hostel and exclude applicable taxes.",
  offers: [
    { planId: "go", price: 9_999, seats: 18 },
    { planId: "pro", price: 16_999, seats: 16 },
    { planId: "max", price: 24_999, seats: 16 },
  ],
  startsOn: "2026-10-07",
  subtitle:
    "For the first 50 hostels only. Pay once and keep every feature of the plan you pick for as long as {siteName} runs — no monthly bills, no recharges.",
  title: "Pay once. Use it for life.",
};
