import { portalAccessLines as sharedPortalAccessLines } from "@hostel/shared/plans/catalog";
import { serviceHref } from "@hostel/shared/plans/catalog";

import type {
  PlanListingTier,
  PlanModule,
  PlanService,
  PlanTier,
  PlansConfig,
} from "@/lib/platform-config/site-config.validation";

/**
 * Reading the plans-and-pricing catalogue, on the website.
 *
 * Neither the data nor the arithmetic lives here any more. The catalogue is the
 * `plans` section of the site config — authored in Platform → Website Config →
 * Plans & Pricing, shipped as `plans.defaults.ts` — and the functions that read
 * it are `@hostel/shared/plans/catalog`, so the app computes the same prices
 * from the same rules. This file is the seam between the two: it re-exports
 * that arithmetic under the names this app already used, and it names the types
 * from the zod schema rather than the structural ones, so a change to the
 * schema is a type error here rather than a surprise at runtime.
 *
 * Every function takes the catalogue as an argument rather than closing over a
 * constant, because two surfaces render it: the public page against the saved
 * config, and the admin editor against an unsaved draft.
 */

export {
  bestDiscountPercent,
  bestEventPercent,
  bestSaving,
  billingCycles,
  cardServicesForPlan,
  cycleMonths,
  cycleTotal,
  discountPercent,
  eventRuns,
  formatPlanRate,
  getListingTier,
  getPlan,
  getService,
  getServiceModule,
  listingTierHref,
  listingTiers,
  listMonthly,
  monthlyRateFor,
  newServicesForPlan,
  orphanedServices,
  planBelow,
  planIncludes,
  planRank,
  residentRangeLabel,
  savingFor,
  serviceHref,
  sellingCatalog,
  sellingPlan,
  servicesByModule,
  type BillingCycle,
} from "@hostel/shared/plans/catalog";

export type {
  PlanListingTier,
  PlanModule,
  PlanService,
  PlanTier,
  PlansConfig,
} from "@/lib/platform-config/site-config.validation";

/**
 * Names kept from before the move, so call sites read the same as they always
 * did. A plan id and a module id are ordinary strings now that an owner can add
 * their own — nothing may assume the shipped three or nine.
 */
export type Plan = PlanTier;
export type Service = PlanService;
export type ServiceModule = PlanModule;
export type PlanId = string;
export type ServiceModuleId = string;
export type ListingTierTone = PlanListingTier["tone"];

/**
 * The seat lines, with the shared slug turned into this app's URL.
 *
 * The shared version returns a slug (or `null` when the service it names has
 * been removed) rather than a path, because the app routes to a screen and the
 * website to `/plans-pricing/<slug>` — a shared function that returned a web
 * URL would be one the phone had to parse back apart.
 */
export function portalAccessLines(catalog: PlansConfig, plan: PlanTier) {
  return sharedPortalAccessLines(catalog, plan).map((line) => ({
    href: line.slug ? serviceHref(line.slug) : null,
    id: line.id,
    label: line.label,
  }));
}
